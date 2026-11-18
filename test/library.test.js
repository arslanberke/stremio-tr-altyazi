import test from 'node:test';
import assert from 'node:assert/strict';
import { nameHasTitle, episodeTitleConflicts, tvUnplayable, videoTracks } from '../src/library.js';

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

test('files the TV cannot play are recognised', () => {
  assert.ok(tvUnplayable('Naruto Shippuuden 001 [1080p BD AV1 Dual Audio].mkv'));
  assert.ok(tvUnplayable('[Yellow-Flash]_Naruto_Shippuden_-_033_[DVD][576p][10bit][A28A1050].mkv'));
  assert.equal(tvUnplayable('[Anime Time] Naruto Shippuden Complete [HEVC 10bit x265][AAC] [Anime Time] Naruto Shippuden - 060.mkv'), false);
  assert.equal(tvUnplayable('[Erai-raws] Naruto Shippuuden - 080 [1080p CR WEB-DL AVC AAC].mkv'), false);
});

test('counts real video tracks, not cover art', () => {
  const v = { codec_type: 'video' };
  assert.equal(videoTracks([v, { codec_type: 'audio' }, { codec_type: 'video', disposition: { attached_pic: 1 } }]), 1);
  assert.equal(videoTracks([v, v, v]), 3);
});
