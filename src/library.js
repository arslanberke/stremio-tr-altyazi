import { cached } from './cache.js';
import { config } from './config.js';
import { fetchJson } from './http.js';
import { parseStremioId, episodeMatches } from './episode.js';
import { episodeContext, encodeToken } from './service.js';
import * as torbox from './torbox.js';
import { probe } from './sync/reference.js';

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|webm)$/i;

// Release names spell titles loosely ("Shippuuden"/"Shippuden"), so doubled letters are collapsed.
export const looseTitle = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/([a-z])\1+/g, '$1').trim();

// The title followed by something other than another word, so "Naruto" doesn't match "Naruto Shippuden" files.
export function nameHasTitle(name, title) {
  const t = looseTitle(title);
  if (t.length < 3) return false;
  const words = looseTitle(name).split(' ');
  const tw = t.split(' ');
  for (let i = 0; i + tw.length <= words.length; i++) {
    if (tw.every((w, j) => words[i + j] === w)) {
      const next = words[i + tw.length];
      if (next == null || /^\d/.test(next) || /^(s\d+(e\d+)?|season|sezon|ep?|episode|complete|batch|the|movie|box|bd|dvd|web)$/.test(next)) return true;
    }
  }
  return false;
}

const metaName = (type, imdb) => cached('cinemeta-title', `v4:${type}:${imdb}`, 7 * 86400, async () => {
  const num = Number(imdb.replace(/^tt/, ''));
  const [d, os] = await Promise.all([
    fetchJson(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`),
    config.osKey && num ? fetchJson(`https://api.opensubtitles.com/api/v1/features?imdb_id=${num}`, {
      headers: { 'Api-Key': config.osKey, 'User-Agent': config.userAgent },
    }).catch(() => null) : null,
  ]);
  const feat = os?.data?.[0]?.attributes;
  const episodes = (d.meta?.videos || []).map((v) => [Number(v.season), Number(v.episode), v.name || v.title || '']);
  const titles = [...new Set([d.meta?.name, feat?.original_title, feat?.title, ...(feat?.title_aka || []), ...(d.meta?.aliases || [])].filter(Boolean))];
  return { titles, year: String(d.meta?.releaseInfo || d.meta?.year || '').slice(0, 4), episodes };
});

const STOP = new Set(['the', 'of', 'a', 'an', 'and', 'to', 'in', 'on', 'is', 'his', 'her', 'for']);
const words = (t) => looseTitle(t).split(' ').filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));

// "Show - 033 - Episode Title.mkv": a title that shares nothing with the real one means a mislabeled file.
export function episodeTitleConflicts(fileName, episodeName) {
  const m = String(fileName).replace(/\.\w+$/, '').match(/[ _]-[ _]\d{2,4}[ _]-[ _](.+)$/);
  if (!m || !episodeName) return false;
  const a = words(m[1].replace(/\[[^\]]*\]/g, ' '));
  const b = new Set(words(episodeName));
  return a.length >= 2 && b.size >= 1 && !a.some((w) => b.has(w));
}

// Samsung's Tizen player fails on AV1 and on 10-bit H.264 (Hi10P); 10-bit HEVC plays.
export const tvUnplayable = (name) => /\bav1\b/i.test(name)
  || (/\b10[ -]?bit\b|hi10p?/i.test(name) && !/\b(hevc|x265|h\.?265)\b/i.test(name));

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;

// A file muxed with several video tracks (a broken remux) won't play on the TV. Unknown counts as fine;
// a slow first probe keeps running in the background and is cached for next time.
export const videoTracks = (streams) => (streams || []).filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic).length;
function singleVideo(hit) {
  const n = cached('video-tracks', `v1:${hit.itemId}:${hit.fileId}`, 30 * 86400, async () => videoTracks((await probe(await torbox.streamUrl(hit)))?.streams) || null, Boolean).catch(() => null);
  return Promise.race([n, new Promise((r) => setTimeout(r, 4000, null))]).then((v) => !(v > 1));
}

// Videos already in the user's TorBox library that match this title/episode, played through /play/.
export async function libraryStreams(type, id, baseUrl) {
  const target = parseStremioId(type, id);
  if (!torbox.enabled() || target?.kind !== 'imdb') return [];
  const { titles = [], year, episodes = [] } = await metaName(type, target.imdb);
  const epName = episodes.find(([s, e]) => s === target.season && e === target.episode)?.[2];
  if (!titles.length) return [];
  const ctx = type === 'series' ? await episodeContext(target.imdb, target.season, target.episode) : {};
  const out = [];
  for (const f of await torbox.libraryFiles()) {
    if (!VIDEO.test(f.name) || /\bsample\b/i.test(f.name)) continue;
    const base = f.name.split('/').pop();
    if (!titles.some((t) => nameHasTitle(`${f.itemName} ${f.name}`, t)) || tvUnplayable(`${f.itemName} ${f.name}`)) continue;
    if (type === 'series') {
      if (episodeMatches(base, target.season, target.episode, ctx) !== true || episodeTitleConflicts(base, epName)) continue;
    } else if (year && /\b(19|20)\d{2}\b/.test(base) && !base.includes(year)) continue;
    out.push({
      name: 'TorBox\nKütüphane',
      title: `${base}\n💾 ${gb(f.size)}`,
      url: `${baseUrl}/play/${encodeToken({ k: f.kindIndex, i: f.itemId, f: f.fileId })}`,
      behaviorHints: { filename: base, videoSize: f.size, bingeGroup: `tralt-lib-${f.itemId}` },
      _hit: { kind: torbox.KINDS[f.kindIndex], itemId: f.itemId, fileId: f.fileId },
    });
  }
  const ok = await Promise.all(out.map((s) => singleVideo(s._hit)));
  const kept = out.filter((s, i) => ok[i]).map(({ _hit, ...s }) => s);
  kept.sort((a, b) => b.behaviorHints.videoSize - a.behaviorHints.videoSize);
  if (kept[0]) kept[0].name = '⭐ TorBox\nKütüphane';
  return kept;
}

export const playUrl = (t) => torbox.streamUrl({ kind: torbox.KINDS[t.k], itemId: t.i, fileId: t.f });
