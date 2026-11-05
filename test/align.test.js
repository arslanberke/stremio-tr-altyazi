import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCues, snapLines, keepOrder, keepEvidence, keepCut, keepEpisode, referenceSignal, coverage, BIN } from '../src/sync/align.js';

function randomCues(n, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const cues = [];
  let t = 10;
  for (let i = 0; i < n; i++) {
    t += 1 + rnd() * 6;
    const d = 1 + rnd() * 3;
    cues.push({ start: t, end: t + d, text: `l${i}` });
    t += d;
  }
  return cues;
}

const asRef = (cues, windows) => ({ windows: windows || [[0, cues[cues.length - 1].end + 5]], speech: cues.map((c) => [c.start, c.end]) });

test('fixes constant offset', () => {
  const truth = randomCues(600);
  const shifted = truth.map((c) => ({ ...c, start: c.start + 4.5, end: c.end + 4.5 }));
  const r = syncCues(asRef(truth), shifted);
  assert.ok(r.confident);
  assert.ok(Math.abs(r.cues[100].start - truth[100].start) < 0.25);
});

test('fixes 25 vs 23.976 fps drift', () => {
  const truth = randomCues(900);
  const k = 23.976 / 25;
  const wrong = truth.map((c) => ({ ...c, start: c.start * k + 2, end: c.end * k + 2 }));
  const r = syncCues(asRef(truth), wrong);
  assert.ok(r.confident);
  for (const i of [50, 400, 850]) assert.ok(Math.abs(r.cues[i].start - truth[i].start) < 0.3, `cue ${i}`);
});

test('works with sparse reference windows and a cut', () => {
  const truth = randomCues(900);
  const end = truth[truth.length - 1].end;
  const windows = Array.from({ length: 8 }, (_, i) => [i * end / 8, i * end / 8 + 150]);
  const sparse = truth.filter((c) => windows.some(([a, b]) => c.start >= a && c.end <= b));
  const cut = end / 2;
  const target = truth.map((c) => (c.start > cut ? { ...c, start: c.start + 8, end: c.end + 8 } : { ...c }));
  const r = syncCues(asRef(sparse, windows), target);
  assert.ok(r.confident);
  const late = truth.findIndex((c) => c.start > cut + 400);
  assert.ok(Math.abs(r.cues[late].start - truth[late].start) < 0.3);
});

test('reports low confidence on unrelated subtitles', () => {
  const r = syncCues(asRef(randomCues(500, 3)), randomCues(500, 99));
  assert.equal(r.confident, false);
});

test('syncs a translation whose lines are merged and held longer', () => {
  const ref = { windows: [[0, 1300]], speech: [] };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 10; t < 1200; t += 1.5 + rnd() * 6) ref.speech.push([t, t + 0.8 + rnd() * 1.5]);
  const merged = [];
  for (let i = 0; i < ref.speech.length; i += 2) {
    const [s] = ref.speech[i];
    merged.push({ start: s + 4, end: s + 4 + 5.5, text: 'x' });
  }
  const r = syncCues(ref, merged);
  assert.equal(r.confident, true);
  assert.ok(Math.abs(r.cues[10].start - ref.speech[20][0]) < 0.3);
});

test('follows a cut that falls inside a chunk without stacking lines', () => {
  const truth = randomCues(400);
  const cut = 650;
  const subs = truth.map((c) => (c.start < cut ? { ...c, start: c.start - 3.9, end: c.end - 3.9 } : { ...c }));
  const r = syncCues(asRef(truth), subs);
  assert.ok(r.confident);
  const after = truth.findIndex((c) => c.start >= cut);
  for (let i = after - 3; i < after + 6; i++) assert.ok(Math.abs(r.cues[i].start - truth[i].start) < 0.3, `cue ${i}`);
  for (let i = 1; i < r.cues.length; i++) assert.ok(r.cues[i].start >= r.cues[i - 1].end - 1e-9 || r.cues[i].start - r.cues[i - 1].start < 0.3, `stack ${i}`);
});

test('a run of lines thrown before the line above it is put back on its neighbours\' offset', () => {
  const cues = [[0, 4], [12, 16], [23, 27], [27, 31], [31, 34], [38, 40]].map(([start, end]) => ({ start, end }));
  const offs = [-12, -12, -24, -24, -24, -12];
  keepOrder(cues, offs);
  assert.deepEqual(offs, [-12, -12, -12, -12, -12, -12]);
});

test('a real cut (offset never returns) is left alone', () => {
  const cues = [[0, 4], [12, 16], [23, 27], [27, 31]].map(([start, end]) => ({ start, end }));
  const offs = [-12, -12, -24, -24];
  keepOrder(cues, offs);
  assert.deepEqual(offs, [-12, -12, -24, -24]);
});

test('lines that jump without landing on reference speech of their own keep the previous offset', () => {
  // Reference has speech until 100 s, then nothing (e.g. an ending song it doesn't subtitle).
  const refSig = new Float64Array(2000).fill(-1);
  for (let i = 0; i < 100 / BIN; i++) refSig[i] = 1;
  const cues = [[80, 88], [92, 107], [130, 133], [133, 136], [140, 143], [150, 153]].map(([start, end]) => ({ start, end }));
  const offs = [-10, -10, -40, -40, 20, 20];
  keepEvidence(refSig, cues, offs);
  assert.deepEqual(offs, [-10, -10, -10, -10, -10, -10]);
});

test('a jump onto new reference speech is kept', () => {
  const refSig = new Float64Array(2000).fill(-1);
  for (let i = 0; i < 200 / BIN; i++) refSig[i] = 1;
  const cues = [[80, 88], [92, 95], [130, 133], [140, 143]].map(([start, end]) => ({ start, end }));
  const offs = [-10, -10, 20, 20];
  keepEvidence(refSig, cues, offs);
  assert.deepEqual(offs, [-10, -10, 20, 20]);
});

test('coverage: lines shown too briefly leave dialogue uncovered', () => {
  const ref = { windows: [[0, 100]], speech: [[10, 13], [20, 23], [30, 33]] };
  const full = [{ start: 10, end: 13 }, { start: 20, end: 23 }, { start: 30, end: 33 }];
  const brief = [{ start: 11.5, end: 12.7 }, { start: 21.5, end: 22.7 }, { start: 31.5, end: 32.7 }];
  assert.equal(coverage(ref, full), 1);
  assert.ok(Math.abs(coverage(ref, brief) - 0.4) < 1e-9);
  assert.equal(coverage({ windows: [[200, 300]], speech: [[10, 13]] }, full), null);
});

test('lines before a cut that collide with the lines after it take the post-cut offset', () => {
  const ref = { windows: [[0, 200]], speech: [[100, 102], [118, 120], [136, 138], [154, 156], [172, 174]] };
  const refSig = referenceSignal(ref, Math.ceil(200 / BIN));
  // 18 s were cut after line 0; lines 1-2 also fit the old offset by chance (same spacing).
  const cues = [100, 136, 154, 172, 190].map((t, i) => ({ start: t, end: t + 2, text: `l${i}` }));
  const offs = [0, 0, 0, -18, -18];
  keepCut(refSig, cues, offs);
  assert.deepEqual(offs, [0, -18, -18, -18, -18]);
});

test('a cut is left alone when the lines before it do not fit the post-cut offset', () => {
  const ref = { windows: [[0, 200]], speech: [[100, 102], [136, 138], [154, 156], [172, 174]] };
  const refSig = referenceSignal(ref, Math.ceil(200 / BIN));
  const cues = [100, 136, 154, 172, 190].map((t, i) => ({ start: t, end: t + 2, text: `l${i}` }));
  const offs = [0, 0, 0, -18, -18];
  keepCut(refSig, cues, offs);
  assert.deepEqual(offs, [0, 0, 0, -18, -18]);
});

test('a multi-episode file drops the offset run that belongs to the next episode', () => {
  const cues = [10, 20, 30, 1400, 1410, 1420, 1430, 1440].map((t) => ({ start: t, end: t + 2, text: String(t) }));
  const offsets = [[10, -5], [1400, -120]];
  const aligned = cues.map((c, i) => ({ ...c, start: c.start + (i < 3 ? -5 : -120), end: c.end + (i < 3 ? -5 : -120) }));
  const kept = keepEpisode(cues, aligned, offsets, 1300);
  assert.deepEqual(kept.map((c) => c.text), ['10', '20', '30']);
});

test('the previous episode at the start of a multi-episode file does not drop this one', () => {
  const cues = [10, 20, 30, 1400, 1410, 1420].map((t) => ({ start: t, end: t + 2, text: String(t) }));
  const aligned = cues.map((c) => ({ ...c, start: c.start - 1350, end: c.end - 1350 }));
  const kept = keepEpisode(cues, aligned, [[10, -1350]], 1300);
  assert.equal(kept.length, 6);
});

test('snaps sloppily timed lines onto the reference lines after syncing', () => {
  const truth = randomCues(300);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const sloppy = truth.map((c) => { const j = (rnd() - 0.5) * 1.6; return { ...c, start: c.start + 5 + j, end: c.end + 5 + j }; });
  const r = syncCues(asRef(truth), sloppy);
  assert.equal(r.confident, true);
  const before = sloppy.filter((c, i) => Math.abs(c.start - 5 - truth[i].start) > 0.3).length;
  const after = r.cues.filter((c, i) => Math.abs(c.start - truth[i].start) > 0.3).length;
  assert.ok(before > 100, `jitter present: ${before}`);
  assert.ok(after < 15, `lines still off after snapping: ${after}`);
  assert.ok(r.snapped > 250, `snapped ${r.snapped}`);
  for (let i = 1; i < r.cues.length; i++) assert.ok(r.cues[i].start >= r.cues[i - 1].start && r.cues[i].end > r.cues[i].start);
});

test('snapLines keeps lines the reference has no line for, and does not touch audio references', () => {
  const ref = asRef([{ start: 10, end: 12 }, { start: 20, end: 22 }, { start: 30, end: 32 }]);
  const cues = [{ start: 10.4, end: 12.3, text: 'a' }, { start: 15, end: 17, text: 'lyrics' }, { start: 20.3, end: 21.8, text: 'b' }];
  const { cues: out, snapped } = snapLines(ref, cues);
  assert.equal(snapped, 2);
  assert.deepEqual(out.map((c) => [c.start, c.end]), [[10, 12], [15, 17], [20, 22]]);
  assert.deepEqual(snapLines({ ...ref, kind: 'audio' }, cues).cues, cues);
});

test('snapLines leaves a line alone when two reference lines are equally close', () => {
  const ref = asRef([{ start: 10, end: 10.4 }, { start: 10.8, end: 11.5 }, { start: 20, end: 22 }]);
  const cues = [{ start: 10.4, end: 11.4, text: 'between' }, { start: 20.5, end: 22, text: 'b' }];
  const { cues: out } = snapLines(ref, cues);
  assert.equal(out[0].start, 10.4);
  assert.equal(out[1].start, 20);
});

test('snapLines gives a reference line to the nearest cue only and never reorders or overlaps lines', () => {
  const ref = asRef([{ start: 10, end: 12 }, { start: 20, end: 22 }]);
  // Two cues near one reference line (a split translation): only the closer one snaps.
  const split = [{ start: 10.3, end: 11, text: 'a1' }, { start: 11, end: 12.2, text: 'a2' }, { start: 20.2, end: 22, text: 'b' }];
  const r1 = snapLines(ref, split).cues;
  assert.equal(r1[0].start, 10);
  assert.equal(r1[1].start, 11);
  assert.equal(r1[2].start, 20);
  // A translation merging two reference lines keeps covering both.
  const merged = [{ start: 10.5, end: 21.5, text: 'ab' }];
  assert.deepEqual(snapLines(ref, merged).cues.map((c) => [c.start, c.end]), [[10, 22]]);
  // A snap that would push a line under its neighbour is skipped.
  const tight = [{ start: 9.2, end: 10.6, text: 'x' }, { start: 10.7, end: 12, text: 'a' }];
  const r2 = snapLines(ref, tight).cues;
  assert.equal(r2[0].start, 9.2);
  assert.equal(r2[1].start, 10.7);
});
