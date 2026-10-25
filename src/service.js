import { config } from './config.js';
import { cached } from './cache.js';
import { fetchJson } from './http.js';
import { parseStremioId, episodeMatches, releaseScore } from './episode.js';
import { decodeText, parseSubtitle, toSrt, flattenOverlaps, extendForReading, textShingles, sameTranslation } from './subformat.js';
import { unpack, pickFile } from './archive.js';
import { syncCues, driftReport, coverage, keepEpisode } from './sync/align.js';
import { referenceFromVideo, referenceFromSubtitle } from './sync/reference.js';
import * as os from './sources/opensubtitles.js';
import * as subdl from './sources/subdl.js';
import * as subsource from './sources/subsource.js';
import * as altyazidb from './sources/altyazidb.js';
import * as local from './sources/local.js';
import * as torbox from './torbox.js';
import { translateLines } from './translate.js';
import { osHash } from './videohash.js';

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

// The actual file's details win over the prefetched guess, which only fills in when nothing better came.
function completeVideo(target, video) {
  if (video.videoHash || video.videoSize) return video;
  const m = lastVideo.get(targetKey(target));
  return withPrefetched(target, m && Date.now() - m.at < 3 * 3600 * 1000 ? m.video : video);
}

// Stremio asks twice per episode, with and without the hash; both must share one analysis.
function videoKey(v) {
  return v.videoSize ? `size:${v.videoSize}` : v.videoHash || `name:${baseName(v.filename)}`;
}

const episodeList = async (imdb) => (await cached('cinemeta', imdb, 7 * 86400, async () => {
  const d = await fetchJson(`https://v3-cinemeta.strem.io/meta/series/${imdb}.json`);
  return (d.meta?.videos || []).map((v) => [Number(v.season), Number(v.episode)]);
})).filter(([s, e]) => s > 0 && e > 0).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

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

export async function findCandidates(target, video, mt = false) {
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
    altyazidb.search({ ...q, ...ctx }).catch((e) => (log('altyazidb search', e.message), [])),
    ...alt.map((e) => os.search({ ...q, languages: 'tr', osSeason: 1, osEpisode: e }).catch(osErr)),
  ]);
  const m = (n) => episodeMatches(n, target.season, target.episode, ctx);
  const nums = [target.episode, ctx.absolute].filter(Boolean);
  const covers = (t = '') => [...t.matchAll(/(?<!\d)(\d{1,3})\s*[-–~]\s*(\d{1,3})(?!\d)/g)]
    .some(([, a, b]) => nums.some((n) => Number(a) <= n && n <= Number(b) && Number(b) - Number(a) < 400));
  const sameEpisode = (list) => (target.season == null ? list : list.filter((c) => (c.loose ? m(c.release) === true || m(c.fileName) === true || covers(c.release) : true)
    && ((c.loose && covers(c.release)) || (m(c.release) !== false && m(c.fileName) !== false))));
  let all = sameEpisode(results.flat().filter((c) => c.lang === 'tr'));
  if (!all.length || mt) {
    const en = await Promise.all([
      os.search({ ...q, videoHash: video.videoHash, languages: 'en' }).catch(osErr),
      ...alt.map((e) => os.search({ ...q, languages: 'en', osSeason: 1, osEpisode: e }).catch(osErr)),
    ]);
    all = sameEpisode(en.flat().filter((c) => c.lang === 'en')).map((c) => ({ ...c, mt: true }));
  }
  const seen = new Set();
  all = all.filter((c) => !seen.has(`${c.source}:${c.ref}`) && seen.add(`${c.source}:${c.ref}`));
  for (const c of all) c.rank = (c.hashMatch ? 100 : 0) + (c.source === 'local' ? 5 : 0) + releaseScore(video.filename, c.release) * 3 + Math.log10(1 + c.downloads) + (c.pack ? -1 : 0) + (c.ai ? -4 : 0)
    + (/\b(cd ?[12]|[12] ?cd)\b/i.test(c.release) ? -4 : 0) + (/\b(cam|ts|telesync|screener|scr)\b/i.test(c.release) ? -3 : 0);
  return all.sort((x, y) => y.rank - x.rank);
}

async function getReference(video, target) {
  const key = videoKey(video);
  return cached('ref', `v3:${key}`, 30 * 86400, async () => {
    if (torbox.enabled() && (video.videoSize || video.filename)) {
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
  }, Boolean);
}

function wrap(text, max = 42) {
  if (text.length <= max) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = text.indexOf(' '); i !== -1; i = text.indexOf(' ', i + 1)) if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

async function loadCandidate(c, target) {
  const src = { opensubtitles: os, subdl, subsource, altyazidb, local }[c.source];
  const buf = await src.download(c.ref, { imdb: target.imdb, season: target.season, episode: target.episode, ...c });
  const files = unpack(buf, c.fileName || 'sub.srt');
  const f = pickFile(files, target.season, target.episode, await episodeContext(target.imdb, target.season, target.episode));
  if (!f) throw new Error('no matching episode file in archive');
  const cues = parseSubtitle(decodeText(f.data), { fps: c.fps });
  const span = episodeSpan(f.name);
  if (!c.mt) return Object.assign(cues, { span });
  const tr = await translateLines(cues.map((x) => x.text.replace(/\s*\n\s*/g, ' ')));
  return Object.assign(cues.map((x, i) => ({ ...x, text: wrap(tr[i] || x.text) })), { span });
}

// "Naruto26-27.srt": one file holding several episodes back to back.
function episodeSpan(name) {
  const m = String(name || '').replace(/\[[^\]]*\]/g, ' ').match(/(?<!\d)(\d{1,4})\s*[-–]\s*(\d{1,4})(?!\d)/);
  return m && Number(m[2]) > Number(m[1]) && Number(m[2]) - Number(m[1]) < 5 ? [Number(m[1]), Number(m[2])] : null;
}

export async function buildSubtitle(token) {
  const { c, t: target, v } = decodeToken(token);
  const video = completeVideo(target, v);
  const o = await cached('out', `v11:${token}:${videoKey(video)}`, 30 * 86400, async () => {
    const cues = await loadCandidate(c, target);
    if (!cues.length) throw new Error('empty subtitle');
    const ref = await getReference(video, target);
    if (!ref) {
      log('no reference, serving as-is', c.release);
      return { srt: toSrt(extendForReading(flattenOverlaps(cues))), status: 'unsynced' };
    }
    // A multi-episode file is searched across its whole length and cut down to this video.
    const multi = cues.span && ref.duration && cues.at(-1).end > ref.duration * 1.5;
    const r = syncCues(ref, cues, multi ? { maxShift: cues.at(-1).end } : {});
    if (multi && r.confident) r.cues = keepEpisode(cues, r.cues, r.offsets, ref.duration).filter((x) => x.end > 0 && x.start < ref.duration).map((x) => ({ ...x, start: Math.max(0, x.start) }));
    const check = driftReport(ref, r.cues);
    log('sync', c.source, c.release, `ref=${ref.kind}`, `method=${r.method || '-'}`, `ratio=${r.ratio?.toFixed(4)}`, `offset=${r.offset?.toFixed(1)}`, `z=${r.z?.toFixed(1)}`, r.confident ? 'OK' : 'LOW', `cuts=${JSON.stringify(r.offsets || [])}`, check ? `matched=${(check.matched * 100).toFixed(0)}% drift=${JSON.stringify(check.drift)}` : '');
    return { srt: toSrt(extendForReading(flattenOverlaps(r.cues))), status: r.confident ? 'synced' : 'unsynced', ref: ref.kind, ratio: r.ratio, offset: r.offset, z: r.z, fit: check.matched || 0 };
  }, (o) => o.status === 'synced' || Boolean(o.ref));
  if (o.status === 'synced' && o.cover === undefined && o.ref !== 'audio') {
    const ref = await getReference(video, target);
    o.cover = ref ? coverage(ref, parseSubtitle(o.srt)) : null;
  }
  return o;
}

// The same translation often sits in several packs/sites; only its best-placed copy is listed.
const shingles = new WeakMap();
function distinct(list, key = () => '') {
  const kept = [];
  return list.filter(({ o, c }) => {
    if (!o?.srt) return true;
    if (!shingles.has(o)) shingles.set(o, textShingles(parseSubtitle(o.srt)));
    const s = shingles.get(o);
    if (kept.some((k) => k.key === key(c) && sameTranslation(k.s, s))) return false;
    kept.push({ key: key(c), s });
    return true;
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

export async function listSubtitles(type, id, extraStr, baseUrl, mt = false) {
  const target = parseStremioId(type, id);
  if (!target || target.kind !== 'imdb') return [];
  const extra = parseExtra(extraStr);
  const raw = { videoHash: extra.videoHash || null, videoSize: extra.videoSize || null, filename: extra.filename || null };
  rememberVideo(target, raw);
  const video = withPrefetched(target, raw);
  // The file is analysed while the sites are searched.
  if (video.videoSize || video.filename) getReference(video, target).catch(() => null);
  const found = await findCandidates(target, video, mt);
  // More are checked than shown; the best-fitting ones are listed.
  const cands = found[0]?.mt ? found.slice(0, 2) : pickTop(found, 12);
  log('list', id, video.filename, `${cands.length} candidates`);
  const tv = raw.videoSize || raw.videoHash ? video : raw;
  const items = cands.map((c, i) => {
    const token = encodeToken({ c, t: target, v: tv });
    return { token, c, i };
  });
  // Every candidate is checked against the video in the background. One that cannot be
  // aligned to a text/image reference from the file itself is another episode or show.
  const results = items.map(({ token }) => buildSubtitle(token).catch((e) => (log('prepare failed', e.message), { status: /no matching episode/.test(e.message) ? 'absent' : 'error' })));
  const done = new Array(items.length).fill(null);
  results.forEach((p, i) => p.then((o) => { done[i] = o; }));
  Promise.all(results).then(() => prefetchNext(target, completeVideo(target, raw))).catch((e) => log('prefetch failed', e.message));
  // A prefetched episode only waits for the subtitles that were prepared ahead; the rest keep syncing.
  const ahead = video !== raw && new Set(pickTop(found, PREFETCH_TOP).map((c) => `${c.source}:${c.ref}`));
  const wait = ahead ? results.filter((_, i) => ahead.has(`${items[i].c.source}:${items[i].c.ref}`)) : results;
  await Promise.race([Promise.all(wait), new Promise((r) => setTimeout(r, 15000))]);
  // TV shows no labels: the best subtitle must come first (synced, then best-fitting unsynced).
  // A synced subtitle whose lines leave much of the dialogue without text (lines shown too briefly) goes below the others.
  const best = Math.max(0, ...done.map((o) => (o?.status === 'synced' && o.cover) || 0));
  const rank = (o) => (!o ? 1 : o.status === 'synced' ? (o.cover != null && o.cover < best - 0.15 ? 0.5 : 0) : o.status === 'unsynced' ? 2 : 3);
  const kept = distinct(items.map((x) => ({ ...x, o: done[x.i] })).filter(({ c }, i) => done[i]?.status !== 'absent' && (c.mt || !isWrong(done[i])))
    .sort((a, b) => rank(done[a.i]) - rank(done[b.i]) || (done[a.i]?.status === 'unsynced' ? (done[b.i]?.fit || 0) - (done[a.i]?.fit || 0) : 0) || a.i - b.i)
    ).slice(0, 8);
  if (kept.length < items.length) log('hidden', items.length - kept.length, 'mismatching or duplicate candidates');
  // Only packs without this episode (or wrong ones) were found: fall back to translated English.
  if (!kept.length && !mt && !found[0]?.mt) return listSubtitles(type, id, extraStr, baseUrl, true);
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
    label: `TR${n + 1} · ${c.mt ? '🤖 Makine çevirisi · ' : ''}${mark(done[i])} · ${{ opensubtitles: 'OpenSubtitles', subdl: 'SubDL', subsource: 'SubSource', altyazidb: 'AltyaziDB', local: 'Arşiv' }[c.source]} · ${c.release}`.slice(0, 140),
  }));
}

// Up to `max`, at most 4 from one site first so one site's near-duplicates don't crowd out
// other sites' releases; HI/CHI-style variants of one release count once until others got a slot.
export function pickTop(found, max = 12, perSource = 4) {
  const family = (c) => `${c.source}:${(c.release || c.ref).toLowerCase().split(/[^a-z0-9]+/).filter((t) => !/^(hi|sdh|chi|cc|forced)$/.test(t)).join('.')}`;
  const fams = new Set();
  const fresh = found.filter((c) => !fams.has(family(c)) && fams.add(family(c)));
  const list = [...fresh, ...found.filter((c) => !fresh.includes(c))];
  const n = {};
  const first = list.filter((c) => (n[c.source] = (n[c.source] || 0) + 1) <= perSource).slice(0, max);
  const rest = list.filter((c) => !first.includes(c)).slice(0, max - first.length);
  return found.filter((c) => first.includes(c) || rest.includes(c));
}

// While an episode plays, the next one's file is analysed and its top subtitles synced,
// so binge watching doesn't wait. Stremio plays the next episode from the same pack/release.
const prefetched = new Map();
const PREFETCH_TOP = 3;
const baseName = (n) => String(n || '').split('/').pop().toLowerCase();

function withPrefetched(target, video) {
  const p = prefetched.get(targetKey(target));
  if (!p?.video.videoSize) return video;
  const same = video.videoSize ? Number(video.videoSize) === p.video.videoSize
    : video.videoHash ? video.videoHash === p.video.videoHash : !video.filename || baseName(video.filename) === baseName(p.video.filename);
  if (!same) return video;
  return { ...p.video, ...Object.fromEntries(Object.entries(video).filter(([, v]) => v)) };
}

async function prefetchNext(target, video) {
  if (target.season == null || (!video.videoSize && !video.filename) || !torbox.enabled()) return;
  const eps = await episodeList(target.imdb);
  const i = eps.findIndex(([s, e]) => s === target.season && e === target.episode);
  if (i < 0 || i + 1 >= eps.length) return;
  const next = { ...target, season: eps[i + 1][0], episode: eps[i + 1][1] };
  const k = targetKey(next);
  // Switching to another release of the same episode prefetches that release's next file instead.
  const from = `${targetKey(target)}|${video.videoSize || baseName(video.filename)}`;
  if (prefetched.get(k)?.from === from) return;
  prefetched.set(k, { from, video: {} });
  if (prefetched.size > 500) prefetched.delete(prefetched.keys().next().value);
  const hit = await torbox.findFile(video);
  const ctx = await episodeContext(next.imdb, next.season, next.episode);
  const file = hit && await torbox.nextFile(hit, (name) => episodeMatches(name, next.season, next.episode, ctx) === true);
  if (!file) return prefetched.get(k)?.from === from && prefetched.delete(k);
  const url = await torbox.streamUrl(file);
  const v = { videoHash: await osHash(url, file.size).catch(() => null), videoSize: file.size, filename: file.name.split('/').pop() };
  if (prefetched.get(k)?.from !== from) return;
  prefetched.set(k, { from, video: v });
  log('prefetch', next.imdb, next.season, next.episode, v.videoSize, v.filename);
  if (!(await getReference(v, next))) return;
  const found = await findCandidates(next, v);
  for (const c of found[0]?.mt ? [] : pickTop(found, PREFETCH_TOP)) await buildSubtitle(encodeToken({ c, t: next, v })).catch(() => null);
}
