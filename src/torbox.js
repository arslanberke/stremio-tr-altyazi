import { config } from './config.js';
import { fetchJson } from './http.js';
import { cached } from './cache.js';

const BASE = 'https://api.torbox.app/v1/api';
const KINDS = [
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
  return String(n || '').split('/').pop().toLowerCase();
}

// Find the file the user is playing, by exact size (and name when available).
export async function findFile({ videoSize, filename }) {
  if (!enabled() || !videoSize) return null;
  const size = Number(videoSize);
  for (const fresh of [false, true]) {
    for (const kind of KINDS) {
      let items;
      try { items = await list(kind, fresh); } catch { continue; }
      const hits = [];
      for (const it of items) {
        for (const f of it.files || []) {
          if (Number(f.size) === size) hits.push({ kind, itemId: it.id, fileId: f.id, name: f.name });
        }
      }
      if (hits.length) {
        const fn = baseName(filename);
        return hits.find((h) => fn && baseName(h.name) === fn) || hits[0];
      }
    }
  }
  return null;
}

export async function streamUrl(hit) {
  return cached('tb-url', `${hit.kind.dl}:${hit.itemId}:${hit.fileId}`, 3 * 3600, async () => {
    const p = new URLSearchParams({ token: config.torboxKey, [hit.kind.idParam]: String(hit.itemId), file_id: String(hit.fileId) });
    const d = await fetchJson(`${BASE}/${hit.kind.dl}?${p}`);
    return d.data;
  });
}
