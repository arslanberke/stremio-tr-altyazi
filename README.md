---
title: TR Altyazi Senkron
emoji: 🎬
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# TR Altyazı Senkron (Stremio eklentisi)

Türkçe altyazıları OpenSubtitles ve SubDL'den bulur ve oynattığın dosyaya göre yeniden zamanlar.

- **Doğru bölüm:** sezon/bölüm sıkı kontrol edilir (1x04 ≠ 104), sezon paketlerinden doğru dosya seçilir.
- **Senkron referansı:** dosya TorBox hesabındaysa videonun gömülü altyazısı (yoksa sesi) birkaç örnek pencereden okunur; değilse OpenSubtitles'ta dosya hash'ine uyan altyazı kullanılır.
- **Hizalama:** sabit kayma + kare hızı farkı (23.976/24/25) + bölüm bazlı ince ayar (kesik sahneler, reklam araları).
- **Karakterler:** Windows-1254 / UTF-8 / UTF-16 otomatik çözülür, çıktı UTF-8 SRT.

## Ortam değişkenleri

| Değişken | |
|---|---|
| `OPENSUBTITLES_API_KEY`, `OPENSUBTITLES_USERNAME`, `OPENSUBTITLES_PASSWORD` | OpenSubtitles.com |
| `SUBDL_API_KEY` | SubDL (opsiyonel) |
| `TORBOX_API_KEY` | TorBox (videoya göre senkron için) |
| `PUBLIC_URL` | Dış adres (opsiyonel) |

## Çalıştırma

```
npm ci
npm test
npm start   # http://localhost:7000/manifest.json
```

Gereken: Node 20+, ffmpeg.
