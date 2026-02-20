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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    const providers = data
      .map((item) => ({
        id: String(item?.id || '').trim(),
        name: String(item?.name || item?.id || '').trim()
      }))
      .filter((item) => item.id);
    return res.json(providers);
  } catch (error) {
    return res.status(500).json({ error: error.message });
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
      source,
      dubbed,
      seaProvider,
      seaProviders
    });

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
      requested: { mediaId, episodeNumber, source, dubbed, seaProvider, seaProviders },
      sourceCount: Array.isArray(payload?.videoSources) ? payload.videoSources.length : 0,
      servers: [...new Set((payload?.videoSources || []).map((s) => s.server).filter(Boolean))],
      debug: payload?.debug || null,
      firstSource: payload?.videoSources?.[0] || null
    });
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

