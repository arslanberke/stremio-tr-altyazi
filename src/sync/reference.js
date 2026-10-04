import { spawn } from 'node:child_process';
import { parseSubtitle } from '../subformat.js';

const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

function run(cmd, args, { timeoutMs = 30000, onData, maxBytes = Infinity } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      p.kill('SIGKILL');
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(finish, timeoutMs);
    p.stdout.on('data', (d) => {
      chunks.push(d);
      size += d.length;
      if (size >= maxBytes || (onData && onData(Buffer.concat(chunks)) === 'stop')) finish();
    });
    p.stderr.on('data', () => {});
    p.on('close', finish);
    p.on('error', finish);
  });
}

export async function probe(url) {
  const out = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', url], { timeoutMs: 20000 });
  try { return JSON.parse(out.toString('utf8')); } catch { return null; }
}

function lang(s) {
  return (s.tags?.language || '').toLowerCase();
}

export function pickSubtitleStream(streams) {
  const subs = streams.filter((s) => s.codec_type === 'subtitle' && TEXT_CODECS.has(s.codec_name));
  const ok = subs.filter((s) => !s.disposition?.forced && !/forced|sign|song/i.test(s.tags?.title || ''));
  const rank = (s) => (lang(s).startsWith('en') ? 0 : lang(s).startsWith('tr') ? 2 : 1);
  return ok.sort((a, b) => rank(a) - rank(b))[0] || null;
}

export function pickAudioStream(streams) {
  const a = streams.filter((s) => s.codec_type === 'audio');
  return a.find((s) => s.disposition?.default) || a.find((s) => lang(s).startsWith('en')) || a[0] || null;
}

export function planWindows(duration, count, len) {
  if (!duration || duration < len * 2) return [[0, Math.max(duration || 0, len)]];
  const lo = duration * 0.03;
  const hi = duration * 0.97 - len;
  const step = (hi - lo) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => [lo + i * step, lo + i * step + len]);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function subWindow(url, index, [ws, we]) {
  const args = ['-v', 'error', '-ss', String(ws), '-copyts', '-i', url, '-map', `0:${index}`, '-f', 'srt', 'pipe:1'];
  const buf = await run('ffmpeg', args, {
    timeoutMs: 25000,
    onData: (b) => {
      const cues = parseSubtitle(b.toString('utf8'));
      return cues.length && cues[cues.length - 1].start > we ? 'stop' : null;
    },
  });
  const cues = parseSubtitle(buf.toString('utf8')).filter((c) => c.start >= ws && c.start <= we);
  return cues.length ? { window: [Math.max(ws, cues[0].start - 1), we], cues } : null;
}

export function vad(samples, rate, offset) {
  const frame = Math.round(rate * 0.03);
  const energies = [];
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let e = 0;
    for (let k = i; k < i + frame; k++) e += samples[k] * samples[k];
    energies.push(10 * Math.log10(e / frame + 1e-9));
  }
  if (!energies.length) return [];
  const sorted = [...energies].sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  const thr = q(0.2) + 0.45 * (q(0.95) - q(0.2));
  const segs = [];
  let start = null;
  energies.forEach((e, i) => {
    const t = offset + i * 0.03;
    if (e > thr && start == null) start = t;
    if (e <= thr && start != null) { segs.push([start, t]); start = null; }
  });
  if (start != null) segs.push([start, offset + energies.length * 0.03]);
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] < 0.35) last[1] = s[1];
    else merged.push([...s]);
  }
  return merged.filter(([a, b]) => b - a >= 0.25);
}

async function audioWindow(url, index, [ws, we]) {
  const rate = 8000;
  const args = ['-v', 'error', '-ss', String(ws), '-t', String(we - ws), '-i', url, '-map', `0:${index}`,
    '-ac', '1', '-ar', String(rate), '-af', 'highpass=f=250,lowpass=f=3000', '-f', 's16le', 'pipe:1'];
  const buf = await run('ffmpeg', args, { timeoutMs: 30000 });
  if (buf.length < rate * 2 * 5) return null;
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  return { window: [ws, ws + samples.length / rate], speech: vad(samples, rate, ws) };
}

// Timing reference from the actual video: embedded text subtitles first, then speech in the audio.
export async function referenceFromVideo(url) {
  const info = await probe(url);
  if (!info?.streams) return null;
  const duration = Number(info.format?.duration) || 0;
  const vStream = info.streams.find((s) => s.codec_type === 'video');
  const fps = vStream?.avg_frame_rate ? eval(vStream.avg_frame_rate.replace(/[^\d/.]/g, '') || '0') : null; // eslint-disable-line no-eval
  const sub = pickSubtitleStream(info.streams);
  if (sub) {
    const res = (await pool(planWindows(duration, 8, 150), 4, (w) => subWindow(url, sub.index, w))).filter(Boolean);
    const cues = res.flatMap((r) => r.cues);
    if (cues.length >= 20) {
      return { kind: 'embedded', lang: lang(sub), duration, fps, windows: res.map((r) => r.window), speech: cues.map((c) => [c.start, c.end]) };
    }
  }
  const audio = pickAudioStream(info.streams);
  if (!audio) return null;
  const res = (await pool(planWindows(duration, 12, 90), 4, (w) => audioWindow(url, audio.index, w))).filter(Boolean);
  const speech = res.flatMap((r) => r.speech);
  if (speech.length < 30) return null;
  return { kind: 'audio', duration, fps, windows: res.map((r) => r.window), speech };
}

export function referenceFromSubtitle(cues, kind = 'subtitle') {
  if (cues.length < 20) return null;
  const end = cues[cues.length - 1].end;
  return { kind, windows: [[0, end + 5]], speech: cues.map((c) => [c.start, c.end]) };
}
