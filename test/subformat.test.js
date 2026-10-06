import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenOverlaps, extendForReading, parseSubtitle } from '../src/subformat.js';

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

test('srt cue missing its blank line is not swallowed by the previous cue', () => {
  const cues = parseSubtitle('110\n00:09:31,982 --> 00:09:37,315\n...öleceğiz!\n,\n111\n00:10:02,468 --> 00:10:05,699\nŞu sol elimdeki yara\nüstüne yemin ediyorum!\n\n112\n00:10:07,000 --> 00:10:09,000\nSon\n');
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, '...öleceğiz!\n,');
  assert.equal(cues[1].text, 'Şu sol elimdeki yara\nüstüne yemin ediyorum!');
});
