#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { loadMeta, saveMeta, scanVault, computeDirty } from './lib/graph.mjs';

const VALUE_OPTS = new Set(['stamp']);

function parseArgs(argv) {
  const args = { vault: null, flags: new Set(), opts: new Map() };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const [k, vInline] = a.slice(2).split('=');
      if (VALUE_OPTS.has(k)) {
        const v = vInline ?? rest[++i];
        args.opts.set(k, v);
      } else {
        args.flags.add(k);
      }
    } else if (!args.vault) args.vault = a;
  }
  return args;
}

function usage() {
  console.error(
    'usage: wiki-graph.mjs <vault-path> [--diff] [--stamp <page>] [--json]',
  );
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.vault) usage();

  const vaultRoot = path.resolve(args.vault);
  const metaPath = path.join(vaultRoot, '.wiki-cache', 'meta.json');
  const asJson = args.flags.has('json');

  const prev = await loadMeta(metaPath);
  const meta = await scanVault(vaultRoot, prev);

  if (args.opts.has('stamp')) {
    const pagePath = args.opts.get('stamp');
    const page = meta.pages[pagePath];
    if (!page) {
      console.error(`page not in meta: ${pagePath}`);
      process.exit(1);
    }
    const stamped = {};
    const missing = [];
    for (const src of page.sources) {
      const raw = meta.raw[src];
      if (raw) stamped[src] = raw.hash;
      else missing.push(src);
    }
    page.sourceHashes = stamped;
    await saveMeta(metaPath, meta);
    const result = { stamped: Object.keys(stamped), missing };
    if (asJson) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      console.log(`stamped ${pagePath}: ${result.stamped.length} sources`);
      if (missing.length) console.log(`  missing: ${missing.join(', ')}`);
    }
    return;
  }

  if (args.flags.has('diff')) {
    const diff = computeDirty(meta);
    if (asJson) {
      process.stdout.write(JSON.stringify(diff, null, 2) + '\n');
    } else {
      console.log(`dirty pages: ${diff.dirtyPages.length}`);
      for (const d of diff.dirtyPages) {
        console.log(`  ${d.page}`);
        for (const r of d.reasons) {
          console.log(`    - ${r.source}: ${r.reason}`);
        }
      }
      console.log(`\norphan sources: ${diff.orphanSources.length}`);
      for (const s of diff.orphanSources) console.log(`  ${s}`);
    }
    return;
  }

  await saveMeta(metaPath, meta);
  const summary = {
    rawCount: Object.keys(meta.raw).length,
    pageCount: Object.keys(meta.pages).length,
    metaPath,
  };
  if (asJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    console.log(`scanned: ${summary.rawCount} raw, ${summary.pageCount} pages`);
    console.log(`meta written: ${summary.metaPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
