import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenOverlaps } from '../src/subformat.js';

test('turns a long sign over dialogue into non-overlapping cues', () => {
  const out = flattenOverlaps([
    { start: 187.66, end: 197.62, text: 'Sign' },
    { start: 187.75, end: 192.29, text: 'A' },
    { start: 192.67, end: 195.59, text: 'B' },
  ]);
  assert.deepEqual(out.map((c) => c.text), ['Sign\nA', 'Sign', 'Sign\nB', 'Sign']);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].end);
});

test('leaves non-overlapping cues unchanged', () => {
  const cues = [{ start: 1, end: 2, text: 'a' }, { start: 2, end: 3, text: 'b' }];
  assert.deepEqual(flattenOverlaps(cues), cues);
});
