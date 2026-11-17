import { cached } from './cache.js';
import { fetchJson } from './http.js';
import { parseStremioId, episodeMatches } from './episode.js';
import { episodeContext, encodeToken } from './service.js';
import * as torbox from './torbox.js';

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
      if (next == null || /^\d/.test(next) || /^(s\d+(e\d+)?|season|ep?|episode|complete|batch|the|movie|box|bd|dvd|web)$/.test(next)) return true;
    }
  }
  return false;
}

const metaName = (type, imdb) => cached('cinemeta-title', `v2:${type}:${imdb}`, 7 * 86400, async () => {
  const d = await fetchJson(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`);
  const episodes = (d.meta?.videos || []).map((v) => [Number(v.season), Number(v.episode), v.name || v.title || '']);
  return { name: d.meta?.name || '', year: String(d.meta?.releaseInfo || d.meta?.year || '').slice(0, 4), episodes };
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

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;

// Videos already in the user's TorBox library that match this title/episode, played through /play/.
export async function libraryStreams(type, id, baseUrl) {
  const target = parseStremioId(type, id);
  if (!torbox.enabled() || target?.kind !== 'imdb') return [];
  const { name: title, year, episodes = [] } = await metaName(type, target.imdb);
  const epName = episodes.find(([s, e]) => s === target.season && e === target.episode)?.[2];
  if (!title) return [];
  const ctx = type === 'series' ? await episodeContext(target.imdb, target.season, target.episode) : {};
  const out = [];
  for (const f of await torbox.libraryFiles()) {
    if (!VIDEO.test(f.name) || /\bsample\b/i.test(f.name)) continue;
    const base = f.name.split('/').pop();
    if (!nameHasTitle(`${f.itemName} ${f.name}`, title)) continue;
    if (type === 'series') {
      if (episodeMatches(base, target.season, target.episode, ctx) !== true || episodeTitleConflicts(base, epName)) continue;
    } else if (year && /\b(19|20)\d{2}\b/.test(base) && !base.includes(year)) continue;
    out.push({
      name: 'TorBox\nKütüphane',
      title: `${base}\n💾 ${gb(f.size)}${/\bav1\b|\bflac\b/i.test(`${f.itemName} ${f.name}`) ? ' · ⚠️ TV açmayabilir (AV1/FLAC)' : ''}`,
      url: `${baseUrl}/play/${encodeToken({ k: f.kindIndex, i: f.itemId, f: f.fileId })}`,
      behaviorHints: { filename: base, videoSize: f.size, bingeGroup: `tralt-lib-${f.itemId}` },
    });
  }
  return out.sort((a, b) => b.behaviorHints.videoSize - a.behaviorHints.videoSize);
}

export const playUrl = (t) => torbox.streamUrl({ kind: torbox.KINDS[t.k], itemId: t.i, fileId: t.f });
