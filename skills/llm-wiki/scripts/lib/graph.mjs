import { promises as fs } from 'node:fs';
import path from 'node:path';
import { walkMarkdown, classifyPath, readNote } from './vault.mjs';

export const META_VERSION = 1;

export function emptyMeta() {
  return {
    version: META_VERSION,
    updatedAt: null,
    raw: {},
    pages: {},
    pendingDeletions: [],
  };
}

export async function loadMeta(metaPath) {
  try {
    const txt = await fs.readFile(metaPath, 'utf8');
    const obj = JSON.parse(txt);
    if (obj.version !== META_VERSION) return emptyMeta();
    return obj;
  } catch {
    return emptyMeta();
  }
}

export async function saveMeta(metaPath, meta) {
  meta.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
}

export async function scanVault(vaultRoot, prevMeta) {
  const raw = {};
  const pages = {};
  for await (const abs of walkMarkdown(vaultRoot)) {
    const { rel, kind } = classifyPath(vaultRoot, abs);
    const note = await readNote(abs);
    if (kind === 'raw') {
      const prev = prevMeta?.raw?.[rel] || {};
      raw[rel] = {
        mtime: note.mtime,
        hash: note.hash,
        consumedBy: [],
        chunkIds: prev.chunkIds || [],
        indexedHash: prev.indexedHash ?? null,
      };
    } else {
      const fm = note.frontmatter;
      const sources = Array.isArray(fm.sources) ? fm.sources.map(String) : [];
      const prev = prevMeta?.pages?.[rel] || {};
      pages[rel] = {
        mtime: note.mtime,
        hash: note.hash,
        title: fm.title ?? null,
        type: fm.type ?? null,
        sources,
        sourceHashes: prev.sourceHashes || {},
        related: note.links,
        chunkIds: prev.chunkIds || [],
        indexedHash: prev.indexedHash ?? null,
      };
    }
  }
  for (const [pagePath, page] of Object.entries(pages)) {
    for (const src of page.sources) {
      const entry = raw[src];
      if (entry && !entry.consumedBy.includes(pagePath)) {
        entry.consumedBy.push(pagePath);
      }
    }
  }

  const pendingDeletions = [...(prevMeta?.pendingDeletions || [])];
  for (const [rel, entry] of Object.entries(prevMeta?.raw || {})) {
    if (!raw[rel] && entry.chunkIds?.length) {
      pendingDeletions.push({ path: rel, chunkIds: entry.chunkIds });
    }
  }
  for (const [rel, entry] of Object.entries(prevMeta?.pages || {})) {
    if (!pages[rel] && entry.chunkIds?.length) {
      pendingDeletions.push({ path: rel, chunkIds: entry.chunkIds });
    }
  }

  return {
    version: META_VERSION,
    updatedAt: null,
    raw,
    pages,
    pendingDeletions,
  };
}

export function computeDirty(meta) {
  const dirtyPages = [];
  for (const [pagePath, page] of Object.entries(meta.pages)) {
    const reasons = [];
    for (const src of page.sources) {
      const currentRaw = meta.raw[src];
      const recordedHash = page.sourceHashes[src];
      if (!currentRaw) {
        reasons.push({ source: src, reason: 'source-missing' });
      } else if (!recordedHash) {
        reasons.push({ source: src, reason: 'never-compiled' });
      } else if (currentRaw.hash !== recordedHash) {
        reasons.push({
          source: src,
          reason: 'source-changed',
          oldHash: recordedHash,
          newHash: currentRaw.hash,
        });
      }
    }
    const droppedSources = Object.keys(page.sourceHashes).filter(
      (s) => !page.sources.includes(s),
    );
    if (droppedSources.length) {
      for (const s of droppedSources) {
        reasons.push({ source: s, reason: 'dropped-from-frontmatter' });
      }
    }
    if (reasons.length) dirtyPages.push({ page: pagePath, reasons });
  }
  const orphanSources = Object.entries(meta.raw)
    .filter(([, v]) => v.consumedBy.length === 0)
    .map(([p]) => p);
  return { dirtyPages, orphanSources };
}
