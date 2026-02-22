const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const cors = require('cors');

const { listAnime, getAnimeDetails } = require('./services/anime-data');
const { getProvider, listProviders } = require('./onlinestream-providers');

const app = express();
const PORT = process.env.PORT || 3000;
const LOCAL_AUTH_PATH = path.join(__dirname, 'data', 'auth', 'anilist-token.json');
const ANILIST_OAUTH_URL = 'https://anilist.co/api/v2/oauth/authorize';
const ANILIST_TOKEN_URL = 'https://anilist.co/api/v2/oauth/token';
const ALL_ANIME_CACHE_TTL_MS = 10 * 60 * 1000;
const allAnimeCache = new Map();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function convertSrtToVtt(text) {
  const normalized = String(text || '').replace(/\r+/g, '');
  const withWebVtt = normalized.startsWith('WEBVTT') ? normalized : `WEBVTT\n\n${normalized}`;
  return withWebVtt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

function rewriteM3u8ToProxy(manifestText, baseUrl, provider) {
  const toProxyUrl = (rawUrl) => {
    let absolute;
    try {
      absolute = new URL(String(rawUrl || '').trim(), baseUrl).toString();
    } catch (_) {
      return rawUrl;
    }
    return `/api/onlinestream/proxy?provider=${encodeURIComponent(provider)}&url=${encodeURIComponent(absolute)}`;
  };

  const lines = String(manifestText || '').split(/\r?\n/);
  return lines
    .map((line) => {
      const raw = String(line || '').trim();
      if (!raw) {
        return line;
      }

      if (raw.startsWith('#')) {
        if (!raw.includes('URI="')) return line;
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${toProxyUrl(uri)}"`);
      }

      if (raw.startsWith('data:')) {
        return line;
      }
      return toProxyUrl(raw);
    })
    .join('\n');
}

async function fetchWithHeaderPreservingRedirects(url, headers, maxRedirects = 5) {
  let currentUrl = String(url || '');
  for (let i = 0; i <= maxRedirects; i += 1) {
    const response = await fetch(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual'
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = String(response.headers.get('location') || '').trim();
    if (!location) {
      return response;
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error('Too many upstream redirects');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getClientConfig() {
  const streamApiBaseUrl = String(process.env.ONLINESTREAM_API_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  return { streamApiBaseUrl };
}

app.get('/api/client-config', (req, res) => {
  return res.json(getClientConfig());
});

function getAnilistOAuthConfig() {
  const clientId = String(process.env.ANILIST_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.ANILIST_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.ANILIST_REDIRECT_URI || 'http://localhost:3000/auth/anilist/callback').trim();
  return { clientId, clientSecret, redirectUri };
}

async function getSavedAnilistToken() {
  const envToken = String(process.env.ANILIST_TOKEN || '').trim();
  if (envToken) {
    return envToken;
  }

  try {
    const raw = await fs.readFile(LOCAL_AUTH_PATH, 'utf8');
    const payload = JSON.parse(raw);
    return String(payload?.token || '').trim();
  } catch (_) {
    return '';
  }
}

function getSeaAnimeBaseUrls() {
  const envBaseUrls = String(process.env.SEANIME_BASE_URLS || '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const preferred = String(process.env.SEANIME_BASE_URL || '').trim().replace(/\/+$/, '');

  return [
    ...new Set(
      [
        ...(preferred ? [preferred] : []),
        ...envBaseUrls,
        'https://seaanime-1.onrender.com',
        'http://127.0.0.1:43211',
        'http://localhost:43211',
        'http://127.0.0.1:43000',
        'http://localhost:43000'
      ].filter(Boolean)
    )
  ];
}

async function seaAnimeRequest(pathname, init = {}) {
  const baseUrls = getSeaAnimeBaseUrls();
  const failures = [];

  for (const baseUrl of baseUrls) {
    try {
      const response = await fetch(`${baseUrl}${pathname}`, init);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        failures.push(`${baseUrl}: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ''}`);
        continue;
      }
      const payload = await response.json().catch(() => ({}));
      return payload;
    } catch (error) {
      failures.push(`${baseUrl}: ${error.message}`);
    }
  }

  throw new Error(`SeaAnime request failed. Tried ${failures.length} URL(s): ${failures.join(' | ')}`);
}

app.get('/api/anime', async (req, res) => {
  const page = Number(req.query.page || 1);
  const perPage = Number(req.query.perPage || 18);
  const search = String(req.query.search || '').trim();
  const source = String(req.query.source || 'anilist').toLowerCase();

  try {
    const anilistToken = source === 'anilist' ? await getSavedAnilistToken() : '';
    const list = await listAnime({ page, perPage, search, source, anilistToken });
    return res.json(list);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/anime/all', async (req, res) => {
  const source = String(req.query.source || 'anilist').toLowerCase();
  const forceRefresh = String(req.query.refresh || '').toLowerCase() === 'true';
  const cacheKey = source;
  const cached = allAnimeCache.get(cacheKey);

  if (!forceRefresh && cached && Date.now() - cached.createdAt < ALL_ANIME_CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  const perPage = source === 'anilist' ? 50 : 25;
  const maxPages = source === 'anilist' ? 200 : 40;
  const mergedById = new Map();

  try {
    const anilistToken = source === 'anilist' ? await getSavedAnilistToken() : '';
    for (let page = 1; page <= maxPages; page += 1) {
      let chunk = [];
      try {
        chunk = await listAnime({ page, perPage, search: '', source, anilistToken });
      } catch (pageError) {
        // Return a partial catalog instead of failing the whole request on rate-limit spikes.
        if (mergedById.size > 0) {
          break;
        }
        throw pageError;
      }
      if (!Array.isArray(chunk) || chunk.length === 0) {
        break;
      }

      chunk.forEach((anime) => {
        if (anime?.id != null) {
          mergedById.set(String(anime.id), anime);
        }
      });

      if (chunk.length < perPage) {
        break;
      }

      if (source === 'anilist') {
        await wait(250);
      }
    }

    const data = Array.from(mergedById.values());
    allAnimeCache.set(cacheKey, { createdAt: Date.now(), data });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/anime/:id', async (req, res) => {
  const animeId = Number(req.params.id);
  const source = String(req.query.source || 'anilist').toLowerCase();

  if (Number.isNaN(animeId)) {
    return res.status(400).json({ error: 'Invalid anime id' });
  }

  try {
    const anilistToken = source === 'anilist' ? await getSavedAnilistToken() : '';
    const anime = await getAnimeDetails(animeId, source, anilistToken);
    if (!anime) {
      return res.status(404).json({ error: 'Anime not found' });
    }

    return res.json(anime);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Seanime-style provider list.
app.get('/api/onlinestream/providers', (req, res) => {
  return res.json(listProviders());
});

app.get('/api/onlinestream/seanime/providers', async (req, res) => {
  try {
    const payload = await seaAnimeRequest('/api/v1/extensions/list/onlinestream-provider');
    const data = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
    const blockedProviders = new Set(['animesaturn', 'sudatchi', 'anizone']);
    const normalizeProviderKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const providers = data
      .map((item) => ({
        id: String(item?.id || '').trim(),
        name: String(item?.name || item?.id || '').trim()
      }))
      .filter((item) => {
        if (!item.id) return false;
        const idKey = normalizeProviderKey(item.id);
        const nameKey = normalizeProviderKey(item.name);
        return !blockedProviders.has(idKey) && !blockedProviders.has(nameKey);
      });
    return res.json(providers);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/subtitles/search', async (req, res) => {
  const mediaId = Number(req.body?.mediaId);
  const source = String(req.body?.source || 'anilist').toLowerCase();
  const episodeNumber = Number(req.body?.episodeNumber || 1);
  const seasonNumber = Number(req.body?.seasonNumber || 1);
  const language = String(req.body?.language || 'all').trim().toLowerCase();
  const format = String(req.body?.format || 'all').trim().toLowerCase();
  const hi = String(req.body?.hi || '').toLowerCase() === 'true' || req.body?.hi === true;

  if (!Number.isFinite(mediaId)) {
    return res.status(400).json({ error: 'Invalid mediaId' });
  }

  try {
    const anilistToken = source === 'anilist' ? await getSavedAnilistToken() : '';
    const anime = await getAnimeDetails(mediaId, source, anilistToken);
    const isMovie = String(anime?.type || '').toUpperCase() === 'MOVIE';

    let subtitleId = '';
    if (source === 'anilist') {
      const mapperRes = await fetch(`https://ramregar97-idmapper.hf.space/api/mapper?anilist_id=${mediaId}`);
      if (mapperRes.ok) {
        const mapped = await mapperRes.json();
        subtitleId = String(
          isMovie
            ? (mapped?.tmdb_movie_id || mapped?.themoviedb_id || mapped?.imdb_id || '')
            : (mapped?.tmdb_show_id || mapped?.themoviedb_id || mapped?.imdb_id || '')
        ).trim();
      }
    }

    if (!subtitleId) {
      return res.json({ results: [], reason: 'No TMDB/IMDB mapping found' });
    }

    const searchUrl = new URL('https://sub.wyzie.ru/search');
    searchUrl.searchParams.set('id', subtitleId);
    if (!isMovie) {
      searchUrl.searchParams.set('season', String(seasonNumber));
      searchUrl.searchParams.set('episode', String(episodeNumber));
    }
    if (language !== 'all') searchUrl.searchParams.set('language', language);
    if (format !== 'all') searchUrl.searchParams.set('format', format);
    if (hi) searchUrl.searchParams.set('isHearingImpaired', 'true');

    const subsRes = await fetch(searchUrl.toString());
    if (!subsRes.ok) {
      const body = await subsRes.text().catch(() => '');
      return res.status(502).json({ error: `Subtitle API failed with ${subsRes.status}`, details: body.slice(0, 200) });
    }

    const raw = await subsRes.json();
    const results = Array.isArray(raw) ? raw : [];
    return res.json({
      subtitleId,
      isMovie,
      results: results.slice(0, 80)
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/subtitles/file', async (req, res) => {
  const rawUrl = String(req.query.url || '').trim();
  const format = String(req.query.format || '').trim().toLowerCase();
  if (!rawUrl) {
    return res.status(400).send('Missing subtitle URL');
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch (_) {
    return res.status(400).send('Invalid subtitle URL');
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    return res.status(400).send('Unsupported URL protocol');
  }

  try {
    const response = await fetch(target.toString());
    if (!response.ok) {
      return res.status(502).send(`Failed to fetch subtitle (${response.status})`);
    }

    const body = await response.text();
    const type = response.headers.get('content-type') || '';
    const isSrt = format === 'srt' || type.includes('application/x-subrip') || /\.srt($|\?)/i.test(target.pathname);
    const isVtt = format === 'vtt' || type.includes('text/vtt') || /\.vtt($|\?)/i.test(target.pathname);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (isSrt) {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      return res.send(convertSrtToVtt(body));
    }
    if (isVtt) {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      return res.send(body);
    }

    // Default to VTT to keep browser text-track parsing consistent across origins.
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    return res.send(body);
  } catch (error) {
    return res.status(500).send(error.message);
  }
});

app.post('/api/auth/anilist-token', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) {
    return res.status(400).json({ error: 'Missing AniList token' });
  }

  if (process.env.VERCEL === '1') {
    return res.status(501).json({
      error: 'Token file writes are disabled on Vercel. Set ANILIST_TOKEN in Vercel environment variables.'
    });
  }

  try {
    await fs.mkdir(path.dirname(LOCAL_AUTH_PATH), { recursive: true });
    const savedAt = new Date().toISOString();
    await fs.writeFile(
      LOCAL_AUTH_PATH,
      JSON.stringify({ token, savedAt }, null, 2),
      'utf8'
    );
    return res.json({ ok: true, savedAt });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/anilist-token/status', async (req, res) => {
  const envToken = String(process.env.ANILIST_TOKEN || '').trim();
  if (envToken) {
    return res.json({ configured: true, savedAt: 'env' });
  }

  try {
    const raw = await fs.readFile(LOCAL_AUTH_PATH, 'utf8');
    const payload = JSON.parse(raw);
    return res.json({ configured: Boolean(payload?.token), savedAt: payload?.savedAt || null });
  } catch (_) {
    return res.json({ configured: false, savedAt: null });
  }
});

app.get('/api/auth/anilist/start', (req, res) => {
  const { clientId, redirectUri } = getAnilistOAuthConfig();
  if (!clientId) {
    return res.status(500).json({ error: 'ANILIST_CLIENT_ID is not set' });
  }

  const authUrl = new URL(ANILIST_OAUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  res.redirect(authUrl.toString());
});

app.get('/auth/anilist/callback', async (req, res) => {
  const code = String(req.query.code || '').trim();
  const error = String(req.query.error || '').trim();
  const { clientId, clientSecret, redirectUri } = getAnilistOAuthConfig();

  if (error) {
    return res.status(400).send(`AniList auth error: ${error}`);
  }
  if (!code) {
    return res.status(400).send('Missing AniList authorization code');
  }
  if (!clientId || !clientSecret) {
    return res.status(500).send('AniList OAuth is not configured (missing client id/secret)');
  }

  try {
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
    body.set('redirect_uri', redirectUri);
    body.set('code', code);

    const response = await fetch(ANILIST_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString()
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      throw new Error(`AniList token exchange failed: HTTP ${response.status} ${txt.slice(0, 200)}`);
    }

    const payload = await response.json();
    if (!payload?.access_token) {
      throw new Error('AniList token exchange returned no access_token');
    }

    await fs.mkdir(path.dirname(LOCAL_AUTH_PATH), { recursive: true });
    const savedAt = new Date().toISOString();
    await fs.writeFile(
      LOCAL_AUTH_PATH,
      JSON.stringify({
        token: payload.access_token,
        savedAt,
        expiresIn: payload.expires_in || null,
        tokenType: payload.token_type || null
      }, null, 2),
      'utf8'
    );

    return res.redirect('/?anilist_auth=success');
  } catch (authError) {
    return res.status(500).send(`AniList OAuth callback failed: ${authError.message}`);
  }
});

// Seanime-style episode list endpoint.
app.post('/api/onlinestream/episode-list', async (req, res) => {
  const mediaId = Number(req.body?.mediaId);
  const source = String(req.body?.source || 'anilist').toLowerCase();
  const dubbed = Boolean(req.body?.dubbed);
  const providerId = String(req.body?.provider || 'seanime').toLowerCase();
  const seaProvider = String(req.body?.seaProvider || '').trim();
  const seaProviders = Array.isArray(req.body?.seaProviders)
    ? req.body.seaProviders.map((v) => String(v || '').trim()).filter(Boolean)
    : [];

  if (Number.isNaN(mediaId)) {
    return res.status(400).json({ error: 'Invalid mediaId' });
  }

  try {
    const anilistToken = source === 'anilist' ? await getSavedAnilistToken() : '';
    const anime = await getAnimeDetails(mediaId, source, anilistToken);
    if (!anime) {
      return res.status(404).json({ error: 'Anime not found' });
    }

    const provider = getProvider(providerId);
    const episodes = await provider.getEpisodeList({
      anime,
      mediaId,
      source,
      dubbed,
      seaProvider,
      seaProviders
    });

    return res.json({
      media: anime,
      provider: { id: provider.id, name: provider.name },
      episodes
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Seanime-style episode source endpoint.
app.post('/api/onlinestream/episode-source', async (req, res) => {
  const mediaId = Number(req.body?.mediaId);
  const episodeNumber = Number(req.body?.episodeNumber);
  const source = String(req.body?.source || 'anilist').toLowerCase();
  const dubbed = Boolean(req.body?.dubbed);
  const server = String(req.body?.server || '').trim();
  const providerId = String(req.body?.provider || 'seanime').toLowerCase();
  const seaProvider = String(req.body?.seaProvider || '').trim();
  const seaProviders = Array.isArray(req.body?.seaProviders)
    ? req.body.seaProviders.map((v) => String(v || '').trim()).filter(Boolean)
    : [];

  if (Number.isNaN(mediaId) || Number.isNaN(episodeNumber) || episodeNumber < 1) {
    return res.status(400).json({ error: 'Invalid request parameters' });
  }

  try {
    const anilistToken = source === 'anilist' ? await getSavedAnilistToken() : '';
    const anime = await getAnimeDetails(mediaId, source, anilistToken);
    if (!anime) {
      return res.status(404).json({ error: 'Anime not found' });
    }

    const provider = getProvider(providerId);
    const payload = await provider.getEpisodeSources({
      anime,
      mediaId,
      episodeNumber,
      server,
      source,
      dubbed,
      seaProvider,
      seaProviders
    });

    if (Array.isArray(payload?.videoSources)) {
      payload.videoSources = payload.videoSources.map((item) => {
        const sourceUrl = String(item?.url || '').trim();
        if (!sourceUrl) {
          return item;
        }
        const sourceType = String(item?.type || '').toLowerCase();
        const isEmbeddable = sourceType === 'embed' || sourceType === 'youtube';
        // consumet + hianime providers handle their own auth/CF — no proxy needed
        const forceProxyForConsumet = (
          provider.id === 'consumet-hianime' ||
          provider.id === 'consumet-animekai' ||
          provider.id === 'consumet-animepahe' ||
          (provider.id === 'consumet' && (seaProvider === 'hianime' || seaProvider === 'animekai' || seaProvider === 'animepahe'))
        );
        const isNoProxyProvider = (
          provider.id === 'seanime'
        );
        const needsProxy = !isEmbeddable && (forceProxyForConsumet || (!isNoProxyProvider && (
          provider.id === 'anicrush' ||
          provider.id === 'uniquestream'
        )));
        if (!needsProxy) {
          return item;
        }
        let proxyProviderId = provider.id;
        if (provider.id === 'consumet-hianime' || (provider.id === 'consumet' && seaProvider === 'hianime')) {
          proxyProviderId = 'hianime';
        }
        return {
          ...item,
          url: `/api/onlinestream/proxy?provider=${encodeURIComponent(proxyProviderId)}&url=${encodeURIComponent(sourceUrl)}`,
          headers: undefined
        };
      });
    }

    return res.json({
      provider: { id: provider.id, name: provider.name },
      ...payload
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/onlinestream/debug', async (req, res) => {
  const mediaId = Number(req.body?.mediaId);
  const episodeNumber = Number(req.body?.episodeNumber || 1);
  const source = String(req.body?.source || 'anilist').toLowerCase();
  const dubbed = Boolean(req.body?.dubbed);
  const server = String(req.body?.server || '').trim();
  const providerId = String(req.body?.provider || 'seanime').toLowerCase();
  const seaProvider = String(req.body?.seaProvider || '').trim();
  const seaProviders = Array.isArray(req.body?.seaProviders)
    ? req.body.seaProviders.map((v) => String(v || '').trim()).filter(Boolean)
    : [];

  if (Number.isNaN(mediaId) || mediaId < 1) {
    return res.status(400).json({ error: 'Invalid mediaId' });
  }

  try {
    const anilistToken = source === 'anilist' ? await getSavedAnilistToken() : '';
    const anime = await getAnimeDetails(mediaId, source, anilistToken);
    if (!anime) {
      return res.status(404).json({ error: 'Anime not found' });
    }

    const provider = getProvider(providerId);
    const payload = await provider.getEpisodeSources({
      anime,
      mediaId,
      episodeNumber,
      server,
      source,
      dubbed,
      seaProvider,
      seaProviders
    });

    return res.json({
      ok: true,
      anime: {
        id: anime.id,
        idMal: anime.idMal || null,
        title: anime.title,
        titleRomaji: anime.titleRomaji || null,
        titleEnglish: anime.titleEnglish || null
      },
      provider: provider.id,
      requested: { mediaId, episodeNumber, source, dubbed, server, seaProvider, seaProviders },
      sourceCount: Array.isArray(payload?.videoSources) ? payload.videoSources.length : 0,
      servers: [...new Set((payload?.videoSources || []).map((s) => s.server).filter(Boolean))],
      debug: payload?.debug || null,
      firstSource: payload?.videoSources?.[0] || null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/onlinestream/proxy', async (req, res) => {
  const rawUrl = String(req.query.url || '').trim();
  const provider = String(req.query.provider || '').trim().toLowerCase();

  if (!rawUrl) {
    return res.status(400).json({ error: 'Missing url' });
  }

  let target;
  try {
    target = new URL(rawUrl);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid url' });
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return res.status(400).json({ error: 'Unsupported protocol' });
  }

  const requestHeaders = {
    Accept: '*/*',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
  };

  if (provider === 'anicrush') {
    requestHeaders.Referer = 'https://megacloud.club/';
    requestHeaders.Origin = 'https://megacloud.club';
  } else if (provider === 'uniquestream') {
    requestHeaders.Referer = 'https://anime.uniquestream.net/';
    requestHeaders.Origin = 'https://anime.uniquestream.net';
  } else if (provider === 'hianime') {
    requestHeaders.Referer = 'https://megacloud.club/';
    requestHeaders.Origin = 'https://megacloud.club';
  } else if (provider.startsWith('consumet')) {
    // Generic fallback for Consumet-hosted CDNs.
    requestHeaders.Referer = `${target.origin}/`;
    requestHeaders.Origin = target.origin;
  }

  const range = String(req.headers.range || '').trim();
  if (range) {
    requestHeaders.Range = range;
  }

  try {
    const upstream = await fetchWithHeaderPreservingRedirects(target.toString(), requestHeaders);

    if (!upstream.ok && upstream.status !== 206) {
      const text = await upstream.text().catch(() => '');
      return res.status(upstream.status).send(text || `Proxy upstream failed (${upstream.status})`);
    }

    const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
    const isM3u8 = contentType.includes('mpegurl') || /\.m3u8($|\?)/i.test(target.pathname);

    const passthroughHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
      'etag',
      'last-modified'
    ];

    passthroughHeaders.forEach((name) => {
      const value = upstream.headers.get(name);
      if (value) {
        res.setHeader(name, value);
      }
    });

    res.status(upstream.status);
    if (isM3u8) {
      res.removeHeader('content-length');
      const body = await upstream.text();
      const rewritten = rewriteM3u8ToProxy(body, target.toString(), provider);
      return res.send(rewritten);
    }

    if (!upstream.body) {
      return res.end();
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`Anime streaming starter running at http://localhost:${PORT}`);
  });
}

module.exports = app;

