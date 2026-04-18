#!/usr/bin/env node
// Tiny CLI client for the supervisor's Unix-socket surface. Invoked by the
// `/zero-claw:supervisor` slash command; also usable by hand from any shell
// inside the project tree.
//
// Usage:  supervisor/cli.mjs <subcommand> [args...]
//
// Walks up from the caller's cwd to find the project root (the nearest
// ancestor that contains `ecosystem.config.cjs`), then connects to the
// sibling socket `.zero-claw-supervisor.sock`. Dispatching happens server-
// side via `commands.dispatch`, so every subcommand the Telegram bot
// understands works here too — same code path, same state.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

function findProjectRoot(start) {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, 'ecosystem.config.cjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function die(msg, code = 1) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

const [, , cmd, ...args] = process.argv;

const root = findProjectRoot(process.cwd());
if (!root) {
  die(
    "Can't find project root: no ecosystem.config.cjs in any ancestor of " +
      process.cwd()
  );
}

const sockPath = path.join(root, '.zero-claw-supervisor.sock');
if (!fs.existsSync(sockPath)) {
  die(
    `Supervisor not running: ${sockPath} not found. Try: pm2 start ecosystem.config.cjs`
  );
}

const sock = net.createConnection(sockPath);
let chunks = '';

sock.setEncoding('utf-8');
sock.on('connect', () => {
  sock.end(JSON.stringify({ cmd: cmd || 'help', args }) + '\n');
});
sock.on('data', (d) => (chunks += d));
sock.on('error', (err) =>
  die(`Socket error: ${err.message} (${sockPath})`, 1)
);
sock.on('end', () => {
  const nl = chunks.indexOf('\n');
  const line = nl >= 0 ? chunks.slice(0, nl) : chunks;
  let resp;
  try {
    resp = JSON.parse(line);
  } catch (err) {
    die(`Bad response from supervisor: ${err.message}\nRaw: ${line}`, 1);
  }
  if (resp.error) die(resp.error, 1);
  process.stdout.write((resp.text || '') + '\n');
  process.exit(0);
});
