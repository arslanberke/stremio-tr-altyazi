import test from 'node:test';
import assert from 'node:assert/strict';
import { osHashOf } from '../src/videohash.js';

test('OpenSubtitles hash matches the reference algorithm', () => {
  const head = Buffer.alloc(65536);
  const tail = Buffer.alloc(65536);
  for (let i = 0; i < 65536; i++) { head[i] = (i * 7) & 255; tail[i] = (i * 13 + 5) & 255; }
  assert.equal(osHashOf(head, tail, 734003200), 'c03fc040ebffa000');
});
