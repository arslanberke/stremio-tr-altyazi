import { config } from './config.js';
import { cached } from './cache.js';
import { fetchJson } from './http.js';
import { parseStremioId, episodeMatches, releaseScore } from './episode.js';
import { decodeText, parseSubtitle, toSrt, flattenOverlaps, extendForReading } from './subformat.js';
import { unpack, pickFile } from './archive.js';
import { syncCues, driftReport } from './sync/align.js';
import { referenceFromVideo, referenceFromSubtitle } from './sync/reference.js';
import * as os from './sources/opensubtitles.js';
import * as subdl from './sources/subdl.js';
import * as subsource from './sources/subsource.js';
import * as local from './sources/local.js';
import * as torbox from './torbox.js';
import { translateLines } from './translate.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

export function encodeToken(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function decodeToken(t) {
  return JSON.parse(Buffer.from(t, 'base64url').toString('utf8'));
}

export function parseExtra(extra) {
  const out = {};
  if (!extra) return out;
  for (const [k, v] of new URLSearchParams(extra)) out[k] = v;
  return out;
}

// Stremio asks for subtitles more than once and TV apps show the first list, which may
// lack file details; the latest details per episode fill them in when a subtitle is picked.
const lastVideo = new Map();
const targetKey = (t) => [t.imdb, t.season, t.episode].join(':');

function rememberVideo(target, video) {
  if (!video.videoHash && !video.videoSize) return;
  lastVideo.set(targetKey(target), { video, at: Date.now() });
  if (lastVideo.size > 500) lastVideo.delete(lastVideo.keys().next().value);
}

function completeVideo(target, video) {
  if (video.videoHash || video.videoSize) return video;
  const m = lastVideo.get(targetKey(target));
  return m && Date.now() - m.at < 3 * 3600 * 1000 ? m.video : video;
}

function videoKey(v) {
  return v.videoHash || `${v.videoSize}:${v.filename}`;
}

export async function episodeContext(imdb, season, episode) {
  if (!imdb || season == null) return {};
  try {
    const meta = await cached('cinemeta', imdb, 7 * 86400, async () => {
      const d = await fetchJson(`https://v3-cinemeta.strem.io/meta/series/${imdb}.json`);
      return (d.meta?.videos || []).map((v) => [Number(v.season), Number(v.episode)]);
    });
    const eps = meta.filter(([s, e]) => s > 0 && e > 0).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const idx = eps.findIndex(([s, e]) => s === season && e === episode);
    const perSeason = {};
    for (const [s] of eps) perSeason[s] = (perSeason[s] || 0) + 1;
    return {
      absolute: idx >= 0 ? idx + 1 : undefined,
      longRunning: eps.length >= 100 || Object.values(perSeason).some((n) => n >= 100),
    };
  } catch (e) {
    log('cinemeta', e.message);
    return {};
  }
}

export async function findCandidates(target, video) {
  const q = { imdb: target.imdb, season: target.season, episode: target.episode };
  const ctx = await episodeContext(target.imdb, target.season, target.episode);
  const alt = [];
  if (ctx.longRunning && ctx.absolute) {
    for (const e of new Set([ctx.absolute, ctx.absolute % 100 || 100])) {
      if (!(target.season === 1 && e === target.episode)) alt.push(e);
    }
  }
  const osErr = (e) => (log('os search', e.message), []);
  const results = await Promise.all([
    os.search({ ...q, videoHash: video.videoHash, languages: 'tr' }).catch(osErr),
    subdl.search(q).catch((e) => (log('subdl search', e.message), [])),
    local.search(q).catch((e) => (log('local search', e.message), [])),
    subsource.search(q).catch((e) => (log('subsource search', e.message), [])),
    ...alt.map((e) => os.search({ ...q, languages: 'tr', osSeason: 1, osEpisode: e }).catch(osErr)),
  ]);
  const m = (n) => episodeMatches(n, target.season, target.episode, ctx);
  const sameEpisode = (list) => (target.season == null ? list : list.filter((c) => (c.loose ? m(c.release) === true || m(c.fileName) === true : true)
    && m(c.release) !== false && m(c.fileName) !== false));
  let all = sameEpisode(results.flat().filter((c) => c.lang === 'tr'));
  if (!all.length) {
    const en = await Promise.all([
      os.search({ ...q, videoHash: video.videoHash, languages: 'en' }).catch(osErr),
      ...alt.map((e) => os.search({ ...q, languages: 'en', osSeason: 1, osEpisode: e }).catch(osErr)),
    ]);
    all = sameEpisode(en.flat().filter((c) => c.lang === 'en')).map((c) => ({ ...c, mt: true }));
  }
  const seen = new Set();
  all = all.filter((c) => !seen.has(`${c.source}:${c.ref}`) && seen.add(`${c.source}:${c.ref}`));
  for (const c of all) c.rank = (c.hashMatch ? 100 : 0) + (c.source === 'local' ? 5 : 0) + releaseScore(video.filename, c.release) * 3 + Math.log10(1 + c.downloads) + (c.pack ? -1 : 0)
    + (/\b(cd ?[12]|[12] ?cd)\b/i.test(c.release) ? -4 : 0) + (/\b(cam|ts|telesync|screener|scr)\b/i.test(c.release) ? -3 : 0);
  return all.sort((x, y) => y.rank - x.rank);
}

async function getReference(video, target) {
  const key = videoKey(video);
  return cached('ref', key, 30 * 86400, async () => {
    if (torbox.enabled() && video.videoSize) {
      try {
        const hit = await torbox.findFile(video);
        if (hit) {
          const url = await torbox.streamUrl(hit);
          const ref = await referenceFromVideo(url);
          if (ref) {
            log('ref', ref.kind, 'from torbox', hit.name);
            return ref;
          }
        }
      } catch (e) {
        log('torbox ref failed', e.message);
      }
    }
    if (os.enabled() && video.videoHash) {
      try {
        const list = await os.search({ imdb: target.imdb, season: target.season, episode: target.episode, videoHash: video.videoHash, languages: 'en,tr' });
        const m = list.find((c) => c.hashMatch && c.lang === 'en') || list.find((c) => c.hashMatch);
        if (m) {
          const cues = parseSubtitle(decodeText(await os.download(m.ref, m)), { fps: m.fps });
          const ref = referenceFromSubtitle(cues, `opensubtitles-${m.lang}`);
          if (ref) {
            log('ref from opensubtitles hash match', m.release);
            return ref;
          }
        }
      } catch (e) {
        log('os ref failed', e.message);
      }
    }
    if (os.enabled() && video.filename) {
      try {
        const ctx = await episodeContext(target.imdb, target.season, target.episode);
        const list = (await os.search({ imdb: target.imdb, season: target.season, episode: target.episode, languages: 'en' }))
          .filter((c) => target.season == null || (episodeMatches(c.release, target.season, target.episode, ctx) !== false
            && episodeMatches(c.fileName, target.season, target.episode, ctx) !== false));
        const best = list.map((c) => ({ c, s: releaseScore(video.filename, c.release) })).sort((a, b) => b.s - a.s)[0];
        if (best && best.s >= 5) {
          const cues = parseSubtitle(decodeText(await os.download(best.c.ref, best.c)), { fps: best.c.fps });
          const ref = referenceFromSubtitle(cues, 'same-release');
          if (ref) {
            log('ref from same-release subtitle', best.c.release);
            return ref;
          }
        }
      } catch (e) {
        log('same-release ref failed', e.message);
      }
    }
    return null;
  });
}

function wrap(text, max = 42) {
  if (text.length <= max) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = text.indexOf(' '); i !== -1; i = text.indexOf(' ', i + 1)) if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

async function loadCandidate(c, target) {
  const src = { opensubtitles: os, subdl, subsource, local }[c.source];
  const buf = await src.download(c.ref, { imdb: target.imdb, season: target.season, episode: target.episode, ...c });
  const files = unpack(buf, c.fileName || 'sub.srt');
  const f = pickFile(files, target.season, target.episode, await episodeContext(target.imdb, target.season, target.episode));
  if (!f) throw new Error('no matching episode file in archive');
  const cues = parseSubtitle(decodeText(f.data), { fps: c.fps });
  if (!c.mt) return cues;
  const tr = await translateLines(cues.map((x) => x.text.replace(/\s*\n\s*/g, ' ')));
  return cues.map((x, i) => ({ ...x, text: wrap(tr[i] || x.text) }));
}

export async function buildSubtitle(token) {
  const { c, t: target, v } = decodeToken(token);
  const video = completeVideo(target, v);
  return cached('out', `v5:${token}:${videoKey(video)}`, 30 * 86400, async () => {
    const cues = await loadCandidate(c, target);
    if (!cues.length) throw new Error('empty subtitle');
    const ref = await getReference(video, target);
    if (!ref) {
      log('no reference, serving as-is', c.release);
      return { srt: toSrt(extendForReading(flattenOverlaps(cues))), status: 'unsynced' };
    }
    const r = syncCues(ref, cues);
    const check = r.confident ? driftReport(ref, r.cues) : null;
    log('sync', c.source, c.release, `ref=${ref.kind}`, `method=${r.method || '-'}`, `ratio=${r.ratio?.toFixed(4)}`, `offset=${r.offset?.toFixed(1)}`, `z=${r.z?.toFixed(1)}`, r.confident ? 'OK' : 'LOW', `cuts=${JSON.stringify(r.offsets || [])}`, check ? `matched=${(check.matched * 100).toFixed(0)}% drift=${JSON.stringify(check.drift)}` : '');
    return { srt: toSrt(extendForReading(flattenOverlaps(r.cues))), status: r.confident ? 'synced' : 'unsynced', ref: ref.kind, ratio: r.ratio, offset: r.offset, z: r.z };
  });
}

// Aligned against a text/image track of the file itself and still no fit: wrong episode/show.
const isWrong = (o) => Boolean(o && o.status === 'unsynced' && o.ref && o.ref !== 'audio');

// If the chosen subtitle turns out not to fit this video, serve another candidate that does.
export async function serveSubtitle(token) {
  const out = await buildSubtitle(token).catch((error) => ({ error }));
  if (!out.error && !isWrong(out)) return out;
  const { c, t: target, v } = decodeToken(token);
  const video = completeVideo(target, v);
  const others = (await findCandidates(target, video)).filter((x) => !x.mt && !(x.source === c.source && x.ref === c.ref)).slice(0, 6);
  for (const o of others) {
    const r = await buildSubtitle(encodeToken({ c: o, t: target, v: video })).catch(() => null);
    if (r?.status === 'synced') {
      log('fallback', c.release, '->', o.release);
      return r;
    }
  }
  if (out.error) throw out.error;
  return out;
}

export async function listSubtitles(type, id, extraStr, baseUrl) {
  const target = parseStremioId(type, id);
  if (!target || target.kind !== 'imdb') return [];
  const extra = parseExtra(extraStr);
  const video = { videoHash: extra.videoHash || null, videoSize: extra.videoSize || null, filename: extra.filename || null };
  rememberVideo(target, video);
  const found = await findCandidates(target, video);
  const cands = found.slice(0, found[0]?.mt ? 2 : 12);
  log('list', id, video.filename, `${cands.length} candidates`);
  const items = cands.map((c, i) => {
    const token = encodeToken({ c, t: target, v: video });
    return { token, c, i };
  });
  // Every candidate is checked against the video in the background. One that cannot be
  // aligned to a text/image reference from the file itself is another episode or show.
  const results = items.map(({ token }) => buildSubtitle(token).catch((e) => (log('prepare failed', e.message), { status: 'error' })));
  const done = new Array(items.length).fill(null);
  results.forEach((p, i) => p.then((o) => { done[i] = o; }));
  await Promise.race([Promise.all(results), new Promise((r) => setTimeout(r, 15000))]);
  const kept = items.filter(({ c }, i) => c.mt || !isWrong(done[i]));
  if (kept.length < items.length) log('hidden', items.length - kept.length, 'mismatching candidates');
  const host = config.publicUrl || baseUrl;
  const mark = (o) => {
    if (!o) return '⏳ Seçilince senkronlanır';
    if (o.status === 'synced') return '✅ Videoya senkron';
    if (o.status === 'unsynced') return '⚠️ Senkronlanamadı';
    return '❌ İndirilemedi';
  };
  return kept.map(({ token, c, i }, n) => ({
    id: `trsync-${c.mt ? 'mt-' : ''}${c.source}-${c.ref}`.replace(/[^\w-]/g, '_').slice(0, 80),
    url: `${host}/sub/${token}.srt`,
    lang: '** TR Senkron',
    label: `TR${n + 1} · ${c.mt ? '🤖 Makine çevirisi · ' : ''}${mark(done[i])} · ${{ opensubtitles: 'OpenSubtitles', subdl: 'SubDL', subsource: 'SubSource', local: 'Arşiv' }[c.source]} · ${c.release}`.slice(0, 140),
  }));
}
