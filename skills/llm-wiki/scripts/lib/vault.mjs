import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';

export const WIKI_DIR = '_wiki';
const SKIP_DIRS = new Set(['node_modules']);

export async function* walkMarkdown(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith('.md')) yield full;
    }
  }
}

export function toRel(vaultRoot, absPath) {
  return path.relative(vaultRoot, absPath).split(path.sep).join('/');
}

export function classifyPath(vaultRoot, absPath) {
  const rel = toRel(vaultRoot, absPath);
  const isWiki = rel === WIKI_DIR || rel.startsWith(WIKI_DIR + '/');
  return { rel, kind: isWiki ? 'page' : 'raw' };
}

export async function readNote(absPath) {
  const buf = await fs.readFile(absPath);
  const hash = 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
  const stat = await fs.stat(absPath);
  const parsed = matter(buf.toString('utf8'));
  const links = extractWikiLinks(parsed.content);
  return {
    mtime: Math.floor(stat.mtimeMs / 1000),
    hash,
    frontmatter: parsed.data || {},
    body: parsed.content,
    links,
  };
}

export function extractWikiLinks(text) {
  const re = /\[\[([^\]|#\n]+)(?:#[^\]|\n]+)?(?:\|[^\]\n]+)?\]\]/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text))) out.add(m[1].trim());
  return [...out];
}
