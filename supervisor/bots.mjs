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
  // Fire-once-per-day dedupe for the daily-restart branch. Sleep dedupe is
  // disk-backed (see sleepLogPath / readSleepLog) so it survives supervisor
  // restarts; daily-restart only needs in-memory state because the freshness
  // check against claude's own uptime re-derives "already restarted today"
  // after a supervisor bounce.
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
  //   2. /proc/*/environ scan for TELEGRAM_STATE_DIR matching this bot,
  //      THEN filtered by cmdline to bun plugin processes only. Catches
  //      orphans from earlier sessions that bot.pid has forgotten.
  //
  // The cmdline filter is load-bearing: start.sh exports TELEGRAM_STATE_DIR
  // before exec'ing claude, so every descendant (claude itself, any shell,
  // all subagents) shows the variable in /proc/<pid>/environ. An unfiltered
  // scan returns claude + bash + bun — SIGKILLing that set during a
  // plugin-only restart tore the whole bot session down.
  function isPluginCmd(cmdline) {
    if (!cmdline) return false;
    // cmdline comes in with \0 separators from /proc, or spaces from ps.
    // Normalize so a simple substring check works either way.
    const s = cmdline.replace(/\0/g, ' ');
    // Must be invoked by `bun` (path or bare) — rules out claude / bash.
    if (!/(^|[/\s])bun(\s|$)/.test(s)) return false;
    // Must reference the telegram plugin path or the server entrypoint —
    // rules out unrelated bun processes sharing the env by accident.
    return s.includes('claude-plugins-official/telegram') || s.includes('server.ts');
  }

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
        if (!env || env.TELEGRAM_STATE_DIR !== targetDir) continue;
        if (!isPluginCmd(getProcCmd(pid))) continue;
        pids.add(pid);
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
  //
  // Two races that broke the simpler previous version (SIGTERM → 500ms →
  // SIGKILL, single pass, no wait-for-exit):
  //   1. Killing `bun run` (wrapper) before `bun server.ts` (child) orphans
  //      the child to ppid=1. Its own orphan watchdog fires at 5s — plenty
  //      of time for the next tmux new-session to start a second bun that
  //      collides with the orphan on getUpdates (Telegram returns 409,
  //      grammy eventually exits its polling loop → silent "zombie" where
  //      bun is alive + MCP tools present but no inbound messages).
  //   2. One scan pass can miss a plugin pid whose env block hasn't fully
  //      materialized yet (e.g. `bun install` mid-exec during `bun run`).
  //
  // Mitigation: loop SIGKILL + rescan until the scan is empty, and block
  // until the killed pids actually exit (not just "signal delivered").
  // SIGTERM is kept as a best-effort first step — every observed restart
  // has SIGTERM ignored (server.ts lacks a handler), so the grace window
  // is short. If upstream ever adds SIGTERM handling, this path gives it
  // room to flush stdio cleanly.
  async function killTelegramPluginServers(bot) {
    const MAX_PASSES = 5;
    const SIGTERM_GRACE_MS = 200;
    const REAP_TIMEOUT_MS = 2000;
    const PROBE_INTERVAL_MS = 50;

    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const pids = findTelegramPluginPids(bot);
      if (pids.length === 0) return;

      if (pass === 0 && pids.length > 2) {
        // Normal restart: wrapper (`bun run`) + `bun server.ts` = 2 pids.
        // More means the previous cycle leaked — surface it so we can tell
        // whether the leak is one-shot or accumulating.
        console.log(
          `[killProcess] ${bot.name}: WARN ${pids.length} plugin pids on pass 0 (expected ≤2): ${pids.join(',')}`
        );
      }

      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      await sleep(SIGTERM_GRACE_MS);

      for (const pid of pids.filter(isAlive)) {
        try {
          process.kill(pid, 'SIGKILL');
          console.log(
            `[killProcess] ${bot.name}: SIGKILLed plugin server pid ${pid} (ignored SIGTERM)`
          );
        } catch {
          /* raced to exit */
        }
      }

      // Block until every pid we just signaled is truly gone. If we return
      // while anything is still polling, startProcess' tmux new-session
      // races that survivor on the bot token.
      const deadline = Date.now() + REAP_TIMEOUT_MS;
      while (Date.now() < deadline && pids.some(isAlive)) {
        await sleep(PROBE_INTERVAL_MS);
      }
    }

    const remaining = findTelegramPluginPids(bot);
    if (remaining.length > 0) {
      console.log(
        `[killProcess] ${bot.name}: WARN ${remaining.length} plugin pids survived ${MAX_PASSES} reap passes: ${remaining.join(',')}`
      );
    }
  }

  // Shut down a bot: graceful first, forceful only if that stalls.
  //
  // Why the escalation — claude-code and the telegram plugin each have their
  // own graceful-exit paths, and chaining them correctly avoids the common
  // failure mode where SIGKILL lands on the plugin mid-stdio-flush and
  // leaves MCP in a dirty state for the next session.
  //
  //   1. tmux send-keys "/exit" — most user-like. Claude runs its full exit
  //      routine (session save, hooks), closes the MCP stdio. The plugin
  //      has handlers for stdin 'end' / SIGTERM / SIGHUP / orphan ppid, so
  //      its shutdown() runs on its own — bot.stop() drains the long-poll
  //      (≤2s self-cap), then process.exit(0).
  //   2. SIGTERM on claude's pid — fallback when the TUI isn't at a prompt
  //      state (mid-tool, modal, or "/exit" got consumed as prompt text).
  //      Signal delivery bypasses TUI state; Node's default closes stdio
  //      before exit, which is all the plugin needs to cascade down.
  //   3. SIGKILL — last-resort for a frozen TUI (raw-mode loss; rare).
  //   4. killTelegramPluginServers — plugin pid that didn't follow claude
  //      down on its own. Also mops up orphans from prior sessions claude
  //      never knew about (cross-session accumulation — see memory file
  //      project_telegram_mcp_instability).
  //   5. tmux kill-session — fresh pty for the next boot. Still necessary
  //      even when everything exited cleanly, because start.sh ends with
  //      `exec bash -l`; that bash keeps the pane alive until we kill it,
  //      and a fresh session clears any accumulated termios state.
  async function killProcess(bot) {
    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitUntil = async (pred, timeoutMs, probeMs = 100) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred()) return true;
        await sleep(probeMs);
      }
      return false;
    };

    const claudePid = getClaudePid(bot);
    const initialPluginPids = findTelegramPluginPids(bot);
    const sessionUp = sessionExists(bot);

    if (claudePid) {
      if (sessionUp) {
        try {
          sh(`tmux send-keys -t ${bot.session} '/exit' Enter`);
          // Claude Code shows "Exit anyway / Stay" when CronCreate has
          // pending scheduled tasks. The default highlight is "Exit anyway",
          // so a second Enter confirms it. When no modal appears (no pending
          // tasks) the extra Enter lands on the bash prompt exec'd by
          // start.sh — harmless.
          await sleep(300);
          sh(`tmux send-keys -t ${bot.session} Enter`);
        } catch {
          /* send-keys race / session died mid-call — fall through */
        }
        await waitUntil(() => !isAlive(claudePid), 3000);
      }
      if (isAlive(claudePid)) {
        try {
          process.kill(claudePid, 'SIGTERM');
        } catch {
          /* already gone */
        }
        await waitUntil(() => !isAlive(claudePid), 2000);
      }
      if (isAlive(claudePid)) {
        try {
          process.kill(claudePid, 'SIGKILL');
          console.log(
            `[killProcess] ${bot.name}: claude pid ${claudePid} ignored /exit+SIGTERM, SIGKILLed`
          );
        } catch {
          /* raced to exit */
        }
      }
    }

    // Plugin pids should cascade down via MCP EOF. Give them time to finish
    // their own shutdown (bot.stop draining in-flight long-poll).
    await waitUntil(
      () => initialPluginPids.every((p) => !isAlive(p)),
      3000
    );

    // Forceful fallback: survivors + orphans from prior sessions.
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

  // Claude Code's TUI renders a few stable "chrome" lines at the bottom of
  // the visible pane — input box, separator bars, the bypass-permissions
  // banner, the thinking-spinner ("✶ Incubating…", "* Fiddle-faddling…"),
  // the queued-messages indicator. They redraw on every frame with subtly
  // different text, so a line-equality diff treats each frame as "new
  // content" and the monitor ends up pushing the whole screen every tick.
  // Recognizing chrome by shape and stripping it from the tail of each
  // capture before diffing leaves just scrollback + stable visible content,
  // which IS append-only and aligns cleanly.
  const CHROME_LINE =
    /^(?:|\s*─+|❯\s*|\s*⏵⏵.*|\s*[*·✶✻✽⋯◉]\s.*|\s*←\s+\w+.*|\s*▎\s.*|\s*You've used \d+%.*|\s*\(.*(?:ctrl|shift|alt|esc)\b.*\).*)$/;

  function stripTrailingChrome(lines) {
    let n = lines.length;
    while (n > 0 && CHROME_LINE.test(lines[n - 1])) n--;
    return lines.slice(0, n);
  }

  // Shift-aware prefix alignment on chrome-stripped captures.
  //
  // After stripping chrome, what remains is scrollback plus stable visible
  // content — effectively append-only between ticks. So `curr` equals
  // `prev` (idle) or `prev` shifted down by k lines is a prefix of `curr`
  // (k = lines added since the last tick, k >= 0). If the capture window
  // overflowed, k > 0 represents how many old lines fell off the top.
  //
  // Trick: find the smallest k such that `prev[k..]` is a prefix of
  // `curr[..len(prev)-k]`. Anything in `curr` past the aligned region is
  // the new content. O(N^2) worst case; N is bounded by the capture
  // window (<=500 lines) so ~250k comparisons per tick — not measurable.
  //
  // Earlier attempts (set diff, multiset diff, plain prefix+suffix trim)
  // all either lost position information or failed once the pane grew
  // past the capture window.
  function extractNewContent(prev, current) {
    if (!prev || !current) return null;
    if (prev === current) return null;
    const prevLines = stripTrailingChrome(
      prev.split('\n').map((l) => l.trimEnd())
    );
    const currLines = stripTrailingChrome(
      current.split('\n').map((l) => l.trimEnd())
    );
    if (prevLines.length === 0 && currLines.length === 0) return null;

    let shift = -1;
    for (let k = 0; k <= prevLines.length; k++) {
      const cmpLen = prevLines.length - k;
      if (cmpLen > currLines.length) continue;
      let match = true;
      for (let i = 0; i < cmpLen; i++) {
        if (prevLines[k + i] !== currLines[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        shift = k;
        break;
      }
    }
    if (shift === -1) return null;

    const alignedEnd = prevLines.length - shift;
    const additions = [];
    for (let i = alignedEnd; i < currLines.length; i++) {
      const line = currLines[i];
      if (!line) continue;
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
  // Disk-backed sleep log. The supervisor is the only writer: every successful
  // fireSleep() writes `<workDir>/.zero-claw/sleep-log.json` with the ISO
  // timestamp of the send. readSleepLog then answers "did sleep fire within
  // SLEEP_DONE_MAX_AGE_HOURS?" directly from that file, independent of whether
  // claude actually processed the message or what its transcripts look like.
  //
  // Why not scan claude's transcripts (prior behavior): transcript mtime is
  // tied to session activity, not to the sleep event itself, and an 8–12h
  // catch-up window could miss the 01:00 entry by mid-afternoon, causing the
  // scheduler to re-fire sleep as catch-up. The disk log is authoritative and
  // cheap, and the supervisor already owns this directory for the MCP
  // disconnect marker.
  function sleepLogPath(bot) {
    return path.join(bot.workDir, '.zero-claw', 'sleep-log.json');
  }

  function readSleepLog(bot) {
    const f = sleepLogPath(bot);
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf-8');
    } catch {
      return { ok: false, reason: 'no sleep log yet' };
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `sleep log malformed (${f})` };
    }
    const ts = new Date(obj.lastFiredAt).getTime();
    if (!Number.isFinite(ts)) {
      return { ok: false, reason: 'sleep log timestamp unreadable' };
    }
    const cutoffMs = Date.now() - SLEEP_DONE_MAX_AGE_HOURS * 3600_000;
    if (ts < cutoffMs) {
      return {
        ok: false,
        reason: `last sleep ${new Date(ts).toISOString()} older than ${SLEEP_DONE_MAX_AGE_HOURS}h window`,
      };
    }
    return { ok: true, at: new Date(ts) };
  }

  function writeSleepLog(bot, at) {
    const f = sleepLogPath(bot);
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(
        f,
        JSON.stringify({ lastFiredAt: at.toISOString() }) + '\n',
        'utf-8'
      );
    } catch (err) {
      console.error(`[sleep-log] ${bot.name}: write failed: ${err.message}`);
    }
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
      // Write log AFTER send-keys succeed. A failed send falls through to the
      // catch below without touching the log, so next tick retries once.
      writeSleepLog(bot, new Date());
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

  // --- MCP disconnect marker ---
  // The bot's heartbeat drops `<work-dir>/.zero-claw/mcp-disconnected` when it
  // finds the Telegram reply tool missing — Claude Code occasionally yanks the
  // plugin out of a long-running session (observed right after background
  // subagents return). Bot can detect it (tool list is authoritative) but
  // can't reconnect from inside; supervisor restart is the known fix.
  function mcpDisconnectMarker(bot) {
    return path.join(bot.workDir, '.zero-claw', 'mcp-disconnected');
  }

  function checkAndClearMcpMarker(bot) {
    const f = mcpDisconnectMarker(bot);
    if (!fs.existsSync(f)) return false;
    try {
      fs.unlinkSync(f);
    } catch {
      /* race with bot rewriting it; next tick catches it */
    }
    return true;
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

      // MCP disconnect marker — restart even when claude itself is alive.
      // Clear-then-act: if startProcess fails, next tick will see no marker
      // and fall through to the regular death path, which is the correct
      // recovery.
      if (checkAndClearMcpMarker(bot)) {
        console.log(`[watchdog] ${bot.name}: MCP disconnect marker found, restarting`);
        onEvent(`${bot.name} MCP disconnected — restarting to reconnect`);
        markRestart(bot.name);
        invalidateContextCache(bot.name);
        resetRestartState(bot.name);
        startProcess(bot);
        continue;
      }

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
      // Dedupe by reading the disk sleep log. The log survives supervisor
      // restarts, so "already fired today" holds across pm2 bounces within
      // the same local day.
      if (
        sleepTarget &&
        minutesNow >= sleepTarget.h * 60 + sleepTarget.mm
      ) {
        const recent = readSleepLog(bot);
        const alreadyToday = recent.ok && sameLocalDate(recent.at, now);
        if (!alreadyToday) {
          const ctx = recent.ok
            ? `log stale (last sleep at ${recent.at.toISOString()})`
            : recent.reason;
          console.log(
            `[sleep] ${bot.name}: catch-up fire (minutesNow=${minutesNow}, target=${sleepTarget.h * 60 + sleepTarget.mm}; ${ctx})`
          );
          fireSleep(bot);
        }
      }

      // --- Restart: scheduled daily (sleep-confirmed, ≥1h old) or uptime. ---
      // fireSleep (above) writes the disk log synchronously, so readSleepLog
      // here sees the fresh entry in the same tick: catch-up → age < 1h →
      // "too fresh, hold" — no transcript-lag Case B needed.
      let trigger = null;
      let reason = '';

      if (
        dailyTarget &&
        lastRestartFiredDate.get(bot.name) !== todayStr &&
        minutesNow >= dailyTarget.h * 60 + dailyTarget.mm
      ) {
        const check = readSleepLog(bot);
        if (!check.ok) {
          const msg = `${bot.name} daily restart skipped — ${check.reason}`;
          console.log(`[daily-restart] ${msg}`);
          onEvent(msg);
          lastRestartFiredDate.set(bot.name, todayStr);
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
