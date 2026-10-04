import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('data/subs');

// data/subs/<imdb>/<season>x<episode>/*.srt (series) or data/subs/<imdb>/*.srt (movie)
export async function search({ imdb, season, episode }) {
  const dir = path.join(ROOT, imdb, season != null ? `${season}x${episode}` : '');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  return names.filter((n) => /\.(srt|ass|ssa|vtt|sub)$/i.test(n)).map((n) => ({
    source: 'local',
    ref: path.relative(ROOT, path.join(dir, n)),
    lang: 'tr',
    release: n.replace(/\.[^.]+$/, ''),
    fileName: n,
    fps: null,
    hashMatch: false,
    downloads: 0,
    fromTrusted: true,
    season,
    episode,
    loose: false,
  }));
}

export async function download(ref) {
  const f = path.resolve(ROOT, ref);
  if (!f.startsWith(ROOT + path.sep)) throw new Error('bad ref');
  return fs.readFile(f);
}
