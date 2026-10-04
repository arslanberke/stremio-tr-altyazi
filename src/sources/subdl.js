import { config } from '../config.js';
import { fetchJson, fetchBuffer } from '../http.js';
import { cached } from '../cache.js';

export const enabled = () => Boolean(config.subdlKey);

export async function search({ imdb, season, episode }) {
  if (!enabled()) return [];
  const p = new URLSearchParams({ api_key: config.subdlKey, imdb_id: imdb, languages: 'TR', subs_per_page: '30' });
  if (season != null) {
    p.set('type', 'tv');
    p.set('season_number', String(season));
    p.set('episode_number', String(episode));
  } else p.set('type', 'movie');
  const key = `${imdb}:${season}:${episode}`;
  const d = await cached('subdl-search', key, 6 * 3600, () => fetchJson(`https://api.subdl.com/api/v1/subtitles?${p}`));
  return (d.subtitles || []).flatMap((s) => {
    if (season != null) {
      if (s.season != null && Number(s.season) !== season) return [];
      const from = s.episode_from ?? s.episode;
      const to = s.episode_end || s.episode;
      if (!s.full_season && from != null && (episode < Number(from) || episode > Number(to || from))) return [];
    }
    return [{
      source: 'subdl',
      ref: s.url.split('?')[0],
      lang: 'tr',
      release: s.release_name || s.name || '',
      fileName: s.name || '',
      fps: s.fps || null,
      hashMatch: false,
      downloads: 0,
      pack: Boolean(s.full_season),
      season,
      episode,
    }];
  });
}

export async function download(ref) {
  const b64 = await cached('subdl-file', ref, 30 * 86400, async () => (await fetchBuffer(`https://dl.subdl.com${ref}`)).toString('base64'));
  return Buffer.from(b64, 'base64');
}
