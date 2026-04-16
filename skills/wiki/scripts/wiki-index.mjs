#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import process from 'node:process';
import { loadMeta, saveMeta } from './lib/graph.mjs';
import { chunkMarkdown } from './lib/chunk.mjs';
import { openStore, saveStore, replaceChunks, removeChunks } from './lib/orama-store.mjs';
import { loadConfig, saveConfig, deleteConfig } from './lib/config.mjs';
import { MODELS, DEFAULT_MODEL, resolveModel } from './lib/models.mjs';

const VALUE_OPTS = new Set(['model']);

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
    `usage: wiki-index.mjs <vault-path> [--full] [--with-vectors [--model <name>]] [--no-vectors] [--json]
models: ${Object.keys(MODELS).join(', ')}`,
  );
  process.exit(1);
}

function chunkTypeFor(kind, pageType) {
  if (kind === 'raw') return 'raw';
  return pageType || 'concept';
}

function resolveMode(args, prevConfig) {
  if (args.flags.has('no-vectors')) return { vectors: false, model: null };
  if (args.flags.has('with-vectors')) {
    const name = args.opts.get('model') || prevConfig?.embeddingModel || DEFAULT_MODEL;
    return { vectors: true, model: resolveModel(name) };
  }
  if (prevConfig?.embeddingModel) {
    return { vectors: true, model: resolveModel(prevConfig.embeddingModel) };
  }
  return { vectors: false, model: null };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.vault) usage();

  const vaultRoot = path.resolve(args.vault);
  const metaPath = path.join(vaultRoot, '.wiki-cache', 'meta.json');
  const storePath = path.join(vaultRoot, '.wiki-cache', 'orama.msp');
  const asJson = args.flags.has('json');

  const prevConfig = await loadConfig(vaultRoot);
  const mode = resolveMode(args, prevConfig);

  const prevModel = prevConfig?.embeddingModel || null;
  const nextModel = mode.model?.name || null;
  const modeChanged = prevModel !== nextModel;
  const full = args.flags.has('full') || modeChanged;

  const meta = await loadMeta(metaPath);
  if (!Object.keys(meta.raw).length && !Object.keys(meta.pages).length) {
    console.error('meta.json empty or missing — run wiki-graph.mjs first');
    process.exit(1);
  }

  if (full) {
    for (const e of Object.values(meta.raw)) {
      e.chunkIds = [];
      e.indexedHash = null;
    }
    for (const e of Object.values(meta.pages)) {
      e.chunkIds = [];
      e.indexedHash = null;
    }
    meta.pendingDeletions = [];
  }

  const store = await openStore(storePath, {
    fresh: full,
    withVectors: mode.vectors,
    dim: mode.model?.dim || 384,
  });

  if (!full && meta.pendingDeletions?.length) {
    let removedCount = 0;
    for (const d of meta.pendingDeletions) {
      await removeChunks(store, d.chunkIds);
      removedCount += d.chunkIds.length;
    }
    meta.pendingDeletions = [];
    if (!asJson) console.log(`removed ${removedCount} orphan chunks`);
  }

  const toIndex = [];
  for (const [rel, entry] of Object.entries(meta.raw)) {
    if (entry.hash !== entry.indexedHash || !entry.chunkIds.length) {
      toIndex.push({ rel, kind: 'raw', type: 'raw', entry });
    }
  }
  for (const [rel, entry] of Object.entries(meta.pages)) {
    if (entry.hash !== entry.indexedHash || !entry.chunkIds.length) {
      toIndex.push({
        rel,
        kind: 'page',
        type: chunkTypeFor('page', entry.type),
        entry,
      });
    }
  }

  let embedText;
  if (mode.vectors) {
    ({ embedText } = await import('./lib/embed.mjs'));
  }

  let chunksIndexed = 0;
  for (const [i, item] of toIndex.entries()) {
    const abs = path.join(vaultRoot, item.rel);
    const raw = await fs.readFile(abs, 'utf8');
    const chunks = chunkMarkdown(raw);
    if (mode.vectors) {
      for (const c of chunks) {
        c.embedding = await embedText(mode.model, c.text, 'passage');
      }
    }
    const oldIds = item.entry.chunkIds || [];
    const ids = await replaceChunks(store, item.rel, oldIds, chunks, item.type);
    chunksIndexed += ids.length;
    item.entry.chunkIds = ids;
    item.entry.indexedHash = item.entry.hash;
    if (mode.vectors && !asJson && toIndex.length > 10 && (i + 1) % 20 === 0) {
      process.stderr.write(`  embedded ${i + 1}/${toIndex.length} files\n`);
    }
  }

  await saveStore(store);
  await saveMeta(metaPath, meta);

  if (mode.vectors) {
    await saveConfig(vaultRoot, {
      embeddingModel: mode.model.name,
      embeddingDim: mode.model.dim,
      createdAt: prevConfig?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } else if (prevConfig) {
    await deleteConfig(vaultRoot);
  }

  const summary = {
    reindexed: toIndex.length,
    chunks: chunksIndexed,
    vectors: mode.vectors,
    model: mode.model?.name || null,
    full,
    storePath: store.storePath,
  };
  if (asJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    const v = mode.vectors ? ` (vectors: ${mode.model.name})` : '';
    console.log(
      `reindexed ${summary.reindexed} files, ${summary.chunks} chunks${v}${full ? ' [full rebuild]' : ''}`,
    );
    console.log(`store: ${summary.storePath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
