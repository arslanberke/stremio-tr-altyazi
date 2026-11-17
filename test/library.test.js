import test from 'node:test';
import assert from 'node:assert/strict';
import { nameHasTitle, episodeTitleConflicts } from '../src/library.js';

test('library title match tolerates spelling but not a longer title', () => {
  assert.ok(nameHasTitle('[Erai-raws] Naruto Shippuuden - 080 [1080p].mkv', 'Naruto: Shippuden'));
  assert.ok(nameHasTitle('[Judas] Naruto - S05E35 (220).mkv', 'Naruto'));
  assert.equal(nameHasTitle('[Erai-raws] Naruto Shippuuden - 080 [1080p].mkv', 'Naruto'), false);
  assert.ok(nameHasTitle('Naruto Shippuden - Box 01 Remaster/001.mkv', 'Naruto Shippuden'));
});

test('mislabeled episode titles are rejected', () => {
  assert.ok(episodeTitleConflicts('[Anime Time] Naruto Shippuden - 033 - Battle Formation Ino-Shika-Cho.mkv', 'The New Target'));
  assert.equal(episodeTitleConflicts('[Anime Time] Naruto Shippuden - 057 - Deprived Of Eternal Sleep.mkv', 'Robbed of Sleep'), false);
  assert.equal(episodeTitleConflicts('[Anime Time] Naruto Shippuden - 033 - The New Target.mkv', 'The New Target'), false);
  assert.equal(episodeTitleConflicts('[Erai-raws] Naruto Shippuuden - 080 [1080p].mkv', 'Last Words'), false);
});
