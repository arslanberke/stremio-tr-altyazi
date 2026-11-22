import test from 'node:test';
import assert from 'node:assert/strict';
import { cuesFromImagePackets, pickAudioStream, planWindows, subtitleWindow } from '../src/sync/reference.js';

test('reads line timing from image subtitle packets', () => {
  const cues = cuesFromImagePackets([[9.676, 4325], [10.41, 30], [16.917, 13603], [19.553, 30], [20.554, 16111], [22.756, 30]]);
  assert.deepEqual(cues.map((c) => [c.start, c.end]), [[9.676, 10.41], [16.917, 19.553], [20.554, 22.756]]);
});

test('prefers original Japanese audio over an English dub', () => {
  const s = [
    { index: 1, codec_type: 'audio', tags: { language: 'eng' }, disposition: { default: 1 } },
    { index: 2, codec_type: 'audio', tags: { language: 'jpn' }, disposition: { default: 0 } },
  ];
  assert.equal(pickAudioStream(s).index, 2);
});

test('a subtitle read cut off by the timeout only covers up to its last line', () => {
  const cues = [{ start: 50, end: 52 }, { start: 80, end: 83 }, { start: 400, end: 401 }];
  assert.deepEqual(subtitleWindow(cues, 40, 190, true).window, [49, 84]);
  assert.deepEqual(subtitleWindow(cues, 40, 190).window, [49, 190]);
  assert.deepEqual(subtitleWindow(cues, 0, 190).window, [0, 190]);
  assert.deepEqual(subtitleWindow([{ start: 35, end: 37 }, ...cues], 40, 190).window, [40, 190]);
  assert.equal(subtitleWindow(cues, 200, 350), null);
});

test('subtitle windows reach the cold open and the ending, audio skips the edges', () => {
  const sub = planWindows(1350, 8, 150, 0);
  assert.equal(sub[0][0], 0);
  assert.equal(sub.at(-1)[1], 1350);
  const audio = planWindows(1350, 12, 90);
  assert.ok(audio[0][0] > 30);
});

test('subtitle windows that can cover the whole video leave no gaps', () => {
  const w = planWindows(1352, Math.min(12, Math.ceil(1352 / 150)), 150, 0);
  assert.equal(w[0][0], 0);
  assert.equal(w.at(-1)[1], 1352);
  for (let i = 1; i < w.length; i++) assert.equal(w[i][0], w[i - 1][1]);
});
