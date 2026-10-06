import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenOverlaps, extendForReading } from '../src/subformat.js';

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

test('extends short lines for reading without touching the next line', () => {
  const out = extendForReading([
    { start: 10, end: 11, text: 'Ülkelerde bulunan ve dünyaya yayılan onbinlerce ninjaya' },
    { start: 12.5, end: 14, text: 'Evet' },
    { start: 14.1, end: 14.5, text: 'Bu satır biraz uzun bir satır' },
  ]);
  assert.equal(out[0].start, 10);
  assert.equal(out[0].end, 12.4);
  assert.equal(out[1].end, 14);
  assert.ok(Math.abs(out[2].end - (14.1 + 24 / 15)) < 1e-9);
});
