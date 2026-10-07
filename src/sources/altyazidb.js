import { config } from '../config.js';
import { fetchJson, fetchBuffer } from '../http.js';
import { cached } from '../cache.js';

const API = 'https://altyazidb.com/api/v1';
const headers = () => ({ 'X-API-Key': config.altyazidbKey, 'User-Agent': config.userAgent });

export const enabled = () => Boolean(config.altyazidbKey);

export async function search({ imdb, season, episode }) {
  if (!enabled()) return [];
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
    return [{
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
    }];
  });
}

export async function download(ref) {
  const b64 = await cached('altyazidb-file', ref, 30 * 86400, async () => (await fetchBuffer(`${API}/${ref}`, { headers: headers() })).toString('base64'));
  return Buffer.from(b64, 'base64');
}
