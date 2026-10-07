import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const mem = new Map();
const inflight = new Map();

// Downloads count against provider quotas and the server's disk is wiped on every
// deploy, so these namespaces are also kept in Supabase Storage.
const PERSIST = new Set(['os-file', 'subdl-file', 'subsource-file', 'altyazidb-file', 'mt', 'out', 'ref']);
const BUCKET = 'stremio-cache';

function remoteUrl(ns, key) {
  const h = crypto.createHash('sha1').update(key).digest('hex');
  return `${config.storeUrl}/storage/v1/object/${BUCKET}/${ns}/${h}.json`;
}

const storeHeaders = () => ({ apikey: config.storeKey, Authorization: `Bearer ${config.storeKey}` });
const remoteOn = (ns) => Boolean(config.storeUrl && config.storeKey && PERSIST.has(ns));

async function remoteGet(ns, key) {
  if (!remoteOn(ns)) return null;
  try {
    const res = await fetch(remoteUrl(ns, key), { headers: storeHeaders(), signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function remotePut(ns, key, d) {
  if (!remoteOn(ns)) return;
  try {
    const res = await fetch(remoteUrl(ns, key), {
      method: 'POST',
      headers: { ...storeHeaders(), 'Content-Type': 'application/json', 'x-upsert': 'true' },
      body: JSON.stringify(d),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error('store put', ns, res.status);
  } catch (e) {
    console.error('store put', ns, e.message);
  }
}

function file(ns, key) {
  const h = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(config.cacheDir, ns, `${h}.json`);
}

export async function cached(ns, key, ttlSec, fn, keep = () => true) {
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
    const r = await remoteGet(ns, key);
    if (r && r.exp > Date.now()) {
      mem.set(k, r);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, JSON.stringify(r));
      return r.value;
    }
    const value = await fn();
    if (!keep(value)) return value;
    const d = { exp: Date.now() + ttlSec * 1000, value };
    mem.set(k, d);
    if (mem.size > 2000) mem.delete(mem.keys().next().value);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, JSON.stringify(d));
    await remotePut(ns, key, d);
    return value;
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
