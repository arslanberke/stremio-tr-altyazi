// Cue timings of an MP4 text track read from the file's index (moov) alone, so a large
// remote file isn't streamed: a non-empty tx3g sample is a line on screen.

function* boxes(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    let head = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); head = 16; } else if (size === 0) size = end - p;
    if (size < head || p + size > end) return;
    yield { type: buf.toString('latin1', p + 4, p + 8), start: p + head, end: p + size };
    p += size;
  }
}

const child = (buf, box, type) => box && [...boxes(buf, box.start, box.end)].find((b) => b.type === type);
const path = (buf, box, ...types) => types.reduce((b, t) => child(buf, b, t), box);

async function fetchRange(url, a, b, timeoutMs) {
  const res = await fetch(url, { headers: { Range: `bytes=${a}-${b}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 206) throw new Error(`range HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function readMoov(url, fileSize, timeoutMs) {
  let off = 0;
  for (let i = 0; i < 16 && off < fileSize; i++) {
    const h = await fetchRange(url, off, off + 15, timeoutMs);
    let size = h.readUInt32BE(0);
    if (size === 1) size = Number(h.readBigUInt64BE(8));
    const type = h.toString('latin1', 4, 8);
    if (type === 'moov') return size > 64e6 ? null : fetchRange(url, off, off + size - 1, timeoutMs);
    if (size < 8) return null;
    off += size;
  }
  return null;
}

export function textTrackCues(moov, trackIndex) {
  const root = [...boxes(moov, 0, moov.length)].find((b) => b.type === 'moov');
  if (!root) return null;
  const mvhd = child(moov, root, 'mvhd');
  const movieScale = moov.readUInt32BE(mvhd.start + (moov[mvhd.start] === 1 ? 20 : 12));
  const trak = [...boxes(moov, root.start, root.end)].filter((b) => b.type === 'trak')[trackIndex];
  const mdhd = path(moov, trak, 'mdia', 'mdhd');
  const stbl = path(moov, trak, 'mdia', 'minf', 'stbl');
  const stts = child(moov, stbl, 'stts');
  const stsz = child(moov, stbl, 'stsz');
  if (!mdhd || !stts || !stsz) return null;
  const scale = moov.readUInt32BE(mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12));
  // Edit list: an empty edit delays the track, a media time skips into it.
  let shift = 0;
  const elst = path(moov, trak, 'edts', 'elst');
  if (elst) {
    const v1 = moov[elst.start] === 1;
    const n = moov.readUInt32BE(elst.start + 4);
    let p = elst.start + 8;
    for (let i = 0; i < n; i++, p += v1 ? 20 : 12) {
      const dur = v1 ? Number(moov.readBigUInt64BE(p)) : moov.readUInt32BE(p);
      const mt = v1 ? Number(moov.readBigInt64BE(p + 8)) : moov.readInt32BE(p + 4);
      if (mt === -1) shift += dur / movieScale;
      else { shift -= mt / scale; break; }
    }
  }
  const fixed = moov.readUInt32BE(stsz.start + 4);
  const count = moov.readUInt32BE(stsz.start + 8);
  const size = (i) => fixed || moov.readUInt32BE(stsz.start + 12 + i * 4);
  const cues = [];
  let t = 0;
  let s = 0;
  const entries = moov.readUInt32BE(stts.start + 4);
  for (let e = 0, p = stts.start + 8; e < entries; e++, p += 8) {
    const n = moov.readUInt32BE(p);
    const delta = moov.readUInt32BE(p + 4);
    for (let k = 0; k < n && s < count; k++, s++, t += delta) {
      if (size(s) > 2) cues.push({ start: t / scale + shift, end: (t + delta) / scale + shift });
    }
  }
  return cues;
}

export async function mp4TextCues(url, fileSize, trackIndex, timeoutMs = 60000) {
  const moov = await readMoov(url, fileSize, timeoutMs);
  return moov ? textTrackCues(moov, trackIndex) : null;
}
