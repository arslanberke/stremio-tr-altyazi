import test from 'node:test';
import assert from 'node:assert/strict';
import { nameHasTitle } from '../src/library.js';

test('library title match tolerates spelling but not a longer title', () => {
  assert.ok(nameHasTitle('[Erai-raws] Naruto Shippuuden - 080 [1080p].mkv', 'Naruto: Shippuden'));
  assert.ok(nameHasTitle('[Judas] Naruto - S05E35 (220).mkv', 'Naruto'));
  assert.equal(nameHasTitle('[Erai-raws] Naruto Shippuuden - 080 [1080p].mkv', 'Naruto'), false);
  assert.ok(nameHasTitle('Naruto Shippuden - Box 01 Remaster/001.mkv', 'Naruto Shippuden'));
});
