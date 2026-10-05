export const BIN = 0.1;
const RATIOS = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];

function fft(re, im, invert) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((invert ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (invert) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function rasterize(cues, n, ratio = 1, offset = 0) {
  const sig = new Float64Array(n);
  for (const c of cues) {
    const s = Math.max(0, Math.floor((c.start * ratio + offset) / BIN));
    const e = Math.min(n, Math.ceil((c.end * ratio + offset) / BIN));
    for (let i = s; i < e; i++) sig[i] = 1;
  }
  return sig;
}

// Reference: speech intervals plus the windows where the reference is known.
// Inside a window: speech = +1, silence = -1. Outside: 0 (unknown).
export function referenceSignal(ref, n) {
  const sig = new Float64Array(n);
  for (const [ws, we] of ref.windows) {
    for (let i = Math.max(0, Math.floor(ws / BIN)); i < Math.min(n, Math.ceil(we / BIN)); i++) sig[i] = -1;
  }
  for (const [s, e] of ref.speech) {
    for (let i = Math.max(0, Math.floor(s / BIN)); i < Math.min(n, Math.ceil(e / BIN)); i++) if (sig[i] !== 0) sig[i] = 1;
  }
  return sig;
}

// Cross-correlation of target against reference for all lags via FFT.
function correlate(refSig, tgtSig, size) {
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  ar.set(refSig);
  br.set(tgtSig);
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  return ar; // ar[lag] = sum ref[i+lag] * tgt[i] (circular)
}

function stats(arr, idxs) {
  let sum = 0;
  let sq = 0;
  for (const i of idxs) { sum += arr[i]; sq += arr[i] * arr[i]; }
  const mean = sum / idxs.length;
  return { mean, std: Math.sqrt(Math.max(1e-9, sq / idxs.length - mean * mean)) };
}

function scoreAt(refSig, cues, ratio, offset) {
  let score = 0;
  for (const c of cues) {
    const s = Math.max(0, Math.floor((c.start * ratio + offset) / BIN));
    const e = Math.min(refSig.length, Math.ceil((c.end * ratio + offset) / BIN));
    for (let i = s; i < e; i++) score += refSig[i];
  }
  return score;
}

function coveredBins(refSig, cues, ratio, offset) {
  let n = 0;
  for (const c of cues) {
    const s = Math.max(0, Math.floor((c.start * ratio + offset) / BIN));
    const e = Math.min(refSig.length, Math.ceil((c.end * ratio + offset) / BIN));
    for (let i = s; i < e; i++) if (refSig[i] !== 0) n++;
  }
  return n;
}

export function globalAlign(ref, cues, { maxShift = 600 } = {}) {
  const lastEnd = Math.max(...cues.map((c) => c.end), ...ref.windows.map((w) => w[1]));
  const n = Math.ceil((lastEnd * 1.05 + maxShift) / BIN) + 10;
  const refSig = referenceSignal(ref, n);
  let size = 1;
  while (size < n * 2) size <<= 1;
  const maxLag = Math.round(maxShift / BIN);
  let best = null;
  for (const ratio of RATIOS) {
    const corr = correlate(refSig, rasterize(cues, n, ratio), size);
    const lags = [];
    for (let l = -maxLag; l <= maxLag; l++) lags.push(l < 0 ? size + l : l);
    const { mean, std } = stats(corr, lags);
    for (let l = -maxLag; l <= maxLag; l++) {
      const v = corr[l < 0 ? size + l : l];
      if (!best || v > best.score) best = { ratio, offset: l * BIN, score: v, z: (v - mean) / std };
    }
  }
  const baseline = scoreAt(refSig, cues, 1, 0);
  return { ...best, baseline, refSig };
}

// Re-fit offsets per chunk so cuts / ad breaks / recaps are handled.
export function refineChunks(refSig, cues, ratio, offset, { chunk = 120, range = 30, minGain = 10 } = {}) {
  const out = cues.map((c) => ({ ...c }));
  const groups = [];
  let cur = [];
  for (const c of out) {
    if (cur.length && c.start - cur[0].start > chunk) { groups.push(cur); cur = []; }
    cur.push(c);
  }
  if (cur.length) groups.push(cur);
  const offsets = [];
  for (const g of groups) {
    const known = coveredBins(refSig, g, ratio, offset);
    const base = scoreAt(refSig, g, ratio, offset);
    let bestOff = offset;
    let bestScore = base;
    if (known >= 60) {
      for (let d = -range; d <= range; d += BIN) {
        const s = scoreAt(refSig, g, ratio, offset + d);
        if (s > bestScore) { bestScore = s; bestOff = offset + d; }
      }
    }
    const gain = bestScore - base;
    offsets.push(gain >= minGain && gain >= 0.25 * known ? bestOff : offset);
  }
  // A cut rarely falls on a chunk boundary: move each boundary between two different
  // offsets to the cue where the switch scores best, so lines near the cut follow it.
  const per = groups.map((g, gi) => g.map(() => offsets[gi]));
  for (let gi = 0; gi + 1 < groups.length; gi++) {
    const a = offsets[gi];
    const b = offsets[gi + 1];
    if (a === b) continue;
    const both = [...groups[gi], ...groups[gi + 1]];
    const sa = both.map((c) => scoreAt(refSig, [c], ratio, a));
    const sb = both.map((c) => scoreAt(refSig, [c], ratio, b));
    let tail = sb.reduce((x, y) => x + y, 0);
    let head = 0;
    let bestK = groups[gi].length;
    let best = -Infinity;
    for (let k = 0; k <= both.length; k++) {
      if (head + tail > best + 1e-9 || (Math.abs(head + tail - best) <= 1e-9 && Math.abs(k - groups[gi].length) < Math.abs(bestK - groups[gi].length))) {
        best = head + tail;
        bestK = k;
      }
      if (k < both.length) { head += sa[k]; tail -= sb[k]; }
    }
    const n1 = groups[gi].length;
    for (let k = 0; k < both.length; k++) {
      const v = k < bestK ? a : b;
      if (k < n1) per[gi][k] = v;
      else per[gi + 1][k - n1] = v;
    }
  }
  groups.forEach((g, gi) => {
    g.forEach((c, k) => {
      c.start = c.start * ratio + per[gi][k];
      c.end = c.end * ratio + per[gi][k];
    });
  });
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
    // Where the timeline jumps back at a cut, shorten the earlier line instead of stacking two lines.
    if (out[i - 1].end > out[i].start && out[i].start - out[i - 1].start >= 0.3) out[i - 1].end = out[i].start;
    if (out[i].end < out[i].start + 0.3) out[i].end = out[i].start + 0.3;
  }
  return { cues: out, offsets };
}

// Per-line offsets via Viterbi (alass-style): every line may take any offset within
// ±range of the global one, and changing offset between lines costs `penalty`, so the
// timeline only jumps where the reference clearly supports a cut.
export function refineLines(refSig, cues, ratio, offset, { range = 30, penalty = 150 } = {}) {
  const pre = new Float64Array(refSig.length + 1);
  for (let i = 0; i < refSig.length; i++) pre[i + 1] = pre[i] + refSig[i];
  const R = Math.round(range / BIN);
  const D = 2 * R + 1;
  const n = cues.length;
  const back = new Int32Array(n * D);
  let prev = new Float64Array(D);
  let cur = new Float64Array(D);
  const lineScore = (c, k) => {
    const off = offset + (k - R) * BIN;
    const s = Math.min(refSig.length, Math.max(0, Math.floor((c.start * ratio + off) / BIN)));
    const e = Math.min(refSig.length, Math.max(s, Math.ceil((c.end * ratio + off) / BIN)));
    return pre[e] - pre[s];
  };
  for (let k = 0; k < D; k++) prev[k] = lineScore(cues[0], k) - (k === R ? 0 : penalty);
  for (let i = 1; i < n; i++) {
    let bk = 0;
    for (let k = 1; k < D; k++) if (prev[k] > prev[bk]) bk = k;
    const jump = prev[bk] - penalty;
    for (let k = 0; k < D; k++) {
      const stay = prev[k];
      if (stay >= jump) { cur[k] = stay; back[i * D + k] = k; } else { cur[k] = jump; back[i * D + k] = bk; }
      cur[k] += lineScore(cues[i], k);
    }
    [prev, cur] = [cur, prev];
  }
  let k = 0;
  for (let j = 1; j < D; j++) if (prev[j] > prev[k] || (prev[j] === prev[k] && Math.abs(j - R) < Math.abs(k - R))) k = j;
  const offs = new Array(n);
  for (let i = n - 1; i >= 0; i--) { offs[i] = offset + (k - R) * BIN; if (i) k = back[i * D + k]; }
  const out = cues.map((c, i) => ({ ...c, start: c.start * ratio + offs[i], end: c.end * ratio + offs[i] }));
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
    if (out[i - 1].end > out[i].start && out[i].start - out[i - 1].start >= 0.3) out[i - 1].end = out[i].start;
    if (out[i].end < out[i].start + 0.3) out[i].end = out[i].start + 0.3;
  }
  const offsets = [];
  offs.forEach((o, i) => { if (!i || Math.abs(o - offs[i - 1]) > 1e-9) offsets.push([Number(cues[i].start.toFixed(1)), Number(o.toFixed(1))]); });
  return { cues: out, offsets };
}

// Lines whose start is not near any reference line start, grouped into runs; a run of
// several such lines means a stretch that is still out of sync.
export function driftReport(ref, cues, { tol = 1, minRun = 3 } = {}) {
  const starts = ref.speech.map(([s]) => s).sort((a, b) => a - b);
  const known = (t) => ref.windows.some(([a, b]) => t >= a && t <= b);
  const near = (t) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m] < t) lo = m + 1; else hi = m; }
    return Math.min(Math.abs(starts[lo] - t), lo ? Math.abs(starts[lo - 1] - t) : Infinity);
  };
  let checked = 0, good = 0;
  const runs = [];
  let run = [];
  for (const c of cues) {
    if (!known(c.start)) continue;
    checked++;
    if (near(c.start) <= tol) { good++; if (run.length >= minRun) runs.push([run[0], run.at(-1)]); run = []; } else run.push(c.start);
  }
  if (run.length >= minRun) runs.push([run[0], run.at(-1)]);
  return { matched: checked ? good / checked : null, drift: runs.map(([a, b]) => [Number(a.toFixed(1)), Number(b.toFixed(1))]) };
}

const ONSET = 0.5;

// Translations often merge or stretch lines, which blurs interval overlap. Matching only
// where lines start is insensitive to line length, so it is tried when overlap fails.
function onsetSync(ref, cues) {
  const ref2 = { ...ref, speech: ref.speech.map(([s]) => [s, s + ONSET]) };
  const cues2 = cues.map((c) => ({ ...c, end: c.start + ONSET }));
  const g = globalAlign(ref2, cues2);
  if (g.z < 6) return { g, cues: null };
  const { cues: r2, offsets } = refineLines(g.refSig, cues2, g.ratio, g.offset, { penalty: 30 });
  const out = cues.map((c, i) => ({ ...c, start: r2[i].start, end: r2[i].start + (c.end - c.start) * g.ratio }));
  for (let i = 1; i < out.length; i++) if (out[i].end < out[i].start + 0.3) out[i].end = out[i].start + 0.3;
  return { g, cues: out, offsets };
}

export function syncCues(ref, cues) {
  if (!cues.length || !ref.speech.length) return { cues, confident: false };
  const g = globalAlign(ref, cues);
  if (g.z >= 6) {
    const { cues: refined, offsets } = refineLines(g.refSig, cues, g.ratio, g.offset);
    return { cues: refined, confident: true, method: 'overlap', offsets, ...strip(g) };
  }
  const o = onsetSync(ref, cues);
  if (o.cues) return { cues: o.cues, confident: true, method: 'onset', offsets: o.offsets, ...strip(o.g) };
  return { cues, confident: false, ...strip(g.z >= o.g.z ? g : o.g) };
}

function strip(g) {
  return { ratio: g.ratio, offset: g.offset, z: g.z, score: g.score, baseline: g.baseline };
}
