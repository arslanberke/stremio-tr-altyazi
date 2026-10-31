import test from 'node:test';
import assert from 'node:assert/strict';
import { offload } from '../src/sync/offload.js';
import { syncCues } from '../src/sync/align.js';
import { referenceFromSubtitle } from '../src/sync/reference.js';

test('aligning in the worker matches aligning in-process and leaves the loop free', async () => {
  const src = Array.from({ length: 1500 }, (_, i) => ({ start: i * 3.1 + (i % 7) * 0.3, end: i * 3.1 + 1.8, text: `l${i}` }));
  const ref = referenceFromSubtitle(src, 'test');
  const cues = src.map((c) => ({ ...c, start: c.start + 4.2, end: c.end + 4.2 }));
  let ticks = 0;
  const tick = setInterval(() => ticks++, 1);
  const got = await offload('syncCues', [ref, cues, {}]);
  clearInterval(tick);
  assert.deepEqual(got, syncCues(ref, cues, {}));
  assert.ok(ticks > 0);
  await assert.rejects(offload('nope', []));
});
