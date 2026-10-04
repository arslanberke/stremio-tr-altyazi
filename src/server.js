import express from 'express';
import { config } from './config.js';
import { listSubtitles, buildSubtitle } from './service.js';

const manifest = {
  id: 'community.tr-altyazi-sync',
  version: '0.1.0',
  name: 'TR Altyazı Senkron',
  description: 'Türkçe altyazıları OpenSubtitles ve SubDL\'den bulur, izlediğin dosyaya göre senkronlar.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

const base = (req) => `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;

app.get('/', (req, res) => {
  const m = `${config.publicUrl || base(req)}/manifest.json`;
  res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width"><title>${manifest.name}</title>
<body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<h1>${manifest.name}</h1><p>${manifest.description}</p>
<p><a href="stremio://${m.replace(/^https?:\/\//, '')}">Stremio'ya yükle</a></p>
<p>ya da bu adresi Stremio → Eklentiler → arama kutusuna yapıştır:<br><code>${m}</code></p></body>`);
});

app.get('/manifest.json', (req, res) => res.json(manifest));

app.get(['/subtitles/:type/:id/:extra.json', '/subtitles/:type/:id.json'], async (req, res) => {
  try {
    const subtitles = await listSubtitles(req.params.type, req.params.id, req.params.extra, base(req));
    res.setHeader('Cache-Control', 'max-age=600');
    res.json({ subtitles });
  } catch (e) {
    console.error('subtitles error', e);
    res.json({ subtitles: [] });
  }
});

app.get('/sub/:token.srt', async (req, res) => {
  try {
    const out = await buildSubtitle(req.params.token);
    res.setHeader('X-Sync-Status', out.status);
    res.type('application/x-subrip; charset=utf-8').send(out.srt);
  } catch (e) {
    console.error('sub error', e.message);
    res.status(404).send('');
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(config.port, () => console.log(`listening on :${config.port}`));
