const REQUEST_TIMEOUT_MS = Number(process.env.SEANIME_TIMEOUT_MS || 12000);

const BASE_URLS = [
  ...new Set((
  process.env.SEANIME_BASE_URLS ||
  [
    process.env.SEANIME_BASE_URL,
    'http://127.0.0.1:43211',
    'http://localhost:43211',
    'http://127.0.0.1:43000',
    'http://localhost:43000',
    'http://127.0.0.1:43210',
    'http://localhost:43210'
  ]
    .filter(Boolean)
    .join(',')
)
  .split(',')
  .map((v) => v.trim().replace(/\/+$/, ''))
  .filter(Boolean))
];

const preferredProvider = String(process.env.SEANIME_ONLINESTREAM_PROVIDER || 'anicrush').trim();
const preferredProviders = String(process.env.SEANIME_ONLINESTREAM_PROVIDERS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.headers || {})
      }
    });
    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch (_) {}
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function withBaseFallback(work, errorPrefix) {
  const failures = [];
  for (const baseUrl of BASE_URLS) {
    try {
      return await work(baseUrl);
    } catch (error) {
      failures.push(`${baseUrl}: ${error.message}`);
    }
  }
  throw new Error(`${errorPrefix}. Tried ${failures.length} SeaAnime URL(s): ${failures.join(' | ')}`);
}

async function listInstalledProviders(baseUrl) {
  const payload = await fetchJson(`${baseUrl}/api/v1/extensions/list/onlinestream-provider`);
  const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
  if (!list.length) {
    throw new Error('No SeaAnime onlinestream providers installed. Install one in SeaAnime: Extensions -> Marketplace -> type=onlinestream-provider');
  }
  return list.map((item) => String(item?.id || '').trim()).filter(Boolean);
}

async function resolveProviderCandidates(baseUrl, options = {}) {
  const requestPreferred = String(options.preferredProvider || '').trim();
  const requestPreferredProviders = Array.isArray(options.preferredProviders)
    ? options.preferredProviders.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  const installed = await listInstalledProviders(baseUrl);
  return [
    ...new Set([
      requestPreferred,
      ...requestPreferredProviders,
      preferredProvider,
      ...preferredProviders,
      ...installed
    ].filter(Boolean))
  ];
}

function unwrapData(payload) {
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
    return payload.data;
  }
  return payload;
}

function normalizeEpisodeList(payload) {
  const body = unwrapData(payload);
  const episodes = Array.isArray(body?.episodes) ? body.episodes : [];
  return episodes
    .map((ep) => {
      const number = Number(ep?.number);
      if (!Number.isFinite(number) || number < 1) return null;
      return {
        number,
        title: ep?.title || `Episode ${number}`
      };
    })
    .filter(Boolean);
}

function normalizeSources(payload, providerId = '') {
  const body = unwrapData(payload);
  const list = Array.isArray(body?.videoSources) ? body.videoSources : [];
  return list
    .map((src) => {
      const url = src?.url;
      if (!url) return null;
      return {
        server: String(src?.server || 'seanime'),
        url,
        label: src?.label || src?.quality || 'Source',
        quality: String(src?.quality || 'auto'),
        type: String(src?.type || 'unknown').toLowerCase(),
        provider: providerId || undefined,
        headers: src?.headers || undefined,
        subtitles: Array.isArray(src?.subtitles) ? src.subtitles : undefined
      };
    })
    .filter(Boolean);
}

async function tryManualMatch(baseUrl, provider, mediaId, anime, dubbed) {
  const queries = [
    anime?.titleRomaji,
    anime?.titleEnglish,
    anime?.title
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  for (const query of queries) {
    const searchPayload = await fetchJson(`${baseUrl}/api/v1/onlinestream/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        query,
        dubbed: Boolean(dubbed)
      })
    });
    const searchData = unwrapData(searchPayload);
    const results = Array.isArray(searchData) ? searchData : [];
    const first = results[0];
    const animeId = String(first?.id || '').trim();
    if (!animeId) continue;

    await fetchJson(`${baseUrl}/api/v1/onlinestream/manual-mapping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        mediaId: Number(mediaId),
        animeId
      })
    });
    return true;
  }

  return false;
}

module.exports = {
  id: 'seanime',
  name: 'SeaAnime Bridge',
  async getEpisodeList({ mediaId, anime, dubbed = false, seaProvider, seaProviders = [] }) {
    return withBaseFallback(async (baseUrl) => {
      const providers = await resolveProviderCandidates(baseUrl, {
        preferredProvider: seaProvider,
        preferredProviders: seaProviders
      });
      const failures = [];

      for (const provider of providers) {
        let payload = await fetchJson(`${baseUrl}/api/v1/onlinestream/episode-list`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mediaId: Number(mediaId),
            dubbed: Boolean(dubbed),
            provider
          })
        });

        const episodes = normalizeEpisodeList(payload);
        if (!episodes.length) {
          const mapped = await tryManualMatch(baseUrl, provider, mediaId, anime, dubbed).catch(() => false);
          if (mapped) {
            payload = await fetchJson(`${baseUrl}/api/v1/onlinestream/episode-list`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mediaId: Number(mediaId),
                dubbed: Boolean(dubbed),
                provider
              })
            });
          }
        }
        const retryEpisodes = normalizeEpisodeList(payload);
        if (retryEpisodes.length) {
          return retryEpisodes;
        }
        failures.push(`${provider}: empty episode list`);
      }

      throw new Error(`SeaAnime returned empty episodes across providers (${failures.join(' | ')})`);
    }, 'SeaAnime episode-list failed');
  },
  async getEpisodeSources({ mediaId, episodeNumber, dubbed = false, seaProvider, seaProviders = [] }) {
    return withBaseFallback(async (baseUrl) => {
      const providers = await resolveProviderCandidates(baseUrl, {
        preferredProvider: seaProvider,
        preferredProviders: seaProviders
      });
      const failures = [];

      for (const provider of providers) {
        try {
          const payload = await fetchJson(`${baseUrl}/api/v1/onlinestream/episode-source`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mediaId: Number(mediaId),
              episodeNumber: Number(episodeNumber),
              dubbed: Boolean(dubbed),
              provider
            })
          });

          const videoSources = normalizeSources(payload, provider);
          if (!videoSources.length) {
            failures.push(`${provider}: empty source list`);
            continue;
          }

          const body = unwrapData(payload);
          return {
            number: Number(body?.number || episodeNumber),
            videoSources,
            debug: {
              providerUsed: provider,
              providersTried: providers
            }
          };
        } catch (error) {
          failures.push(`${provider}: ${error.message}`);
        }
      }

      throw new Error(`SeaAnime returned no playable sources across providers (${failures.join(' | ')})`);
    }, 'SeaAnime episode-source failed');
  }
};
