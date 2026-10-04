export const config = {
  port: Number(process.env.PORT || 7000),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  cacheDir: process.env.CACHE_DIR || './cache',
  torboxKey: process.env.TORBOX_API_KEY || '',
  osKey: process.env.OPENSUBTITLES_API_KEY || '',
  osUser: process.env.OPENSUBTITLES_USERNAME || '',
  osPass: process.env.OPENSUBTITLES_PASSWORD || '',
  subdlKey: process.env.SUBDL_API_KEY || '',
  subsourceKey: process.env.SUBSOURCE_API_KEY || '',
  userAgent: 'TrAltyaziSync v0.1',
};
