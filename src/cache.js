import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const mem = new Map();
const inflight = new Map();

function file(ns, key) {
  const h = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(config.cacheDir, ns, `${h}.json`);
}

export async function cached(ns, key, ttlSec, fn) {
  const k = `${ns}:${key}`;
  const m = mem.get(k);
  if (m && m.exp > Date.now()) return m.value;
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    const f = file(ns, key);
    try {
      const d = JSON.parse(await fs.readFile(f, 'utf8'));
      if (d.exp > Date.now()) {
        mem.set(k, d);
        return d.value;
      }
    } catch {}
    const value = await fn();
    const d = { exp: Date.now() + ttlSec * 1000, value };
    mem.set(k, d);
    if (mem.size > 2000) mem.delete(mem.keys().next().value);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, JSON.stringify(d));
    return value;
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
