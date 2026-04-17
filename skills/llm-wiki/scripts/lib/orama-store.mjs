import path from 'node:path';
import { promises as fs } from 'node:fs';
import { create, insertMultiple, removeMultiple, search } from '@orama/orama';
import { createTokenizer } from '@orama/tokenizers/mandarin';
import { persistToFile, restoreFromFile } from '@orama/plugin-data-persistence/server';

export { search } from '@orama/orama';

const BASE_SCHEMA = {
  path: 'string',
  chunkIdx: 'number',
  heading: 'string',
  text: 'string',
  type: 'enum',
};

function buildSchema({ withVectors = false, dim = 384 } = {}) {
  const schema = { ...BASE_SCHEMA };
  if (withVectors) schema.embedding = `vector[${dim}]`;
  return schema;
}

export async function openStore(storePath, { fresh = false, withVectors = false, dim = 384 } = {}) {
  const tokenizer = await createTokenizer();
  const schema = buildSchema({ withVectors, dim });
  let db;
  if (!fresh) {
    try {
      await fs.access(storePath);
      db = await restoreFromFile('binary', storePath);
      db.tokenizer = tokenizer;
    } catch {
      db = create({ schema, components: { tokenizer } });
    }
  } else {
    db = create({ schema, components: { tokenizer } });
  }
  return { db, storePath };
}

export async function saveStore({ db, storePath }) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await persistToFile(db, 'binary', storePath);
}

export async function replaceChunks({ db }, docPath, oldChunkIds, chunks, type) {
  if (oldChunkIds?.length) await removeMultiple(db, oldChunkIds);
  if (chunks.length === 0) return [];
  const docs = chunks.map((c) => ({
    path: docPath,
    chunkIdx: c.chunkIdx,
    heading: c.heading,
    text: c.text,
    type,
    ...(c.embedding ? { embedding: c.embedding } : {}),
  }));
  return await insertMultiple(db, docs);
}

export async function removeChunks({ db }, chunkIds) {
  if (chunkIds?.length) await removeMultiple(db, chunkIds);
  return chunkIds?.length || 0;
}

export async function searchBM25({ db }, term, { limit = 10, where } = {}) {
  const params = { limit };
  if (term) params.term = term;
  if (where && Object.keys(where).length) params.where = where;
  return search(db, params);
}

export async function searchHybrid({ db }, term, queryVec, { limit = 10, where, textWeight = 0.4, vectorWeight = 0.6, similarity = 0.5 } = {}) {
  const params = {
    mode: 'hybrid',
    term,
    vector: { value: queryVec, property: 'embedding' },
    similarity,
    limit,
    hybridWeights: { text: textWeight, vector: vectorWeight },
  };
  if (where && Object.keys(where).length) params.where = where;
  return search(db, params);
}
