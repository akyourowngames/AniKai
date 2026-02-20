const REQUEST_TIMEOUT_MS = Number(process.env.CONSUMET_TIMEOUT_MS || 15000);

const BASE_URLS = (
  process.env.CONSUMET_API_BASE_URLS ||
  [
    process.env.CONSUMET_API_BASE_URL,
    'https://api.consumet.org',
    'https://api-consumet.vercel.app'
  ]
    .filter(Boolean)
    .join(',')
)
  .split(',')
  .map((v) => v.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const ENGINES = (
  process.env.CONSUMET_ANIME_ENGINES ||
  [
    process.env.CONSUMET_ANIME_ENGINE,
    'gogoanime',
    'zoro',
    'animepahe'
  ]
    .filter(Boolean)
    .join(',')
)
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

const providerIdCache = new Map();

function sanitizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}\s:.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitleForQuery(text) {
  return sanitizeText(text)
    .replace(/[:]/g, ' ')
    .replace(/\bseason\s+\d+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqNonEmpty(items) {
  return [...new Set(items.map((v) => String(v || '').trim()).filter(Boolean))];
}

function getAnimeTitles(anime) {
  return uniqNonEmpty([
    anime?.title,
    anime?.titleEnglish,
    anime?.titleRomaji,
    anime?.titleNative
  ]);
}

function getSearchQueries(anime) {
  const titles = getAnimeTitles(anime);
  const normalized = titles.map(normalizeTitleForQuery);
  const truncated = normalized
    .map((v) => v.split(' ').slice(0, Math.min(4, v.split(' ').length)).join(' '))
    .filter(Boolean);
  return uniqNonEmpty([...titles, ...normalized, ...truncated]).slice(0, 12);
}

function scoreTitle(candidateTitle, anime) {
  const candidate = sanitizeText(candidateTitle);
  if (!candidate) return 0;

  const titles = getAnimeTitles(anime).map(sanitizeText);
  if (!titles.length) return 0;

  if (titles.includes(candidate)) return 100;
  if (titles.some((title) => candidate.includes(title) || title.includes(candidate))) return 80;
  if (titles.some((title) => {
    const candidateParts = candidate.split(' ').filter((p) => p.length > 2);
    const titleParts = title.split(' ').filter((p) => p.length > 2);
    const overlap = candidateParts.filter((p) => titleParts.includes(p)).length;
    return overlap >= 2;
  })) return 60;
  if (titles.some((title) => candidate.split(' ').some((part) => part.length > 3 && title.includes(part)))) return 45;
  return 5;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function getResultArray(payload) {
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.data?.documents)) return payload.data.documents;
  if (Array.isArray(payload?.documents)) return payload.documents;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

function getEpisodeArray(payload) {
  if (Array.isArray(payload?.episodes)) return payload.episodes;
  if (Array.isArray(payload?.data?.episodes)) return payload.data.episodes;
  return [];
}

function toEpisodeList(episodes) {
  return episodes
    .map((ep) => {
      const number = Number(ep?.number ?? ep?.episodeNumber ?? ep?.episode);
      if (!Number.isFinite(number) || number < 1) return null;
      return {
        number,
        title: ep?.title || `Episode ${number}`,
        providerEpisodeId: ep?.id || ep?.episodeId || ep?.url || null
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);
}

function normalizeSourceType(type, url) {
  const raw = String(type || '').toLowerCase();
  const href = String(url || '');
  if (raw.includes('hls') || /\.m3u8($|\?)/i.test(href)) return 'm3u8';
  if (raw.includes('mp4') || /\.mp4($|\?)/i.test(href)) return 'mp4';
  return 'unknown';
}

function normalizeSources(payload) {
  const rawSources = Array.isArray(payload?.sources)
    ? payload.sources
    : Array.isArray(payload?.data?.sources)
      ? payload.data.sources
      : [];

  return rawSources
    .map((source) => {
      const url = source?.url || source?.file;
      if (!url) return null;
      const quality = String(source?.quality || source?.label || 'auto').toLowerCase();
      return {
        server: String(source?.server || payload?.server || 'default'),
        url,
        label: source?.label || quality.toUpperCase(),
        quality,
        type: normalizeSourceType(source?.type, url),
        headers: source?.headers || payload?.headers || undefined
      };
    })
    .filter(Boolean);
}

async function withProviderFallback(work, errorPrefix) {
  const failures = [];
  for (const baseUrl of BASE_URLS) {
    for (const engine of ENGINES) {
      try {
        return await work({ baseUrl, engine });
      } catch (error) {
        failures.push(`${engine}@${baseUrl}: ${error.message}`);
      }
    }
  }
  throw new Error(`${errorPrefix}. Tried ${failures.length} route(s): ${failures.join(' | ')}`);
}

async function searchAnimeProviderId(anime) {
  const cacheKey = `${anime.id || anime.title || anime.titleRomaji || ''}`.trim();
  if (cacheKey && providerIdCache.has(cacheKey)) {
    return providerIdCache.get(cacheKey);
  }

  const queries = getSearchQueries(anime);
  if (!queries.length) {
    throw new Error('Missing anime title');
  }

  const best = await withProviderFallback(async ({ baseUrl, engine }) => {
    let candidates = [];
    for (const query of queries) {
      const url = `${baseUrl}/anime/${engine}/${encodeURIComponent(query)}?page=1`;
      const payload = await fetchJson(url);
      const results = getResultArray(payload);
      candidates = candidates.concat(
        results.map((item) => ({
          id: item?.id || item?._id,
          title: item?.title || item?.name || '',
          score: scoreTitle(item?.title || item?.name || '', anime),
          baseUrl,
          engine
        }))
      );
    }

    const selected = candidates
      .filter((c) => c.id)
      .sort((a, b) => b.score - a.score)[0];

    if (!selected?.id) {
      throw new Error('No searchable anime result');
    }

    if (selected.score < 25 && candidates.length > 0) {
      return {
        ...selected,
        score: selected.score
      };
    }

    return selected;
  }, 'Unable to match anime on provider');

  const matched = { id: best.id, baseUrl: best.baseUrl, engine: best.engine };
  if (cacheKey) providerIdCache.set(cacheKey, matched);
  return matched;
}

module.exports = {
  id: 'consumet',
  name: 'Consumet Provider',
  async getEpisodeList({ anime }) {
    const matched = await searchAnimeProviderId(anime);
    const infoUrl = `${matched.baseUrl}/anime/${matched.engine}/info/${encodeURIComponent(matched.id)}`;
    const payload = await fetchJson(infoUrl);
    const episodes = toEpisodeList(getEpisodeArray(payload));
    if (!episodes.length) {
      throw new Error(`No episodes returned (${matched.engine})`);
    }
    return episodes;
  },
  async getEpisodeSources({ anime, episodeNumber }) {
    const matched = await searchAnimeProviderId(anime);
    const infoUrl = `${matched.baseUrl}/anime/${matched.engine}/info/${encodeURIComponent(matched.id)}`;
    const infoPayload = await fetchJson(infoUrl);
    const episodes = toEpisodeList(getEpisodeArray(infoPayload));
    const selected = episodes.find((ep) => ep.number === Number(episodeNumber));
    if (!selected?.providerEpisodeId) {
      throw new Error(`Episode ${episodeNumber} not found (${matched.engine})`);
    }

    const watchUrl = `${matched.baseUrl}/anime/${matched.engine}/watch/${encodeURIComponent(selected.providerEpisodeId)}`;
    const watchPayload = await fetchJson(watchUrl);
    const sources = normalizeSources(watchPayload);
    if (!sources.length) {
      throw new Error(`No stream sources returned (${matched.engine})`);
    }

    return {
      number: Number(episodeNumber),
      videoSources: sources
    };
  }
};
