#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { loadMeta } from './lib/graph.mjs';

const REQUIRED_FRONTMATTER = ['title', 'type'];

function parseArgs(argv) {
  const args = { vault: null, flags: new Set() };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--')) args.flags.add(a.slice(2));
    else if (!args.vault) args.vault = a;
  }
  return args;
}

function usage() {
  console.error('usage: wiki-lint.mjs <vault-path> [--json]');
  process.exit(1);
}

function normalize(s) {
  return String(s).trim().toLowerCase();
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.vault) usage();

  const vaultRoot = path.resolve(args.vault);
  const metaPath = path.join(vaultRoot, '.wiki-cache', 'meta.json');
  const asJson = args.flags.has('json');
  const meta = await loadMeta(metaPath);
  if (!Object.keys(meta.pages).length) {
    console.error('meta.json empty or no wiki pages — run wiki-graph first');
    process.exit(1);
  }

  const byTitle = new Map();
  const byStem = new Map();
  const inDegree = new Map();
  for (const pagePath of Object.keys(meta.pages)) {
    inDegree.set(pagePath, 0);
    byStem.set(path.basename(pagePath, '.md'), pagePath);
  }
  for (const [pagePath, page] of Object.entries(meta.pages)) {
    if (page.title) byTitle.set(normalize(page.title), pagePath);
  }

  const brokenLinks = [];
  for (const [pagePath, page] of Object.entries(meta.pages)) {
    for (const link of page.related || []) {
      const resolved = byTitle.get(normalize(link)) || byStem.get(link);
      if (resolved) {
        inDegree.set(resolved, inDegree.get(resolved) + 1);
      } else {
        brokenLinks.push({ from: pagePath, link });
      }
    }
  }

  const islands = [];
  for (const [pagePath, deg] of inDegree) {
    const page = meta.pages[pagePath];
    const outDeg = (page.related || []).length;
    if (deg === 0 && outDeg === 0) islands.push(pagePath);
  }

  const missingFrontmatter = [];
  for (const [pagePath, page] of Object.entries(meta.pages)) {
    const missing = REQUIRED_FRONTMATTER.filter((f) => !page[f]);
    if (missing.length) missingFrontmatter.push({ page: pagePath, missing });
  }

  const report = { brokenLinks, islands, missingFrontmatter };
  const hasIssues =
    brokenLinks.length > 0 ||
    islands.length > 0 ||
    missingFrontmatter.length > 0;

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(`broken links: ${brokenLinks.length}`);
    for (const b of brokenLinks) console.log(`  ${b.from} → [[${b.link}]]`);
    console.log(`\nislands (no inbound, no outbound): ${islands.length}`);
    for (const p of islands) console.log(`  ${p}`);
    console.log(`\nmissing frontmatter: ${missingFrontmatter.length}`);
    for (const m of missingFrontmatter) {
      console.log(`  ${m.page}: ${m.missing.join(', ')}`);
    }
  }
  process.exit(hasIssues ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
