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

const fullTime = (t) => (t.split(':').length === 2 ? `00:${t}` : t);

// Line-based so a missing blank line between cues doesn't swallow the next cue into the previous one.
function parseSrtLike(text) {
  const cues = [];
  let cur = null;
  const lines = text.replace(/\r/g, '').split('\n');
  const push = () => {
    if (!cur) return;
    while (cur.body.length && cur.body[cur.body.length - 1].trim() === '') cur.body.pop();
    const body = cur.body.join('\n').trim();
    if (Number.isFinite(cur.start) && Number.isFinite(cur.end) && body) cues.push({ start: cur.start, end: Math.max(cur.end, cur.start + 0.1), text: body });
  };
  for (const line of lines) {
    if (line.includes('-->')) {
      const [a, b] = line.split('-->');
      const start = srtTime(fullTime(a.trim()));
      const end = srtTime(fullTime((b || '').trim().split(/\s/)[0]));
      if (Number.isFinite(start) && Number.isFinite(end)) {
        if (cur && /^\s*\d+\s*$/.test(cur.body[cur.body.length - 1] || '')) cur.body.pop();
        push();
        cur = { start, end, body: [] };
        continue;
      }
    }
    if (!cur) continue;
    if (line.trim() === '') { cur.body.push(''); continue; }
    cur.body.push(line);
  }
  push();
  return cues.map((c) => ({ ...c, text: c.text.split('\n').filter((l) => l.trim() !== '').join('\n') }));
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

// Keep each line up long enough to read (~15 chars/s, as in professional subtitling guidelines),
// by extending its end into the silence before the next line; start times stay on the speech.
export function extendForReading(cues, { cps = 15, min = 1.2, gap = 0.1, max = 7 } = {}) {
  return cues.map((c, i) => {
    const need = Math.min(max, Math.max(min, c.text.replace(/\s+/g, '').length / cps));
    if (c.end - c.start >= need) return c;
    const next = cues[i + 1];
    const limit = next ? Math.max(c.end, next.start - gap) : Infinity;
    return { ...c, end: Math.min(c.start + need, limit) };
  });
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
