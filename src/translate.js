import crypto from 'node:crypto';
import { cached } from './cache.js';

const URL = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=tr';
const MAX_CHARS = 4000;

async function translateBatch(lines) {
  const body = new URLSearchParams();
  for (const l of lines) body.append('q', l);
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
  const out = await res.json();
  if (!Array.isArray(out) || out.length !== lines.length) throw new Error('translate: unexpected response');
  return out.map((x) => (Array.isArray(x) ? x[0] : x));
}

export async function translateLines(lines) {
  const key = crypto.createHash('sha1').update(lines.join('\u0000')).digest('hex');
  return cached('mt', key, 90 * 86400, async () => {
    const batches = [[]];
    let size = 0;
    for (const l of lines) {
      if (size + l.length > MAX_CHARS && batches.at(-1).length) {
        batches.push([]);
        size = 0;
      }
      batches.at(-1).push(l);
      size += l.length;
    }
    const out = [];
    for (const b of batches) out.push(...await translateBatch(b));
    return out;
  });
}
