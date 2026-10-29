import test from 'node:test';
import assert from 'node:assert/strict';
import { textTrackCues } from '../src/sync/mp4index.js';

const u32 = (...n) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeInt32BE(v, i * 4)); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (type, ...parts) => box(type, u32(0), ...parts);

test('textTrackCues reads non-empty text samples from the index, with the edit-list delay', () => {
  const mvhd = full('mvhd', u32(0, 0, 1000, 0));
  const video = box('trak', box('mdia', full('mdhd', u32(0, 0, 24, 0))));
  const text = box('trak',
    box('edts', full('elst', u32(1, 2000, -1, 65536))),
    box('mdia', full('mdhd', u32(0, 0, 1000, 0)), box('minf', box('stbl',
      full('stts', u32(3, 1, 1500, 1, 500, 1, 2000)),
      full('stsz', u32(0, 3, 20, 2, 30)),
    ))));
  const cues = textTrackCues(box('moov', mvhd, video, text), 1);
  assert.deepEqual(cues, [{ start: 2, end: 3.5 }, { start: 4, end: 6 }]);
});
