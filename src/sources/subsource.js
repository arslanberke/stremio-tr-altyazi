import { config } from '../config.js';
import { fetchJson, fetchBuffer } from '../http.js';
import { cached } from '../cache.js';
import { parseEpisode, parseSeason } from '../episode.js';

const API = 'https://api.subsource.net/api/v1';
export const enabled = () => Boolean(config.subsourceKey);
const headers = () => ({ 'X-API-Key': config.subsourceKey });

async function movieId(imdb, season) {
  const p = new URLSearchParams({ searchType: 'imdb', imdb });
  if (season != null) p.set('season', String(season));
  const d = await cached('subsource-movie', `${imdb}:${season}`, 7 * 86400, () => fetchJson(`${API}/movies/search?${p}`, { headers: headers() }));
  const list = d.data || [];
  const m = list.find((x) => season == null || Number(x.season) === season) || list[0];
  return m?.movieId ?? null;
}

export async function search({ imdb, season, episode }) {
  if (!enabled()) return [];
  const id = await movieId(imdb, season);
  if (id == null) return [];
  const p = new URLSearchParams({ movieId: String(id), language: 'turkish', limit: '100', sort: 'popular' });
  const d = await cached('subsource-subs', `${id}`, 6 * 3600, () => fetchJson(`${API}/subtitles?${p}`, { headers: headers() }));
  return (d.data || []).map((s) => {
    const release = [].concat(s.releaseInfo || []).join(' ');
    const pack = season != null && !parseEpisode(release) && parseSeason(release) === season;
    return {
      source: 'subsource',
      ref: String(s.subtitleId),
      lang: 'tr',
      release,
      fileName: release,
      fps: Number(s.framerate) || null,
      hashMatch: false,
      downloads: s.downloads || 0,
      pack,
      loose: season != null && !pack,
      season,
      episode,
    };
  });
}

export async function download(ref) {
  const b64 = await cached('subsource-file', ref, 30 * 86400, async () =>
    (await fetchBuffer(`${API}/subtitles/${encodeURIComponent(ref)}/download`, { headers: headers() })).toString('base64'));
  return Buffer.from(b64, 'base64');
}
