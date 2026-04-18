// Bot manager. Owns everything that *manages* the bots: tmux ops, `/context`
// query + cache, watchdog, sleep + daily-restart scheduler, monitor. Runs the
// same whether or not a Supervisor remote-control bot is configured — the
// Telegram layer in index.mjs is just a thin surface over these primitives.
//
// Communication out: the `onEvent(text)` callback the factory receives. In
// headless mode it's a no-op; with a Supervisor bot, index.mjs wires it to
// `pushToUsers`. All *internal* diagnostic lines go straight to console.log
// so pm2 logs remain the source of truth independent of Telegram.

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Shared tiny helpers (inlined; not worth their own module) ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf-8', timeout: 10_000 }).trim();
}

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '');
}

function parseHHMM(s) {
  const m = (s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1]);
  const mm = parseInt(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, mm };
}

function sameLocalDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function parseTokenCount(val, suffix) {
  const n = parseFloat(val);
  const s = (suffix || '').toLowerCase();
  if (s === 'k') return Math.round(n * 1000);
  if (s === 'm') return Math.round(n * 1_000_000);
  return Math.round(n);
}

// Claude Code's convention: working dir with every non-alphanumeric char
// replaced by '-'. /workspace/foo/bar → -workspace-foo-bar
function projectsDirFor(workDir) {
  const slug = workDir.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

function isClaudeCmd(cmd) {
  return /(?:^|\/)claude(?:$|\s|\0)/.test(cmd);
}

// Grace window after a deliberate restart: watchdog skips the bot so the
// in-flight boot doesn't get mistaken for a crash.
const RESTART_GRACE_SECONDS = 30;

export function createBotManager({ bots, config, onEvent = () => {} }) {
  const BOTS = bots;
  const {
    START_CMD,
    WATCHDOG_INTERVAL,
    MAX_CONSECUTIVE_RESTARTS,
    CONTEXT_CHECK_INTERVAL,
    CONTEXT_THRESHOLD,
    CONTEXT_CACHE_SECONDS,
    CONTEXT_QUERY_WAIT_MS,
    MONITOR_INTERVAL,
    MONITOR_CAPTURE_LINES,
    SLEEP_AT,
    SLEEP_COMMAND,
    DAILY_RESTART_AT,
    RESTART_AFTER_SLEEP_MIN_HOURS,
    SLEEP_DONE_MAX_AGE_HOURS,
    SLEEP_TRIGGER_PATTERN,
    MAX_UPTIME_HOURS,
  } = config;

  // --- Per-bot state maps (all keyed by bot.name) ---
  const restartState = new Map(); // { failures, abandoned }
  const lastRestartAt = new Map();
  const contextCache = new Map(); // { pct, tokens, limit, model, at }
  const lastCaptures = new Map();
  const monitors = new Map(); // { intervalId, seconds }
  // Bots the user explicitly /stop'd. Watchdog and scheduler both respect
  // this — without it, auto-restart would immediately undo a manual stop.
  // Cleared on /start, /restart, and any successful startProcess() issued
  // through the bot manager (schedulers only issue startProcess, never
  // mark-stop, so the flag is sticky across scheduled ticks).
  const stoppedByUser = new Set();
  // Fire-once-per-day state for both schedules. Uses the local date as the
  // dedupe key so a supervisor restart mid-day doesn't re-fire events that
  // already happened — except when there's no transcript evidence, in which
  // case the restart's own sleep-confirmation check handles it.
  const lastSleepFiredDate = new Map(); // botName → "YYYY-MM-DD"
  const lastRestartFiredDate = new Map();

  const DEFAULT_MONITOR_SECONDS = MONITOR_INTERVAL > 0 ? MONITOR_INTERVAL : 30;

  // --- tmux ops ---
  function sessionExists(bot) {
    try {
      sh(`tmux has-session -t ${bot.session} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  function getPanePid(bot) {
    try {
      return parseInt(
        sh(`tmux display-message -t ${bot.target} -p '#{pane_pid}'`)
      );
    } catch {
      return null;
    }
  }

  // Linux exposes /proc/<pid>/cmdline; macOS does not. Try the platform-native
  // path first, fall back to `ps` the other way. Returned string may be a bare
  // name (`claude ...`) or path-prefixed (`/usr/local/bin/claude ...`) depending
  // on how the process was launched — downstream matchers must handle both.
  function getProcCmd(pid) {
    const tryProc = () => {
      try {
        const cmd = sh(`cat /proc/${pid}/cmdline 2>/dev/null`);
        if (cmd) return cmd;
      } catch {
        /* not available */
      }
      return null;
    };
    const tryPs = () => {
      try {
        const cmd = sh(`ps -p ${pid} -o command= 2>/dev/null`).trim();
        if (cmd) return cmd;
      } catch {
        /* no such pid */
      }
      return null;
    };
    if (process.platform === 'linux') {
      return tryProc() ?? tryPs() ?? '';
    }
    return tryPs() ?? tryProc() ?? '';
  }

  function getClaudePid(bot) {
    const panePid = getPanePid(bot);
    if (!panePid) return null;
    try {
      const children = sh(`pgrep -P ${panePid}`)
        .split('\n')
        .filter(Boolean)
        .map(Number);
      for (const pid of children) {
        try {
          if (isClaudeCmd(getProcCmd(pid))) return pid;
          const grandchildren = sh(`pgrep -P ${pid}`)
            .split('\n')
            .filter(Boolean)
            .map(Number);
          for (const gc of grandchildren) {
            if (isClaudeCmd(getProcCmd(gc))) return gc;
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* no children */
    }
    return null;
  }

  function isRunning(bot) {
    return getClaudePid(bot) !== null;
  }

  // Read a process's env block from /proc (Linux only). Returns an object of
  // env key → value, or null if /proc isn't readable (other platforms, or the
  // process already gone).
  function readProcEnv(pid) {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
      const out = {};
      for (const kv of raw.split('\0')) {
        if (!kv) continue;
        const i = kv.indexOf('=');
        if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return out;
    } catch {
      return null;
    }
  }

  // Find all Telegram plugin servers belonging to this bot. Two sources:
  //   1. `<bot-dir>/.telegram/bot.pid` — the plugin's own "current primary"
  //      pointer (overwritten on each new-server launch, so it only knows
  //      the latest one).
  //   2. /proc/*/environ scan for TELEGRAM_STATE_DIR matching this bot.
  //      Catches orphans from earlier sessions that bot.pid has forgotten.
  // The two together are complementary — bot.pid is precise, the env scan
  // is exhaustive (but Linux-only).
  function findTelegramPluginPids(bot) {
    const targetDir = path.join(bot.workDir, '.telegram');
    const pids = new Set();
    try {
      const pidFile = path.join(targetDir, 'bot.pid');
      if (fs.existsSync(pidFile)) {
        const p = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
        if (Number.isFinite(p)) pids.add(p);
      }
    } catch {
      /* ignore */
    }
    try {
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = parseInt(entry);
        const env = readProcEnv(pid);
        if (env && env.TELEGRAM_STATE_DIR === targetDir) pids.add(pid);
      }
    } catch {
      /* /proc not available (macOS) — bot.pid still works */
    }
    return [...pids];
  }

  // Kill the Telegram plugin server(s) for this bot. The plugin detaches
  // from claude's signal chain (bun daemon with its own pid file), so
  // `tmux kill-session` alone does NOT reach it — it becomes an orphan
  // (ppid=1) that keeps polling getUpdates with the bot token. Telegram
  // only honors ONE polling connection per token, so orphans + new server
  // rotate randomly, silently dropping user messages. Always run this
  // before tearing down the tmux session.
  async function killTelegramPluginServers(bot) {
    const pids = findTelegramPluginPids(bot);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    await sleep(500);
    for (const pid of pids) {
      try {
        process.kill(pid, 0); // probe: throws if dead
        try {
          process.kill(pid, 'SIGKILL');
          console.log(
            `[killProcess] ${bot.name}: SIGKILLed plugin server pid ${pid} (ignored SIGTERM)`
          );
        } catch {
          /* raced to exit */
        }
      } catch {
        /* already gone — SIGTERM worked */
      }
    }
  }

  // Nuke the whole tmux session rather than SIGTERM individual children.
  // Why: claude-code's TUI occasionally drops out of raw mode (stdin ends up in
  // cooked+echo, keystrokes pile up as literal `^M` below the TUI, slash
  // commands stop working), and the only reliable recovery is a brand-new pty.
  // Killing the session + recreating on launch gives every restart a fresh pty
  // and clears any accumulated termios state.
  //
  // Before the tmux kill, reap Telegram plugin orphans — see
  // `killTelegramPluginServers` for the why.
  async function killProcess(bot) {
    await killTelegramPluginServers(bot);
    if (!sessionExists(bot)) return false;
    try {
      sh(`tmux kill-session -t ${bot.session}`);
      return true;
    } catch {
      return false;
    }
  }

  // Always fresh pty: kill any existing session, then create a new one with
  // start.sh as the initial command. Avoids send-keys racing a live TUI and
  // sidesteps claude-code's occasional raw-mode loss (see killProcess).
  //
  // start.sh itself ends with `exec bash -l`, so when claude exits (crash,
  // /exit, Ctrl-C×2) the pane drops into a live, interactive shell instead
  // of dying and cascading the whole tmux server down. Consequences:
  //   * An attached user stays attached and gets a usable pane (can poke
  //     around, tail logs) while watchdog works on the restart.
  //   * Watchdog sees sessionExists=true + isRunning=false and takes the
  //     clean "died, restarting" path, not "session gone".
  //   * When the supervisor kill-session runs to restart, the bash drops
  //     on SIGHUP and the new pane cleanup path stays unchanged.
  //   * A user who launches ./start.sh manually under their own tmux gets
  //     the same behavior — one code path, no divergence.
  async function startProcess(bot) {
    try {
      await killProcess(bot);
      sh(
        `tmux new-session -d -s ${bot.session} -c ${bot.workDir} '${START_CMD}'`
      );
      // Wait for the TUI to be actually listening for input, not just for the
      // process to exist. Sending "start" before the Telegram channel handshake
      // has finished (when `isRunning=true` but TUI is still booting) drops the
      // keystrokes on the floor and claude never runs its kickoff routine.
      // "Listening for channel messages" is printed once the TUI is live.
      const READY_MARKER = /Listening for channel messages/;
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const pane = capturePane(bot, 30);
        if (pane && READY_MARKER.test(pane)) break;
      }
      execFileSync('tmux', ['send-keys', '-t', bot.target, '-l', 'start'], {
        timeout: 10_000,
      });
      execFileSync('tmux', ['send-keys', '-t', bot.target, 'Enter'], {
        timeout: 10_000,
      });
    } catch (err) {
      console.error(`[startProcess] ${bot.name}: ${err.message}`);
    }
  }

  function capturePane(bot, lines = 50) {
    try {
      return stripAnsi(
        sh(`tmux capture-pane -t ${bot.target} -p -S -${lines}`)
      );
    } catch {
      return null;
    }
  }

  // Line-level diff: return lines present in `current` that weren't in `prev`.
  // Prefix/substring matching breaks because the TUI's bottom chrome (input box,
  // status line with live time) mutates slightly between captures and middle
  // content grows in-place — there's no single stable anchor. Set-diff on lines
  // filters stable chrome and reports only additions, in original order.
  function extractNewContent(prev, current) {
    if (!prev || !current) return null;
    if (prev === current) return null;
    const prevSet = new Set(prev.split('\n').map((l) => l.trimEnd()));
    const additions = [];
    for (const raw of current.split('\n')) {
      const line = raw.trimEnd();
      if (!line) continue;
      if (prevSet.has(line)) continue;
      additions.push(line);
    }
    if (additions.length === 0) return null;
    return additions.join('\n');
  }

  function sendKeys(bot, text) {
    execFileSync('tmux', ['send-keys', '-t', bot.target, '-l', text], {
      timeout: 10_000,
    });
    execFileSync('tmux', ['send-keys', '-t', bot.target, 'Enter'], {
      timeout: 10_000,
    });
  }

  // --- Restart-attempt state ---
  // After MAX_CONSECUTIVE_RESTARTS failures in a row the watchdog stops auto-
  // restarting and asks the user to investigate. Manual /start or /restart
  // clears the state.
  function getRestartState(name) {
    let s = restartState.get(name);
    if (!s) {
      s = { failures: 0, abandoned: false };
      restartState.set(name, s);
    }
    return s;
  }

  function resetRestartState(name) {
    const s = getRestartState(name);
    s.failures = 0;
    s.abandoned = false;
  }

  function markRestart(name) {
    lastRestartAt.set(name, Date.now());
  }

  function inRestartGrace(name) {
    const t = lastRestartAt.get(name);
    return t && Date.now() - t < RESTART_GRACE_SECONDS * 1000;
  }

  // --- Context usage ---
  // We inject `/context` into the bot's TUI and parse Claude Code's own
  // breakdown (e.g. `39.3k/1m tokens (4%)`). This is authoritative — Claude
  // reports the true model-specific limit, which the session JSONL's `model`
  // field strips (e.g. `claude-opus-4-7[1m]` is logged as `claude-opus-4-7`),
  // so any JSONL-based computation has no way to tell 200K apart from 1M.
  //
  // Side effect: each query adds a `/context` line to the bot's TUI history.
  // We cache results for CONTEXT_CACHE_SECONDS to avoid spamming the pane on
  // every /status call.
  async function queryContext(bot) {
    try {
      execFileSync('tmux', ['send-keys', '-t', bot.target, '-l', '/context'], {
        timeout: 10_000,
      });
      execFileSync('tmux', ['send-keys', '-t', bot.target, 'Enter'], {
        timeout: 10_000,
      });
    } catch {
      return null;
    }
    // Poll for the tokens line instead of a fixed sleep. Claude's /context
    // render takes anywhere from ~500ms (idle TUI) to several seconds (TUI
    // busy rendering heartbeat / long replies). A fixed sleep was silently
    // missing the line when the render slipped past its deadline — users saw
    // "context: query failed" spuriously on first /status after a supervisor
    // restart (cold cache forced a live query).
    const tokensRe =
      /(\d+(?:\.\d+)?)([kmKM]?)\s*\/\s*(\d+(?:\.\d+)?)([kmKM]?)\s+tokens\s*\((\d+(?:\.\d+)?)%\)/;
    const modelRe =
      // Scoped to known Claude model families so we don't accidentally match
      // unrelated `claude-*` strings that appear in the pane (e.g. plugin
      // names like `claude-plugins-official`). Update when new families ship.
      /claude-(?:opus|sonnet|haiku)-[\d][\w.-]*(?:\[[0-9a-z]+\])?/i;
    await sleep(500); // small settle so send-keys echo lands first
    const deadline = Date.now() + CONTEXT_QUERY_WAIT_MS;
    let pane = null;
    let m = null;
    while (Date.now() < deadline) {
      pane = capturePane(bot, MONITOR_CAPTURE_LINES);
      if (pane) {
        m = pane.match(tokensRe);
        if (m) break;
      }
      await sleep(500);
    }
    if (!m) return null;
    const tokens = parseTokenCount(m[1], m[2]);
    const limit = parseTokenCount(m[3], m[4]);
    const pct = parseFloat(m[5]);
    const modelMatch = pane.match(modelRe);
    return {
      tokens,
      limit,
      pct,
      model: modelMatch ? modelMatch[0] : null,
      at: Date.now(),
    };
  }

  async function getContextUsage(bot, { force = false } = {}) {
    if (!force) {
      const cached = contextCache.get(bot.name);
      if (cached && Date.now() - cached.at < CONTEXT_CACHE_SECONDS * 1000) {
        return cached;
      }
    }
    const result = await queryContext(bot);
    if (!result) return contextCache.get(bot.name) || null;
    contextCache.set(bot.name, result);
    return result;
  }

  function invalidateContextCache(botName) {
    contextCache.delete(botName);
  }

  // --- Sleep + daily-restart scheduler (sleep-aware) ---
  // Scans Claude Code's own session transcripts at `~/.claude/projects/<slug>/`
  // for a recent user message containing SLEEP_TRIGGER_PATTERN. If found, the
  // bot's sleep cron fired and reached claude, so a fresh restart is safe.
  // If not found, we skip the restart and alert the user — likely the bot was
  // down during sleep window and forcing a restart would wipe context the bot
  // never had a chance to consolidate.
  function sleepTriggeredRecently(bot) {
    const dir = projectsDirFor(bot.workDir);
    const cutoffMs = Date.now() - SLEEP_DONE_MAX_AGE_HOURS * 3600_000;
    let entries;
    try {
      entries = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          try {
            return {
              file: path.join(dir, f),
              mtime: fs.statSync(path.join(dir, f)).mtimeMs,
            };
          } catch {
            return null;
          }
        })
        .filter((e) => e && e.mtime >= cutoffMs)
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return { ok: false, reason: `transcripts dir missing (${dir})` };
    }
    for (const { file } of entries) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        // Match genuine user prompts only, not tool_result-wrapped user lines:
        //   real cron prompt:  "content":"读取 ... SLEEP.md ..."
        //   tool_result wrap:  "content":[{"tool_use_id":...}]
        // The tool_result shape happens to also contain the cron's prompt text
        // when a subagent registered the cron, which would cause false hits.
        const userContentMatch = line.match(
          /"role":"user","content":"([^"]*)"/
        );
        if (!userContentMatch) continue;
        if (!userContentMatch[1].includes(SLEEP_TRIGGER_PATTERN)) continue;
        const m = line.match(/"timestamp":"([^"]+)"/);
        if (!m) continue;
        const ts = new Date(m[1]).getTime();
        if (Number.isFinite(ts) && ts >= cutoffMs) {
          return { ok: true, at: new Date(ts) };
        }
      }
    }
    return { ok: false, reason: 'no recent SLEEP.md trigger in transcripts' };
  }

  function claudeUptimeSeconds(bot) {
    const pid = getClaudePid(bot);
    if (!pid) return null;
    try {
      const n = parseInt(sh(`ps -o etimes= -p ${pid}`));
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  function fireSleep(bot) {
    if (!isRunning(bot)) {
      console.log(`[sleep] ${bot.name}: claude not running, skipping`);
      return false;
    }
    try {
      execFileSync(
        'tmux',
        ['send-keys', '-t', bot.target, '-l', SLEEP_COMMAND],
        { timeout: 10_000 }
      );
      execFileSync('tmux', ['send-keys', '-t', bot.target, 'Enter'], {
        timeout: 10_000,
      });
      console.log(`[sleep] ${bot.name}: fired`);
      onEvent(`${bot.name} sleep triggered`);
      return true;
    } catch (err) {
      console.error(`[sleep] ${bot.name}: send failed: ${err.message}`);
      return false;
    }
  }

  // --- Monitor: push new tmux pane output on an interval ---
  // Activated per-bot via startMonitor; not auto-started.
  function monitorTick(bot) {
    if (!isRunning(bot)) return;
    const current = capturePane(bot, MONITOR_CAPTURE_LINES);
    if (!current) return;
    const prev = lastCaptures.get(bot.name);
    lastCaptures.set(bot.name, current);
    const diff = extractNewContent(prev, current);
    if (!diff) return;
    const body = diff.length > 3500 ? '...' + diff.slice(-3500) : diff;
    const prefix = BOTS.length > 1 ? `[${bot.name}]\n` : '';
    onEvent(prefix + body);
  }

  function startMonitor(bot, seconds) {
    stopMonitor(bot);
    // Seed baseline so the first tick doesn't dump the whole screen as "new".
    const initial = capturePane(bot, MONITOR_CAPTURE_LINES);
    if (initial) lastCaptures.set(bot.name, initial);
    const intervalId = setInterval(
      () => monitorTick(bot),
      seconds * 1000
    );
    monitors.set(bot.name, { intervalId, seconds });
  }

  function stopMonitor(bot) {
    const entry = monitors.get(bot.name);
    if (!entry) return false;
    clearInterval(entry.intervalId);
    monitors.delete(bot.name);
    lastCaptures.delete(bot.name);
    return true;
  }

  function listMonitors() {
    return [...monitors.entries()].map(([name, { seconds }]) => ({
      name,
      seconds,
    }));
  }

  // --- Watchdog ---
  function watchdogTick() {
    for (const bot of BOTS) {
      if (inRestartGrace(bot.name)) continue;
      // User-stopped bots are left alone. This is the ONLY reason watchdog
      // now skips a bot with a missing session — previously the code relied
      // on `!sessionExists` as the "user-stopped" signal, but a crashed
      // claude cascades the whole tmux session dead (start.sh exits → pty
      // closes → last session → server exits), and that tripped the same
      // branch, making the watchdog silently inert after any real crash.
      if (stoppedByUser.has(bot.name)) continue;

      const state = getRestartState(bot.name);
      const sessionUp = sessionExists(bot);
      const claudeUp = sessionUp && isRunning(bot);

      if (claudeUp) {
        // Self-heal: if claude came back (manual restart, delayed boot, etc.)
        // clear the abandoned lock too — otherwise the next crash won't
        // trigger auto-restart and the user has to /start manually.
        if (state.failures > 0 || state.abandoned) {
          state.failures = 0;
          state.abandoned = false;
        }
        continue;
      }

      if (state.abandoned) continue;

      if (state.failures >= MAX_CONSECUTIVE_RESTARTS) {
        state.abandoned = true;
        console.log(
          `[watchdog] ${bot.name} dead after ${MAX_CONSECUTIVE_RESTARTS} attempts — giving up`
        );
        onEvent(
          `⚠️ ${bot.name} crashed ${MAX_CONSECUTIVE_RESTARTS} times in a row. Auto-restart disabled. Investigate, then /start ${bot.name} to re-enable.`
        );
        continue;
      }

      state.failures += 1;
      const deathMode = sessionUp ? 'died' : 'session gone';
      console.log(
        `[watchdog] ${bot.name} ${deathMode}, restarting (${state.failures}/${MAX_CONSECUTIVE_RESTARTS})`
      );
      startProcess(bot);
      markRestart(bot.name);
      invalidateContextCache(bot.name);
      onEvent(
        `${bot.name} crashed — auto-restarted (${state.failures}/${MAX_CONSECUTIVE_RESTARTS})`
      );
    }
  }

  // --- Context-check tick (daily by default) ---
  async function contextCheckTick() {
    for (const bot of BOTS) {
      if (inRestartGrace(bot.name)) continue;
      if (!isRunning(bot)) continue;
      const usage = await getContextUsage(bot, { force: true });
      if (!usage) {
        console.log(`[context] ${bot.name}: query failed, skipping`);
        continue;
      }
      console.log(
        `[context] ${bot.name}: ${usage.pct}% used (${usage.tokens}/${usage.limit})`
      );
      if (usage.pct > CONTEXT_THRESHOLD) {
        onEvent(
          `${bot.name} context at ${usage.pct}% — restarting for fresh session`
        );
        markRestart(bot.name);
        invalidateContextCache(bot.name);
        resetRestartState(bot.name);
        await startProcess(bot);
      }
    }
  }

  const sleepTarget = SLEEP_AT ? parseHHMM(SLEEP_AT) : null;
  if (SLEEP_AT && !sleepTarget) {
    console.error(`SLEEP_AT invalid: ${SLEEP_AT} (expected HH:MM)`);
  }
  const dailyTarget = DAILY_RESTART_AT ? parseHHMM(DAILY_RESTART_AT) : null;
  if (DAILY_RESTART_AT && !dailyTarget) {
    console.error(
      `DAILY_RESTART_AT invalid: ${DAILY_RESTART_AT} (expected HH:MM)`
    );
  }

  async function schedulerTick() {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const minutesNow = now.getHours() * 60 + now.getMinutes();

    for (const bot of BOTS) {
      if (inRestartGrace(bot.name)) continue;
      // Respect user /stop — don't let sleep/daily-restart resurrect a
      // deliberately-stopped bot (scheduler would otherwise call
      // startProcess through the 'daily' trigger branch).
      if (stoppedByUser.has(bot.name)) continue;

      // --- Sleep trigger (catch-up: fire any time past SLEEP_AT today) ---
      // Track whether we fired sleep in THIS tick so the restart block below
      // can distinguish "transcript has no sleep entry because bot never
      // slept today" (legitimate skip) from "transcript lags our send-keys
      // by a tick" (must not mark restart done — retry next tick). See
      // Case B in docs: boot ≥ DAILY_RESTART_AT after host was off.
      let firedSleepThisTick = false;
      if (
        sleepTarget &&
        lastSleepFiredDate.get(bot.name) !== todayStr &&
        minutesNow >= sleepTarget.h * 60 + sleepTarget.mm
      ) {
        // Transcript check first: if claude already has a SLEEP.md user
        // message from today (e.g., supervisor restarted and lost memory),
        // don't re-fire.
        const recent = sleepTriggeredRecently(bot);
        const alreadyToday = recent.ok && sameLocalDate(recent.at, now);
        if (alreadyToday) {
          console.log(
            `[sleep] ${bot.name}: already fired today per transcript (at ${recent.at.toISOString()}), skipping catch-up`
          );
        } else {
          const ctx = recent.ok
            ? `transcript stale (latest SLEEP.md at ${recent.at.toISOString()})`
            : recent.reason;
          console.log(
            `[sleep] ${bot.name}: catch-up fire (minutesNow=${minutesNow}, target=${sleepTarget.h * 60 + sleepTarget.mm}; ${ctx})`
          );
          firedSleepThisTick = fireSleep(bot);
        }
        lastSleepFiredDate.set(bot.name, todayStr);
      }

      // --- Restart: scheduled daily (sleep-confirmed, ≥1h old) or uptime. ---
      let trigger = null;
      let reason = '';

      if (
        dailyTarget &&
        lastRestartFiredDate.get(bot.name) !== todayStr &&
        minutesNow >= dailyTarget.h * 60 + dailyTarget.mm
      ) {
        const check = sleepTriggeredRecently(bot);
        if (!check.ok) {
          if (firedSleepThisTick) {
            // Case B: sleep was just sent via tmux send-keys this tick, but
            // claude hasn't echoed it into the jsonl transcript yet. Do NOT
            // mark today's restart done — let the next tick see the entry
            // and fall through to the "sleep too fresh" branch below, which
            // keeps re-checking until the entry is ≥1h old.
            console.log(
              `[daily-restart] ${bot.name}: holding — sleep fired this tick (${check.reason}); transcript lag expected, will retry next tick`
            );
          } else {
            const msg = `${bot.name} daily restart skipped — ${check.reason}`;
            console.log(`[daily-restart] ${msg}`);
            onEvent(msg);
            lastRestartFiredDate.set(bot.name, todayStr);
          }
        } else {
          const sleepAgeMs = Date.now() - check.at.getTime();
          const minAgeMs = RESTART_AFTER_SLEEP_MIN_HOURS * 3600_000;
          if (sleepAgeMs >= minAgeMs) {
            // Freshness check: if the running claude was started AFTER the
            // sleep trigger, today's "restart after sleep" has already been
            // satisfied by something (watchdog, manual /restart, previous
            // supervisor's daily-restart that got forgotten across a
            // supervisor pm2 restart). Skip — claude is already fresh.
            // Invariant we preserve: "claude's process is newer than the
            // latest sleep trigger by daily-restart time." Whether *this*
            // supervisor process did the restart is irrelevant.
            const uptimeS = claudeUptimeSeconds(bot);
            const claudeStartMs =
              uptimeS !== null ? Date.now() - uptimeS * 1000 : null;
            if (
              claudeStartMs !== null &&
              claudeStartMs > check.at.getTime()
            ) {
              console.log(
                `[daily-restart] ${bot.name}: already satisfied — claude started ${new Date(claudeStartMs).toISOString()} (uptime ${(uptimeS / 60).toFixed(1)}m) is newer than sleep at ${check.at.toISOString()}; marking today done`
              );
              lastRestartFiredDate.set(bot.name, todayStr);
            } else {
              trigger = 'daily';
              reason = `sleep confirmed at ${check.at.toISOString()} (age ${(sleepAgeMs / 3600_000).toFixed(2)}h)`;
              lastRestartFiredDate.set(bot.name, todayStr);
            }
          } else {
            // Sleep still too fresh — wait for the next tick. Logged so
            // post-mortems can see the scheduler is actively waiting rather
            // than stuck.
            console.log(
              `[daily-restart] ${bot.name}: holding — sleep at ${check.at.toISOString()} is ${(sleepAgeMs / 60_000).toFixed(1)}m old, need ≥${(minAgeMs / 60_000).toFixed(0)}m`
            );
          }
        }
      }

      if (!trigger && MAX_UPTIME_HOURS > 0) {
        const uptime = claudeUptimeSeconds(bot);
        if (uptime !== null && uptime > MAX_UPTIME_HOURS * 3600) {
          trigger = 'uptime';
          reason = `uptime ${(uptime / 3600).toFixed(1)}h > ${MAX_UPTIME_HOURS}h`;
        }
      }

      if (trigger) {
        const msg = `${bot.name} restart [${trigger}] — ${reason}`;
        console.log(`[${trigger}-restart] ${msg}`);
        onEvent(msg);
        markRestart(bot.name);
        invalidateContextCache(bot.name);
        resetRestartState(bot.name);
        await startProcess(bot);
      }
    }
  }

  // --- Start intervals ---
  if (WATCHDOG_INTERVAL > 0) {
    setInterval(watchdogTick, WATCHDOG_INTERVAL * 1000);
    console.log(
      `Watchdog enabled, interval: ${WATCHDOG_INTERVAL}s, max restarts: ${MAX_CONSECUTIVE_RESTARTS}`
    );
  }

  if (CONTEXT_CHECK_INTERVAL > 0) {
    setInterval(contextCheckTick, CONTEXT_CHECK_INTERVAL * 1000);
    console.log(
      `Context check enabled, interval: ${CONTEXT_CHECK_INTERVAL}s, threshold: >${CONTEXT_THRESHOLD}%`
    );
  }

  if (sleepTarget || dailyTarget || MAX_UPTIME_HOURS > 0) {
    setInterval(schedulerTick, 60_000);
    const parts = [];
    if (sleepTarget) parts.push(`sleep at ${SLEEP_AT} local`);
    if (dailyTarget)
      parts.push(
        `restart at ${DAILY_RESTART_AT} local (sleep ≥${RESTART_AFTER_SLEEP_MIN_HOURS}h old, window: ${SLEEP_DONE_MAX_AGE_HOURS}h)`
      );
    if (MAX_UPTIME_HOURS > 0) parts.push(`uptime cap: ${MAX_UPTIME_HOURS}h`);
    console.log(`Scheduler: ${parts.join('; ')}`);
  }

  return {
    // introspection (synchronous)
    sessionExists,
    isRunning,
    getClaudePid,
    getRestartState,
    capturePane,
    extractNewContent,
    listMonitors,
    // introspection (async)
    getContextUsage,
    // actions
    startProcess,
    killProcess,
    sendKeys,
    markRestart,
    resetRestartState,
    invalidateContextCache,
    startMonitor,
    stopMonitor,
    // user-stop flag (controls whether watchdog / scheduler touch the bot)
    markStopped: (name) => stoppedByUser.add(name),
    unmarkStopped: (name) => stoppedByUser.delete(name),
    // for /monitor defaults
    DEFAULT_MONITOR_SECONDS,
  };
}
