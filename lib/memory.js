// Lightweight long-term memory for the agent.
// Stored as a JSON file under WORKSPACE_DIR/memory.json. Each entry has:
//   { id, text, tags:[], createdAt, importance }
// Retrieval is a BM25-ish keyword scorer — fast, dependency-free, and good
// enough for an assistant with hundreds of notes. Drop-in replacement hooks
// are provided so users can later plug in embeddings (Ollama + nomic-embed,
// for example) without rewriting callers.

import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

const STOP = new Set((
  'a an and are as at be but by for from has have he her his i if in into is it its ' +
  'of on or our she that the their them then there these they this to was we were ' +
  'what when where which who why will with you your'
).split(/\s+/));

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOP.has(t) && t.length > 1);
}

function score(query, text) {
  const q = new Set(tokenize(query));
  if (!q.size) return 0;
  const tokens = tokenize(text);
  if (!tokens.length) return 0;
  let hits = 0;
  for (const t of tokens) if (q.has(t)) hits++;
  // Normalized hit rate with a length penalty so tiny notes about the exact
  // topic rank above giant tangentially related ones.
  return hits / Math.sqrt(tokens.length + 4);
}

export function createMemory({ dir, file = 'memory.json', max = 1000 } = {}) {
  const path = join(dir, file);
  let entries = null;
  let loaded = false;

  async function ensure() {
    if (loaded) return;
    if (!existsSync(dirname(path))) await mkdir(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try { entries = JSON.parse(await readFile(path, 'utf8')); }
      catch { entries = []; }
    } else {
      entries = [];
    }
    if (!Array.isArray(entries)) entries = [];
    loaded = true;
  }

  async function flush() {
    await writeFile(path, JSON.stringify(entries, null, 2), 'utf8');
  }

  return {
    async add({ text, tags = [], importance = 1 }) {
      await ensure();
      const entry = {
        id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: String(text || '').trim(),
        tags: Array.isArray(tags) ? tags.map(String) : [],
        importance: Number(importance) || 1,
        createdAt: new Date().toISOString(),
      };
      if (!entry.text) return { error: 'empty text' };
      entries.unshift(entry);
      if (entries.length > max) entries = entries.slice(0, max);
      await flush();
      return entry;
    },
    async list({ tag, limit = 50 } = {}) {
      await ensure();
      let list = entries;
      if (tag) list = list.filter(e => e.tags?.includes(tag));
      return list.slice(0, limit);
    },
    async search({ query, limit = 5, tag }) {
      await ensure();
      let pool = entries;
      if (tag) pool = pool.filter(e => e.tags?.includes(tag));
      const scored = pool
        .map(e => ({ e, s: score(query, e.text) + 0.1 * (e.importance || 1) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(x => ({ ...x.e, score: Number(x.s.toFixed(4)) }));
      return scored;
    },
    async forget({ id, tag }) {
      await ensure();
      const before = entries.length;
      if (id)       entries = entries.filter(e => e.id !== id);
      else if (tag) entries = entries.filter(e => !e.tags?.includes(tag));
      else          return { removed: 0, error: 'need id or tag' };
      await flush();
      return { removed: before - entries.length };
    },
    async clear() {
      await ensure();
      const n = entries.length;
      entries = [];
      await flush();
      return { removed: n };
    },
    async all() {
      await ensure();
      return [...entries];
    },
  };
}
