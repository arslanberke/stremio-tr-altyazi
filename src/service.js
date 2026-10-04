import { config } from './config.js';
import { cached } from './cache.js';
import { parseStremioId, episodeMatches, releaseScore } from './episode.js';
import { decodeText, parseSubtitle, toSrt } from './subformat.js';
import { unpack, pickFile } from './archive.js';
import { syncCues } from './sync/align.js';
import { referenceFromVideo, referenceFromSubtitle } from './sync/reference.js';
import * as os from './sources/opensubtitles.js';
import * as subdl from './sources/subdl.js';
import * as torbox from './torbox.js';

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

function videoKey(v) {
  return v.videoHash || `${v.videoSize}:${v.filename}`;
}

export async function findCandidates(target, video) {
  const q = { imdb: target.imdb, season: target.season, episode: target.episode };
  const [a, b] = await Promise.all([
    os.search({ ...q, videoHash: video.videoHash, languages: 'tr' }).catch((e) => (log('os search', e.message), [])),
    subdl.search(q).catch((e) => (log('subdl search', e.message), [])),
  ]);
  let all = [...a, ...b].filter((c) => c.lang === 'tr');
  if (target.season != null) {
    all = all.filter((c) => episodeMatches(c.release, target.season, target.episode) !== false
      && episodeMatches(c.fileName, target.season, target.episode) !== false);
  }
  const seen = new Set();
  all = all.filter((c) => !seen.has(`${c.source}:${c.ref}`) && seen.add(`${c.source}:${c.ref}`));
  for (const c of all) c.rank = (c.hashMatch ? 100 : 0) + releaseScore(video.filename, c.release) * 3 + Math.log10(1 + c.downloads) + (c.pack ? -1 : 0)
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
          const cues = parseSubtitle(decodeText(await os.download(m.ref)), { fps: m.fps });
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
    return null;
  });
}

async function loadCandidate(c, target) {
  const buf = c.source === 'opensubtitles' ? await os.download(c.ref) : await subdl.download(c.ref);
  const files = unpack(buf, c.fileName || 'sub.srt');
  const f = pickFile(files, target.season, target.episode);
  if (!f) throw new Error('no matching episode file in archive');
  return parseSubtitle(decodeText(f.data), { fps: c.fps });
}

export async function buildSubtitle(token) {
  const { c, t: target, v: video } = decodeToken(token);
  return cached('out', token, 30 * 86400, async () => {
    const cues = await loadCandidate(c, target);
    if (!cues.length) throw new Error('empty subtitle');
    const ref = await getReference(video, target);
    if (!ref) {
      log('no reference, serving as-is', c.release);
      return { srt: toSrt(cues), status: 'unsynced' };
    }
    const r = syncCues(ref, cues);
    log('sync', c.source, c.release, `ref=${ref.kind}`, `ratio=${r.ratio?.toFixed(4)}`, `offset=${r.offset?.toFixed(1)}`, `z=${r.z?.toFixed(1)}`, r.confident ? 'OK' : 'LOW');
    return { srt: toSrt(r.cues), status: r.confident ? 'synced' : 'unsynced', ref: ref.kind, ratio: r.ratio, offset: r.offset, z: r.z };
  });
}

export async function listSubtitles(type, id, extraStr, baseUrl) {
  const target = parseStremioId(type, id);
  if (!target || target.kind !== 'imdb') return [];
  const extra = parseExtra(extraStr);
  const video = { videoHash: extra.videoHash || null, videoSize: extra.videoSize || null, filename: extra.filename || null };
  const cands = (await findCandidates(target, video)).slice(0, 12);
  log('list', id, video.filename, `${cands.length} candidates`);
  const items = cands.map((c, i) => {
    const token = encodeToken({ c, t: target, v: video });
    return { token, c, i };
  });
  let firstStatus = null;
  if (items.length) {
    const first = buildSubtitle(items[0].token).then((o) => o.status).catch((e) => (log('prepare failed', e.message), 'error'));
    firstStatus = await Promise.race([first, new Promise((r) => setTimeout(() => r(null), 12000))]);
  }
  const host = config.publicUrl || baseUrl;
  const mark = (i) => {
    if (i > 0) return '⏳ Seçilince senkronlanır';
    if (firstStatus === 'synced') return '✅ Videoya senkron';
    if (firstStatus === 'unsynced') return '⚠️ Senkronlanamadı';
    return '⏳ Senkronlanıyor';
  };
  return items.map(({ token, c, i }) => ({
    id: `trsync-${c.source}-${c.ref}`.replace(/[^\w-]/g, '_').slice(0, 80),
    url: `${host}/sub/${token}.srt`,
    lang: 'tur',
    label: `${mark(i)} · ${c.source === 'opensubtitles' ? 'OpenSubtitles' : 'SubDL'} · ${c.release}`.slice(0, 140),
  }));
}
