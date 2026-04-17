#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { openStore, searchBM25, searchHybrid } from './lib/orama-store.mjs';
import { loadConfig } from './lib/config.mjs';
import { resolveModel } from './lib/models.mjs';

const VALUE_OPTS = new Set(['k', 'type', 'text-weight', 'vector-weight', 'similarity']);

function parseArgs(argv) {
  const args = { vault: null, query: null, flags: new Set(), opts: new Map() };
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
    else if (!args.query) args.query = a;
  }
  return args;
}

function usage() {
  console.error(
    'usage: wiki-search.mjs <vault-path> <query> [--k 10] [--type <t>] [--bm25] [--hybrid] [--json]',
  );
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.vault || !args.query) usage();

  const vaultRoot = path.resolve(args.vault);
  const storePath = path.join(vaultRoot, '.wiki-cache', 'orama.msp');
  const limit = Number(args.opts.get('k') ?? 10);
  const typeFilter = args.opts.get('type');
  const asJson = args.flags.has('json');

  const config = await loadConfig(vaultRoot);
  let useHybrid;
  if (args.flags.has('bm25')) useHybrid = false;
  else if (args.flags.has('hybrid')) useHybrid = !!config;
  else useHybrid = !!config;
  if (args.flags.has('hybrid') && !config) {
    console.error('no embedding config — run wiki-index --with-vectors first');
    process.exit(1);
  }

  const store = await openStore(storePath, {
    withVectors: !!config,
    dim: config?.embeddingDim || 384,
  });
  const where = typeFilter ? { type: { eq: typeFilter } } : undefined;

  let res;
  if (useHybrid && config) {
    const modelMeta = resolveModel(config.embeddingModel);
    const { embedText } = await import('./lib/embed.mjs');
    const queryVec = await embedText(modelMeta, args.query, 'query');
    res = await searchHybrid(store, args.query, queryVec, {
      limit,
      where,
      textWeight: Number(args.opts.get('text-weight') ?? 0.4),
      vectorWeight: Number(args.opts.get('vector-weight') ?? 0.6),
      similarity: Number(args.opts.get('similarity') ?? 0.5),
    });
  } else {
    res = await searchBM25(store, args.query, { limit, where });
  }

  const hits = res.hits.map((h) => ({
    path: h.document.path,
    chunkIdx: h.document.chunkIdx,
    heading: h.document.heading,
    type: h.document.type,
    score: h.score,
    text: h.document.text,
  }));

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ count: res.count, mode: useHybrid ? 'hybrid' : 'bm25', hits }, null, 2) + '\n',
    );
    return;
  }

  console.log(`${res.count} hits (${useHybrid ? 'hybrid' : 'bm25'})`);
  for (const h of hits) {
    const heading = h.heading || '(no heading)';
    const score = typeof h.score === 'number' ? h.score.toFixed(3) : '-';
    console.log(`\n[${score}] ${h.path}#${h.chunkIdx} (${h.type}) — ${heading}`);
    const snippet = h.text.replace(/\n+/g, ' ').slice(0, 200);
    console.log(snippet + (h.text.length > 200 ? '…' : ''));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
