const { LRUCache } = require('lru-cache');

const ANILIST_API_URL = 'https://graphql.anilist.co';
const JIKAN_API_URL = 'https://api.jikan.moe/v4';
const ANILIST_MAX_RETRIES = 6;

// Cache for getAnimeDetails — keyed by `${source}:${animeId}`
// Max 500 entries, 5-minute TTL. Prevents repeated upstream calls when
// episode-list and episode-source both fetch the same anime in quick succession.
const animeDetailsCache = new LRUCache({
  max: 500,
  ttl: 5 * 60 * 1000 // 5 minutes
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function anilistRequest(query, variables = {}, token = '') {
  const authToken = String(token || '').trim();
  for (let attempt = 0; attempt <= ANILIST_MAX_RETRIES; attempt += 1) {
    const response = await fetch(ANILIST_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
      },
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      if (response.status === 429 && attempt < ANILIST_MAX_RETRIES) {
        const retryAfterHeader = Number(response.headers.get('retry-after') || 0);
        const retryDelayMs = retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : Math.min(1000 * 2 ** attempt, 10000);
        await wait(retryDelayMs);
        continue;
      }
      throw new Error(`AniList request failed with ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(payload.errors[0].message || 'AniList query error');
    }

    return payload.data;
  }

  throw new Error('AniList request failed after retries');
}

async function jikanRequest(pathname, searchParams = {}) {
  const url = new URL(`${JIKAN_API_URL}${pathname}`);
  Object.entries(searchParams).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Jikan request failed with ${response.status}`);
  }

  return response.json();
}

function toCatalogItem(media) {
  return {
    id: String(media.id),
    idMal: media.idMal || null,
    title: media.title?.english || media.title?.romaji || media.title?.native || 'Unknown title',
    titleEnglish: media.title?.english || null,
    titleRomaji: media.title?.romaji || null,
    titleNative: media.title?.native || null,
    genres: media.genres || [],
    year: media.startDate?.year || 'N/A',
    description: (media.description || 'No description available.').replace(/<[^>]*>/g, ''),
    poster: media.coverImage?.extraLarge || media.coverImage?.large || '',
    episodeCount: media.episodes || 0,
    score: media.averageScore || null,
    season: media.season || null,
    status: media.status || null,
    trailer: media.trailer || null
  };
}

function toMalCatalogItem(anime) {
  return {
    id: String(anime.mal_id),
    idMal: anime.mal_id || null,
    title: anime.title_english || anime.title || 'Unknown title',
    titleEnglish: anime.title_english || null,
    titleRomaji: anime.title || null,
    titleNative: anime.title_japanese || null,
    genres: (anime.genres || []).map((genre) => genre.name),
    year: anime.year || anime.aired?.prop?.from?.year || 'N/A',
    description: anime.synopsis || 'No description available.',
    poster: anime.images?.webp?.large_image_url || anime.images?.jpg?.large_image_url || '',
    episodeCount: anime.episodes || 0,
    score: anime.score || null,
    season: anime.season ? anime.season.toUpperCase() : null,
    status: anime.status || null,
    trailer: anime.trailer?.youtube_id ? { id: anime.trailer.youtube_id, site: 'youtube' } : null
  };
}

async function listAnime({ page = 1, perPage = 18, search = '', source = 'anilist', anilistToken = '' }) {
  if (source === 'mal') {
    const params = {
      page,
      limit: perPage,
      sfw: true,
      order_by: 'score',
      sort: 'desc',
      q: search || null
    };
    const endpoint = search ? '/anime' : '/top/anime';
    const data = await jikanRequest(endpoint, params);
    const list = Array.isArray(data?.data) ? data.data : [];
    return list.map(toMalCatalogItem);
  }

  const query = `
    query ($page: Int, $perPage: Int, $search: String) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: TRENDING_DESC, isAdult: false, search: $search) {
          id
          idMal
          title { romaji english native }
          description(asHtml: false)
          genres
          episodes
          status
          season
          averageScore
          startDate { year }
          coverImage { large extraLarge }
          trailer { id site }
        }
      }
    }
  `;

  const data = await anilistRequest(query, { page, perPage, search: search || null }, anilistToken);
  const media = data?.Page?.media || [];
  return media.map(toCatalogItem);
}

async function getAnimeDetails(animeId, source = 'anilist', anilistToken = '') {
  // Use a token-agnostic cache key — token only affects rate limits, not the data shape
  const cacheKey = `${source}:${animeId}`;
  const cached = animeDetailsCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let result = null;

  if (source === 'mal') {
    const data = await jikanRequest(`/anime/${animeId}/full`);
    if (data?.data) {
      result = {
        ...toMalCatalogItem(data.data),
        bannerImage: data.data.images?.jpg?.large_image_url || null
      };
    }
  } else {
    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          idMal
          title { romaji english native }
          description(asHtml: false)
          genres
          episodes
          status
          season
          averageScore
          startDate { year }
          coverImage { large extraLarge }
          bannerImage
          trailer { id site }
        }
      }
    `;

    const data = await anilistRequest(query, { id: animeId }, anilistToken);
    if (data?.Media) {
      result = {
        ...toCatalogItem(data.Media),
        bannerImage: data.Media.bannerImage || null
      };
    }
  }

  // Only cache successful (non-null) results — don't cache 404s
  if (result !== null) {
    animeDetailsCache.set(cacheKey, result);
  }

  return result;
}

module.exports = {
  listAnime,
  getAnimeDetails
};
