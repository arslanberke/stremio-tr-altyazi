# Handoff notes for agents (Devin etc.)

Owner: Berke (arslanberke). Talk to him in **Turkish, very short**. He expects end-to-end work; he only does purchases/approvals.

## Two repos, keep them separate

| | `arslanberke/stremio-tr-altyazi` (this repo) | `arslanberke/syncit` |
|---|---|---|
| What | Berke's **private** Turkish subtitle addon | **Commercial** product (SyncIt) |
| Keys | Server-side env vars (Berke's own accounts) | Per-user keys encrypted into the addon URL (`CONFIG_SECRET`) |
| Debrid | TorBox only | TorBox, Real-Debrid, AllDebrid, Premiumize (`src/debrid/`) |
| Hosting | Render, service `srv-db1dg39srm7s73b68iig`, https://tr-altyazi-senkron.onrender.com | Mac + Cloudflare Tunnel → https://app.getsyncit.xyz, landing on Cloudflare Pages https://getsyncit.xyz |
| Deploy | Render auto-deploy from `main` (if it doesn't fire, trigger via Render API, see below) | **Never deploy unless Berke explicitly asks** |

Rule: when you fix sync/matching logic here, port the same fix to `syncit` (same file layout under `src/`), push it, but don't deploy SyncIt. Private-only tricks (e.g. unofficial Google Translate in `src/translate.js`) must NOT go to SyncIt (paid product, ToS).

## How a request flows

1. Stremio calls `GET /subtitles/:type/:id/:extra.json` (`src/server.js`). `id` is IMDb (`tt…`, series `tt…:S:E`); `extra` has `filename`, `videoSize`, `videoHash`. Filenames can contain a literal `+` — don't URL-decode it to a space.
2. `src/service.js` gathers Turkish candidates from `src/sources/*` (OpenSubtitles, SubDL, SubSource, AltyaziDB, local archives in `data/`). `src/episode.js` does strict season/episode matching (1x04 ≠ 104, season packs, anime absolute numbers, specials/season 0 matched by episode title).
3. Candidates are de-duplicated by downloaded text (same translation uploaded twice → shown once), broken encodings fixed (`src/subformat.js`, cp1254/UTF-16, stray Cyrillic lines → `src/translate.js`).
4. Each candidate is returned as a URL `/sub/:token.srt`. When fetched, the sub is re-timed:
   - **Reference** (`src/sync/reference.js`), in priority: embedded text subtitle in the TorBox file (exact file matched by name+size in `src/torbox.js`) → OpenSubtitles hash-matched sub → same-release sub → audio (VAD). For MP4, cue times are read from the `moov` index only (`src/sync/mp4index.js`), no video download. MKV/others: ffmpeg reads short windows.
   - **Alignment** (`src/sync/align.js`): global offset + fps ratio, then piecewise offsets (cuts/ad breaks). `driftReport` decides synced vs unsynced, `coverage` scores it.
   - CPU-heavy alignment runs in a low-priority child process (`src/sync/offload.js` + `worker.js`), serialized. **Don't move it back into the main process**: Render's 5 s health check (`/health`) times out and restarts the server (this happened twice).
5. Labels in Stremio: `✅ Videoya senkron` (synced), `⏳` (still preparing). Response header `x-sync-status: synced|unsynced`.
6. Results cached in `src/cache.js` (local `CACHE_DIR` + Supabase store). Bump the key version (e.g. `v1:` → `v2:`) when changing what's cached.

Other routes: `/manifest.json`, `/health`, `/nuvio/manifest.json` (filtered Anthology plugin repo for the Nuvio app).

## Env vars (values are in Render, never commit them)
`TORBOX_API_KEY`, `OPENSUBTITLES_API_KEY` / `_USERNAME` / `_PASSWORD`, `SUBDL_API_KEY`, `SUBSOURCE_API_KEY`, `ALTYAZIDB_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PUBLIC_URL`, `CACHE_DIR`, `PORT`.

## Run / test
```
npm ci
npm test                 # node --test, must stay green
npm start                # http://localhost:7000/manifest.json (needs ffmpeg)
```

## Deploy + verify (private addon)
- Push/merge to `main` → Render builds the Dockerfile. Auto-deploy didn't fire once; then:
  `curl -X POST -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" -d '{"commitId":"<sha>"}' https://api.render.com/v1/services/srv-db1dg39srm7s73b68iig/deploys`
- Wait for status `live`, then check `/health`, `/manifest.json` and a real request, e.g.
  `curl https://tr-altyazi-senkron.onrender.com/subtitles/series/tt19244304:0:13.json`
  (add `/filename=<name>&videoSize=<bytes>.json` of a file in TorBox to test real sync).
- Render free tier is weak (512 MB). First open of a huge file can be slow; avoid anything that blocks the event loop >5 s.

## Hard limits
- Don't bypass Cloudflare/CAPTCHA/bot checks (Dizipal, anime sites). Berke will push; the answer stays no.
- Never print or commit keys. Don't merge or deploy SyncIt without being asked.
