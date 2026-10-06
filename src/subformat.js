import iconv from 'iconv-lite';

export function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf.subarray(2), 'utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf.subarray(2), 'utf16be');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return iconv.decode(buf, 'windows-1254');
  }
}

function srtTime(t) {
  const m = t.trim().match(/(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/);
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

function parseSrtLike(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = srtTime(a.includes(':') && a.trim().split(':').length === 2 ? `00:${a}` : a);
    const end = srtTime(b.trim().split(/\s/)[0].split(':').length === 2 ? `00:${b.trim().split(/\s/)[0]}` : b.trim().split(/\s/)[0]);
    const body = lines.slice(i + 1).join('\n');
    if (Number.isFinite(start) && Number.isFinite(end) && body) cues.push({ start, end: Math.max(end, start + 0.1), text: body });
  }
  return cues;
}

function assTime(t) {
  const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[.,](\d{2})/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : NaN;
}

function parseAss(text) {
  const cues = [];
  let format = null;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^Format:/i.test(line) && !format) {
      const f = line.slice(7).split(',').map((s) => s.trim().toLowerCase());
      if (f.includes('start') && f.includes('text')) format = f;
    } else if (/^Dialogue:/i.test(line)) {
      const f = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
      const parts = line.slice(9).split(',');
      const textIdx = f.indexOf('text');
      const fields = parts.slice(0, textIdx);
      const body = parts.slice(textIdx).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim();
      const start = assTime(fields[f.indexOf('start')] || '');
      const end = assTime(fields[f.indexOf('end')] || '');
      if (body && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text: body });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

function parseMicroDvd(text, fps) {
  const cues = [];
  let rate = fps || 23.976;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = line.match(/^\{(\d+)\}\{(\d*)\}(.*)$/);
    if (!m) continue;
    const body = m[3].replace(/\{[^}]*\}/g, '').replace(/\|/g, '\n').trim();
    if (Number(m[1]) <= 1 && /^\d+(\.\d+)?$/.test(body)) {
      rate = Number(body);
      continue;
    }
    const start = Number(m[1]) / rate;
    const end = m[2] ? Number(m[2]) / rate : start + 2;
    if (body) cues.push({ start, end, text: body });
  }
  return cues;
}

export function parseSubtitle(text, { fps } = {}) {
  const t = text.replace(/^\uFEFF/, '');
  if (/^\s*\[Script Info\]/i.test(t) || /^Dialogue:/im.test(t)) return parseAss(t);
  if (/^\s*\{\d+\}\{\d*\}/m.test(t)) return parseMicroDvd(t, fps);
  return parseSrtLike(t.replace(/^WEBVTT[^\n]*\n/, ''));
}

function fmt(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

// TV players stack overlapping cues unpredictably (lines swap places, flicker). Turn overlaps
// (e.g. a long sign over dialogue) into consecutive cues that show all active lines in a fixed order.
export function flattenOverlaps(cues, { snap = 0.25 } = {}) {
  const list = cues.filter((c) => c.end > c.start).map((c, i) => ({ ...c, i })).sort((a, b) => a.start - b.start || a.i - b.i);
  if (!list.some((c, k) => k && c.start < list[k - 1].end)) return list.map(({ i, ...c }) => c);
  const times = [...new Set(list.flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
  const snapTo = new Map();
  let head = times[0];
  for (const t of times) { if (t - head > snap) head = t; snapTo.set(t, head); }
  const span = list.map((c) => ({ ...c, start: snapTo.get(c.start), end: snapTo.get(c.end) })).filter((c) => c.end > c.start);
  const cuts = [...new Set(span.flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const [a, b] = [cuts[k], cuts[k + 1]];
    const text = span.filter((c) => c.start <= a && c.end >= b).map((c) => c.text).join('\n');
    if (!text) continue;
    const last = out.at(-1);
    if (last && last.text === text && last.end === a) last.end = b;
    else out.push({ start: a, end: b, text });
  }
  return out;
}

export function toSrt(cues) {
  return cues
    .filter((c) => c.end > 0)
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`)
    .join('\n');
}

export function isSubtitleFile(name) {
  return /\.(srt|ass|ssa|sub|vtt|txt)$/i.test(name);
}
