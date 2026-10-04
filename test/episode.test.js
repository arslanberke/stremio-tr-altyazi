import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisode, episodeMatches, parseStremioId } from '../src/episode.js';
import { pickFile } from '../src/archive.js';

test('parses common episode formats', () => {
  assert.deepEqual(parseEpisode('Breaking.Bad.S01E04.720p'), { season: 1, from: 4, to: 4 });
  assert.deepEqual(parseEpisode('show 1x04 hdtv'), { season: 1, from: 4, to: 4 });
  assert.deepEqual(parseEpisode('Dizi 2. Sezon 7. Bölüm'), { season: 2, from: 7, to: 7 });
  assert.deepEqual(parseEpisode('Show.S02E03E04'), { season: 2, from: 3, to: 4 });
});

test('1x04 is never treated as episode 104 or 10', () => {
  assert.equal(episodeMatches('Show.1x04.srt', 1, 4), true);
  assert.equal(episodeMatches('Show.S01E04.srt', 1, 10), false);
  assert.equal(episodeMatches('Show.S01E10.srt', 1, 4), false);
  assert.equal(episodeMatches('Show.104.srt', 1, 4), true);
  assert.equal(episodeMatches('Show.110.srt', 1, 4), false);
});

test('anime absolute numbering: Naruto 1x4 is not episode 104', () => {
  const ctx = { absolute: 4, longRunning: true };
  assert.equal(episodeMatches('Naruto_104_[AonE][7A50F662]', 1, 4, ctx), false);
  assert.equal(episodeMatches('104._Run_Idate__Run__Nagi_Island_Awaits', 1, 4, ctx), false);
  assert.equal(episodeMatches('Naruto 104', 1, 4, ctx), false);
  assert.equal(episodeMatches('[HorribleSubs] Naruto - 04 [720p].srt', 1, 4, ctx), true);
  assert.equal(episodeMatches('Naruto.S01E04.srt', 1, 4, ctx), true);
  assert.equal(episodeMatches('Naruto 1080p x264 2002', 1, 4, ctx), null);
});

test('rejects other seasons', () => {
  assert.equal(episodeMatches('Show Season 2', 1, 4), false);
  assert.equal(episodeMatches('Show S01 complete', 1, 4), null);
});

test('picks the right file from a season pack', () => {
  const files = ['S01E01.srt', 'S01E04.srt', 'S01E10.srt', 'S01E14.srt'].map((name) => ({ name, data: Buffer.from('x') }));
  assert.equal(pickFile(files, 1, 4).name, 'S01E04.srt');
  assert.equal(pickFile(files, 1, 5), null);
});

test('parses stremio ids', () => {
  assert.deepEqual(parseStremioId('series', 'tt0903747:1:4'), { kind: 'imdb', imdb: 'tt0903747', season: 1, episode: 4 });
  assert.deepEqual(parseStremioId('movie', 'tt0371746'), { kind: 'imdb', imdb: 'tt0371746', season: null, episode: null });
});
