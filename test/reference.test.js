import test from 'node:test';
import assert from 'node:assert/strict';
import { cuesFromImagePackets, pickAudioStream } from '../src/sync/reference.js';

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
