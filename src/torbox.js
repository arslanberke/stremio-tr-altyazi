import { config } from './config.js';
import { fetchJson } from './http.js';
import { cached } from './cache.js';

const BASE = 'https://api.torbox.app/v1/api';
export const KINDS = [
  { list: 'torrents/mylist', dl: 'torrents/requestdl', idParam: 'torrent_id' },
  { list: 'usenet/mylist', dl: 'usenet/requestdl', idParam: 'usenet_id' },
  { list: 'webdl/mylist', dl: 'webdl/requestdl', idParam: 'web_id' },
];

export const enabled = () => Boolean(config.torboxKey);

async function list(kind, fresh) {
  const d = await fetchJson(`${BASE}/${kind.list}?bypass_cache=${fresh ? 'true' : 'false'}`, {
    headers: { Authorization: `Bearer ${config.torboxKey}` },
  });
  return d.data || [];
}

function baseName(n) {
  return String(n || '').split('/').pop().toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, ' ').trim();
}

// Find the file the user is playing, by exact size (and name when available).
export async function findFile({ videoSize, filename }) {
  if (!enabled() || (!videoSize && !filename)) return null;
  const size = Number(videoSize);
  const fn = baseName(filename);
  for (const fresh of [false, true]) {
    for (const kind of KINDS) {
      let items;
      try { items = await list(kind, fresh); } catch { continue; }
      const hits = [];
      for (const it of items) {
        for (const f of it.files || []) {
          if (videoSize ? Number(f.size) === size : fn && baseName(f.name) === fn) hits.push({ kind, itemId: it.id, fileId: f.id, name: f.name, size: Number(f.size) });
        }
      }
      if (hits.length) {
        return hits.find((h) => fn && baseName(h.name) === fn) || hits[0];
      }
    }
  }
  return null;
}

// The file Stremio will most likely play after `hit`: the next episode from the same
// torrent/pack, or the same release's next file (names equal apart from numbers).
export async function nextFile(hit, isNext) {
  const pattern = (n) => baseName(n).replace(/\d+/g, '#');
  const files = [];
  for (const it of await list(hit.kind, false).catch(() => [])) {
    for (const f of it.files || []) {
      if (/\.(mkv|mp4|avi|m4v|ts|webm)$/i.test(f.name) && isNext(baseName(f.name))) files.push({ kind: hit.kind, itemId: it.id, fileId: f.id, name: f.name, size: Number(f.size) });
    }
  }
  return files.find((f) => f.itemId === hit.itemId) || files.find((f) => pattern(f.name) === pattern(hit.name)) || null;
}

// TorBox's own list cache can lag minutes behind a new download, so bypass it and keep a short in-memory copy.
let library = { at: 0, files: null };
export async function libraryFiles() {
  if (library.files && Date.now() - library.at < 60 * 1000) return library.files;
  const files = [];
  for (const [kindIndex, kind] of KINDS.entries()) {
    for (const it of await list(kind, true).catch(() => [])) {
      for (const f of it.files || []) files.push({ kindIndex, itemId: it.id, itemName: it.name || '', fileId: f.id, name: f.name, size: Number(f.size) });
    }
  }
  library = { at: Date.now(), files };
  return files;
}

export async function streamUrl(hit) {
  return cached('tb-url', `${hit.kind.dl}:${hit.itemId}:${hit.fileId}`, 3 * 3600, async () => {
    const p = new URLSearchParams({ token: config.torboxKey, [hit.kind.idParam]: String(hit.itemId), file_id: String(hit.fileId) });
    const d = await fetchJson(`${BASE}/${hit.kind.dl}?${p}`);
    return d.data;
  });
}
