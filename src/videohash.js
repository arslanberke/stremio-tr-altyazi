import { fetchBuffer } from './http.js';

const CHUNK = 65536;

// OpenSubtitles hash: file size plus the 64-bit little-endian sums of the first and last 64 KiB.
export function osHashOf(head, tail, size) {
  let h = BigInt(size);
  for (const b of [head, tail]) for (let i = 0; i + 8 <= b.length; i += 8) h = (h + b.readBigUInt64LE(i)) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, '0');
}

export async function osHash(url, size) {
  if (!size || size < CHUNK) return null;
  const part = (from) => fetchBuffer(url, { headers: { Range: `bytes=${from}-${from + CHUNK - 1}` } });
  const [head, tail] = await Promise.all([part(0), part(size - CHUNK)]);
  if (head.length !== CHUNK || tail.length !== CHUNK) return null;
  return osHashOf(head, tail, size);
}
