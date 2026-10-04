import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCues } from '../src/sync/align.js';

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
