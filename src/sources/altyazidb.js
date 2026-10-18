import { config } from '../config.js';
import { fetchJson, fetchBuffer } from '../http.js';
import { cached } from '../cache.js';

const API = 'https://altyazidb.com/api/v1';
const headers = () => ({ 'X-API-Key': config.altyazidbKey, 'User-Agent': config.userAgent });

export const enabled = () => Boolean(config.altyazidbKey);

// Long-running anime are listed under the site's own season split with absolute episode
// numbers (Naruto 1x28 is "S2 E28", 26-27 is one double-episode file), so they are matched by number.
async function allEntries(imdb) {
  return cached('altyazidb-all', imdb, 6 * 3600, async () => {
    const data = [];
    for (let page = 1; page <= 10; page++) {
      const p = new URLSearchParams({ imdb_id: imdb, lang: 'tr', limit: '100', page: String(page) });
      const d = await fetchJson(`${API}/search?${p}`, { headers: headers() });
      data.push(...(d.data || []));
      if (page >= Number(d.pagination?.total_pages || 1)) break;
    }
    return { data };
  });
}

const span = (e) => {
  const m = String(e ?? '').match(/^\s*(\d{1,4})\s*[-–]\s*(\d{1,4})\s*$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

// Package season labels follow the site's own split (e.g. Naruto "S4" = episodes 78-104),
// so packages are matched by the episode coverage written in translator_note.
function noteCovers(note, absolute) {
  const t = String(note || '')
    .replace(/sezon\s*\d+/gi, ' ')
    .replace(/\d+\s*-?\s*mb\b/gi, ' ');
  const ranges = [...t.matchAll(/(?<!\d)(\d{1,4})\s*[-~–]\s*(\d{1,4})(?!\d)/g)]
    .map((m) => [Number(m[1]), Number(m[2])])
    .filter(([a, b]) => b > a && b - a < 400);
  if (ranges.some(([a, b]) => a <= absolute && absolute <= b)) return true;
  const singles = [...t
    .replace(/(?<!\d)\d{1,4}\s*[-~–]\s*\d{1,4}(?!\d)/g, ' ')
    .matchAll(/(?<![\d.])\d{1,4}(?![\d.])/g)]
    .map((m) => Number(m[0]));
  if (!ranges.length && !singles.length) return true;
  return singles.includes(absolute);
}

const candidate = (s, pack, season, episode) => ({
  source: 'altyazidb',
  ref: `${pack ? 'download' : 'subtitle'}?sub_id=${s.id}`,
  lang: 'tr',
  release: (s.releases || []).join(' ') || s.translator || '',
  fileName: pack ? 'pack.zip' : 'sub.srt',
  fps: Number(s.fps) || null,
  hashMatch: false,
  downloads: s.downloads || 0,
  pack,
  ai: Boolean(s.ai_ceviri),
  season,
  episode,
});

export async function search({ imdb, season, episode, absolute, longRunning }) {
  if (!enabled()) return [];
  if (season != null && longRunning && absolute) {
    const d = await allEntries(imdb);
    return (d.data || []).flatMap((s) => {
      if (s.is_package) return noteCovers(s.translator_note, absolute) ? [candidate(s, true, season, episode)] : [];
      if (Number(s.episode) === absolute) return [candidate(s, false, season, episode)];
      const r = span(s.episode);
      return r && r[0] <= absolute && absolute <= r[1] ? [candidate(s, true, season, episode)] : [];
    });
  }
  const p = new URLSearchParams({ imdb_id: imdb, lang: 'tr' });
  if (season != null) {
    p.set('season', String(season));
    p.set('episode', String(episode));
  }
  const key = `${imdb}:${season}:${episode}`;
  const d = await cached('altyazidb-search', key, 6 * 3600, () => fetchJson(`${API}/search?${p}`, { headers: headers() }));
  return (d.data || []).flatMap((s) => {
    const pack = Boolean(s.is_package);
    if (season != null) {
      if (s.season != null && Number(s.season) !== season) return [];
      if (!pack && Number(s.episode) !== episode) return [];
    }
    return [candidate(s, pack, season, episode)];
  });
}

export async function download(ref) {
  const b64 = await cached('altyazidb-file', ref, 30 * 86400, async () => (await fetchBuffer(`${API}/${ref}`, { headers: headers() })).toString('base64'));
  return Buffer.from(b64, 'base64');
}
