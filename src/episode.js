const PATTERNS = [
  /\bS(\d{1,2})[ ._-]?E(\d{1,3})(?:[ ._-]?E?(\d{1,3}))?\b/i,
  /\b(\d{1,2})x(\d{1,3})(?:[-x](\d{1,3}))?\b/i,
  /\bseason[ ._-]*(\d{1,2})[ ._-]*(?:episode|ep)[ ._-]*(\d{1,3})\b/i,
  /\b(\d{1,2})[ ._-]*\.?[ ._-]*sezon[ ._-]*(\d{1,3})[ ._-]*\.?[ ._-]*b[öo]l[üu]m/i,
];

const SEASON_ONLY = [
  /\bS(\d{1,2})\b(?![ ._-]?E\d)/i,
  /\bseason[ ._-]*(\d{1,2})\b/i,
  /\b(\d{1,2})[ ._-]*\.?[ ._-]*sezon\b/i,
];

export function parseEpisode(name) {
  if (!name) return null;
  const s = String(name).replace(/\.(srt|ass|ssa|sub|vtt|txt|zip|rar)$/i, '');
  for (const re of PATTERNS) {
    const m = s.match(re);
    if (m) {
      const season = Number(m[1]);
      const from = Number(m[2]);
      const to = m[3] ? Number(m[3]) : from;
      return { season, from, to: Math.max(from, to) };
    }
  }
  return null;
}

export function parseSeason(name) {
  if (!name) return null;
  for (const re of SEASON_ONLY) {
    const m = String(name).match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

// true = matches, false = definitely another episode, null = no episode info in name
export function episodeMatches(name, season, episode) {
  const p = parseEpisode(name);
  if (p) return p.season === season && episode >= p.from && episode <= p.to;
  const ss = parseSeason(name);
  if (ss != null && ss !== season) return false;
  return null;
}

export function parseStremioId(type, id) {
  const parts = decodeURIComponent(id).split(':');
  if (parts[0] === 'kitsu') return { kind: 'kitsu', kitsuId: parts[1], episode: Number(parts[2]) || null };
  if (!/^tt\d+$/.test(parts[0])) return null;
  if (type === 'series' && parts.length >= 3) {
    return { kind: 'imdb', imdb: parts[0], season: Number(parts[1]), episode: Number(parts[2]) };
  }
  return { kind: 'imdb', imdb: parts[0], season: null, episode: null };
}

const TAGS = ['bluray', 'brrip', 'bdrip', 'web-dl', 'webdl', 'webrip', 'web', 'hdtv', 'dvdrip', 'hdrip', 'remux',
  'amzn', 'nf', 'dsnp', 'hmax', 'atvp', 'exxen', 'blutv', 'gain', 'proper', 'repack', 'extended', 'unrated', 'directors'];

function tokens(name) {
  return new Set(String(name || '').toLowerCase().replace(/web[ ._-]?dl/g, 'webdl').split(/[^a-z0-9]+/).filter(Boolean));
}

function releaseGroup(name) {
  const m = String(name || '').replace(/\.(mkv|mp4|avi|srt|zip)$/i, '').match(/-([A-Za-z0-9]+)(?:\[[^\]]*\])?$/);
  return m ? m[1].toLowerCase() : null;
}

export function releaseScore(videoName, subName) {
  if (!videoName || !subName) return 0;
  const a = tokens(videoName);
  const b = tokens(subName);
  let score = 0;
  for (const t of TAGS.map((t) => t.replace('-', ''))) if (a.has(t) && b.has(t)) score += 2;
  const ga = releaseGroup(videoName);
  if (ga && (releaseGroup(subName) === ga || b.has(ga))) score += 5;
  for (const r of ['2160p', '1080p', '720p', '480p']) if (a.has(r) && b.has(r)) score += 1;
  return score;
}
