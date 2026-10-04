import AdmZip from 'adm-zip';
import { isSubtitleFile } from './subformat.js';
import { episodeMatches } from './episode.js';

function isZip(buf) {
  return buf[0] === 0x50 && buf[1] === 0x4b;
}

// Returns [{ name, data }] subtitle files, unpacking zips.
export function unpack(buf, name = 'sub.srt') {
  if (!isZip(buf)) return [{ name, data: buf }];
  const zip = new AdmZip(buf);
  return zip
    .getEntries()
    .filter((e) => !e.isDirectory && isSubtitleFile(e.entryName) && !/__MACOSX/.test(e.entryName))
    .map((e) => ({ name: e.entryName.split('/').pop(), data: e.getData() }));
}

// Pick the file for the requested episode; never guess across episodes.
export function pickFile(files, season, episode, ctx = {}) {
  if (season == null) {
    return files.filter((f) => !/sample/i.test(f.name)).sort((a, b) => b.data.length - a.data.length)[0] || null;
  }
  const exact = files.filter((f) => episodeMatches(f.name, season, episode, ctx) === true);
  if (exact.length) return exact[0];
  if (files.length === 1 && episodeMatches(files[0].name, season, episode, ctx) === null) return files[0];
  return null;
}
