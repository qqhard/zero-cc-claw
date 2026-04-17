import { promises as fs } from 'node:fs';
import path from 'node:path';

export function configPath(vaultRoot) {
  return path.join(vaultRoot, '.wiki-cache', 'config.json');
}

export async function loadConfig(vaultRoot) {
  try {
    const txt = await fs.readFile(configPath(vaultRoot), 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

export async function saveConfig(vaultRoot, config) {
  const p = configPath(vaultRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(config, null, 2) + '\n');
}

export async function deleteConfig(vaultRoot) {
  try {
    await fs.unlink(configPath(vaultRoot));
  } catch {}
}
