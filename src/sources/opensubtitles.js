import { config } from '../config.js';
import { fetchJson, fetchBuffer } from '../http.js';
import { cached } from '../cache.js';

const BASE = 'https://api.opensubtitles.com/api/v1';
let token = null;
let tokenExp = 0;

function headers(auth) {
  const h = { 'Api-Key': config.osKey, 'User-Agent': config.userAgent, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth && token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function login() {
  if (token && tokenExp > Date.now()) return;
  const d = await fetchJson(`${BASE}/login`, {
    method: 'POST',
    headers: headers(false),
    body: JSON.stringify({ username: config.osUser, password: config.osPass }),
  });
  token = d.token;
  tokenExp = Date.now() + 12 * 3600 * 1000;
}

export const enabled = () => Boolean(config.osKey);

// languages: comma list like "tr" or "en"; returns normalized candidates
// osSeason/osEpisode: query another numbering (anime absolute); results are then unverified (loose).
export async function search({ imdb, season, episode, videoHash, languages = 'tr', osSeason, osEpisode }) {
  if (!enabled()) return [];
  const num = String(Number(imdb.replace('tt', '')));
  const p = { languages };
  if (season != null) {
    p.parent_imdb_id = num;
    p.season_number = String(osSeason ?? season);
    p.episode_number = String(osEpisode ?? episode);
  } else p.imdb_id = num;
  if (videoHash) p.moviehash = videoHash;
  const qs = Object.keys(p).sort().map((k) => `${k}=${encodeURIComponent(p[k])}`).join('&');
  const d = await cached('os-search', qs, 6 * 3600, () => fetchJson(`${BASE}/subtitles?${qs}`, { headers: headers(false) }));
  return (d.data || []).flatMap((s) => {
    const a = s.attributes;
    const fd = a.feature_details || {};
    const loose = osEpisode != null;
    if (season != null && !loose && (fd.season_number !== season || fd.episode_number !== episode)) return [];
    return (a.files || []).map((f) => ({
      source: 'opensubtitles',
      ref: String(f.file_id),
      lang: a.language,
      release: a.release || f.file_name || '',
      fileName: f.file_name || '',
      fps: a.fps || null,
      hashMatch: Boolean(a.moviehash_match),
      downloads: a.download_count || 0,
      fromTrusted: Boolean(a.from_trusted),
      legacy: a.legacy_subtitle_id ? String(a.legacy_subtitle_id) : null,
      imdb,
      season,
      episode,
      loose,
    }));
  });
}

// Stremio's own OpenSubtitles addon serves the same files without the API's daily
// download quota; its subtitle ids are OpenSubtitles legacy ids.
async function viaStremio(fileId, c) {
  if (!c?.imdb) return null;
  if (!c.legacy) {
    const found = await search({ imdb: c.imdb, season: c.season, episode: c.episode, languages: 'en,tr' }).catch(() => []);
    c = { ...c, legacy: found.find((x) => x.ref === String(fileId))?.legacy };
    if (!c.legacy) return null;
  }
  const id = c.season != null ? `series/${c.imdb}:${c.season}:${c.episode}` : `movie/${c.imdb}`;
  try {
    const d = await cached('os-v3', id, 6 * 3600, () => fetchJson(`https://opensubtitles-v3.strem.io/subtitles/${id}.json`));
    const hit = (d.subtitles || []).find((x) => String(x.id) === c.legacy);
    return hit ? await fetchBuffer(hit.url) : null;
  } catch {
    return null;
  }
}

export async function download(fileId, c) {
  return cached('os-file', fileId, 30 * 86400, async () => {
    const v3 = await viaStremio(fileId, c);
    if (v3?.length) return v3.toString('base64');
    await login();
    const d = await fetchJson(`${BASE}/download`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ file_id: Number(fileId), sub_format: 'srt' }),
    });
    const buf = await fetchBuffer(d.link);
    return buf.toString('base64');
  }).then((b64) => Buffer.from(b64, 'base64'));
}
