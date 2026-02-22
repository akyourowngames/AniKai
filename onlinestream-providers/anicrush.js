const BASE_URL = 'https://anicrush.to';
const API_BASE = 'https://api.anicrush.to/shared/v2';
const REQUEST_TIMEOUT_MS = Number(process.env.ANICRUSH_TIMEOUT_MS || 30000);

const SERVER_MAP = {
  'Southcloud-1': 4,
  'Southcloud-2': 1,
  'Southcloud-3': 6
};

const DEFAULT_SERVER_ORDER = ['Southcloud-1', 'Southcloud-2', 'Southcloud-3'];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/(season|cour|part|uncensored)/g, '')
    .replace(/\d+(st|nd|rd|th)\b/g, (m) => m.replace(/(st|nd|rd|th)\b/g, ''))
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function levenshteinSimilarity(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left && !right) return 1;
  if (!left || !right) return 0;

  const lenA = left.length;
  const lenB = right.length;
  const dp = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));

  for (let i = 0; i <= lenA; i += 1) dp[i][0] = i;
  for (let j = 0; j <= lenB; j += 1) dp[0][j] = j;

  for (let i = 1; i <= lenA; i += 1) {
    for (let j = 1; j <= lenB; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  const distance = dp[lenA][lenB];
  const maxLen = Math.max(lenA, lenB);
  return 1 - distance / maxLen;
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
        'X-Site': 'anicrush',
        ...(init.headers || {})
      }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function searchAnime(query) {
  const url = `${API_BASE}/movie/list?keyword=${encodeURIComponent(query)}&limit=48&page=1`;
  const payload = await fetchJson(url);
  const list = Array.isArray(payload?.result?.movies) ? payload.result.movies : [];

  return list.map((movie) => {
    const title = movie?.name_english || movie?.name || '';
    const titleJP = movie?.name || title;
    return {
      id: String(movie?.id || ''),
      slug: String(movie?.slug || ''),
      title,
      titleJP,
      normTitle: normalize(title),
      normTitleJP: normalize(titleJP),
      dubbed: Boolean(movie?.has_dub)
    };
  }).filter((item) => item.id && item.slug && item.title);
}

function scoreCandidate(candidate, anime) {
  const titles = [
    anime?.title,
    anime?.titleEnglish,
    anime?.titleRomaji,
    anime?.titleNative
  ]
    .map((v) => normalize(v))
    .filter(Boolean);

  if (!titles.length) return 0;
  if (titles.includes(candidate.normTitle) || titles.includes(candidate.normTitleJP)) return 100;

  let maxSimilarity = 0;
  for (const t of titles) {
    maxSimilarity = Math.max(
      maxSimilarity,
      levenshteinSimilarity(candidate.normTitle, t),
      levenshteinSimilarity(candidate.normTitleJP, t)
    );
  }

  if (maxSimilarity >= 0.92) return 90;
  if (maxSimilarity >= 0.84) return 75;
  if (maxSimilarity >= 0.76) return 60;
  if (maxSimilarity >= 0.68) return 40;
  return 0;
}

async function resolveAnime(anime, dubbed) {
  const queries = [
    anime?.titleEnglish,
    anime?.titleRomaji,
    anime?.title,
    anime?.titleNative
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  if (!queries.length) {
    throw new Error('Missing anime title');
  }

  let all = [];
  for (const query of queries) {
    const chunk = await searchAnime(query).catch(() => []);
    all = all.concat(chunk);
    if (all.length >= 12) break;
  }

  if (!all.length) {
    throw new Error('AniCrush returned no search results');
  }

  if (dubbed) {
    const dubOnly = all.filter((item) => item.dubbed);
    if (dubOnly.length) all = dubOnly;
  }

  const unique = Array.from(new Map(all.map((item) => [item.id, item])).values());
  const ranked = unique
    .map((item) => ({ ...item, score: scoreCandidate(item, anime) }))
    .sort((a, b) => b.score - a.score);

  const selected = ranked[0];
  if (!selected?.id) {
    throw new Error('AniCrush match failed');
  }

  if (selected.score < 35 && ranked.length > 1) {
    return ranked[0];
  }
  return selected;
}

async function getEpisodes(movieId, dubbed) {
  const payload = await fetchJson(`${API_BASE}/episode/list?_movieId=${encodeURIComponent(movieId)}`);
  const groups = payload?.result || {};
  const episodes = [];

  for (const list of Object.values(groups)) {
    if (!Array.isArray(list)) continue;
    for (const ep of list) {
      const number = Number(ep?.number);
      if (!Number.isFinite(number) || number < 1) continue;
      episodes.push({
        number,
        title: String(ep?.name_english || ep?.name || `Episode ${number}`),
        providerEpisodeId: `${movieId}/${dubbed ? 'dub' : 'sub'}`
      });
    }
  }

  const byNumber = new Map();
  for (const ep of episodes) {
    byNumber.set(ep.number, ep);
  }
  return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
}

async function extractMegaCloud(embedUrl) {
  const url = new URL(embedUrl);
  const baseDomain = `${url.protocol}//${url.host}/`;

  const headers = {
    Accept: '*/*',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: baseDomain,
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
  };

  const html = await fetch(embedUrl, { headers }).then((r) => r.text());

  const fileIdMatch = html.match(/<title>\s*File\s+#([a-zA-Z0-9]+)\s*-/i);
  if (!fileIdMatch) throw new Error('file_id not found in embed page');
  const fileId = fileIdMatch[1];

  let nonce = null;
  const match48 = html.match(/\b[a-zA-Z0-9]{48}\b/);
  if (match48) {
    nonce = match48[0];
  } else {
    const match3x16 = [...html.matchAll(/["']([A-Za-z0-9]{16})["']/g)];
    if (match3x16.length >= 3) {
      nonce = match3x16[0][1] + match3x16[1][1] + match3x16[2][1];
    }
  }
  if (!nonce) throw new Error('nonce not found');

  const sourcesJson = await fetch(
    `${baseDomain}embed-2/v3/e-1/getSources?id=${fileId}&_k=${nonce}`,
    { headers }
  ).then((r) => r.json());

  return {
    sources: sourcesJson?.sources || [],
    tracks: sourcesJson?.tracks || []
  };
}

async function resolveVideoSources(movieId, episodeNumber, dubbed, preferredServer) {
  const candidates = preferredServer
    ? [preferredServer, ...DEFAULT_SERVER_ORDER.filter((s) => s !== preferredServer)]
    : DEFAULT_SERVER_ORDER;

  const failures = [];
  const allSources = [];
  for (const server of candidates) {
    const sv = SERVER_MAP[server] || SERVER_MAP['Southcloud-1'];
    const sourceUrl =
      `${API_BASE}/episode/sources?_movieId=${encodeURIComponent(movieId)}` +
      `&ep=${encodeURIComponent(String(episodeNumber))}` +
      `&sv=${sv}&sc=${dubbed ? 'dub' : 'sub'}`;

    try {
      const payload = await fetchJson(sourceUrl);
      const encryptedIframe = payload?.result?.link;
      if (!encryptedIframe) throw new Error('Missing encrypted iframe link');

      const outputSources = [];

      let decryptData = null;
      try {
        decryptData = await extractMegaCloud(encryptedIframe);
      } catch (_) {}

      if (!decryptData) {
        const fallback = await fetch(
          `https://ac-api.ofchaos.com/api/anime/embed/convert/v2?embedUrl=${encodeURIComponent(encryptedIframe)}`
        ).then((r) => r.json());
        decryptData = fallback;
      }

      const subtitles = (Array.isArray(decryptData?.tracks) ? decryptData.tracks : [])
        .filter((t) => t?.kind === 'captions' && t?.file)
        .map((track, index) => ({
          id: `sub-${index}`,
          language: String(track?.label || 'Unknown'),
          url: track.file,
          isDefault: Boolean(track?.default)
        }));

      const rawSources = Array.isArray(decryptData?.sources) ? decryptData.sources : [];
      const dedupSourceUrls = new Set();
      const preferredRawSources = [
        ...rawSources.filter((s) => String(s?.type || '').toLowerCase() === 'hls'),
        ...rawSources.filter((s) => String(s?.type || '').toLowerCase() === 'mp4'),
        ...rawSources.filter((s) => {
          const t = String(s?.type || '').toLowerCase();
          return t !== 'hls' && t !== 'mp4';
        })
      ];

      preferredRawSources.forEach((src, idx) => {
        const file = String(src?.file || '').trim();
        if (!file || dedupSourceUrls.has(file)) return;
        dedupSourceUrls.add(file);
        const type = String(src?.type || '').toLowerCase();
        const normalizedType = type === 'hls' ? 'm3u8' : (type || 'unknown');
        const quality = String(src?.label || src?.quality || '').trim() || 'auto';
        outputSources.push({
          server,
          url: file,
          label: `AniCrush ${server}`,
          quality,
          type: normalizedType,
          sourceIndex: idx,
          subtitles,
          headers: {
            Referer: 'https://megacloud.club/',
            Origin: 'https://megacloud.club',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
          }
        });
      });

      outputSources.push({
        server,
        url: encryptedIframe,
        label: `AniCrush ${server} Embed`,
        quality: 'auto',
        type: 'embed'
      });

      allSources.push(...outputSources);
    } catch (error) {
      failures.push(`${server}: ${error.message}`);
    }
  }

  if (allSources.length) {
    return allSources;
  }

  throw new Error(`AniCrush returned no playable source (${failures.join(' | ')})`);
}

module.exports = {
  id: 'anicrush',
  name: 'AniCrush',
  async getEpisodeList({ anime, dubbed = false }) {
    const matched = await resolveAnime(anime, dubbed);
    const episodes = await getEpisodes(matched.id, dubbed);
    if (!episodes.length) {
      throw new Error('AniCrush returned no episodes');
    }
    return episodes;
  },
  async getEpisodeSources({ anime, episodeNumber, dubbed = false, server }) {
    const ep = Number(episodeNumber);
    if (!Number.isFinite(ep) || ep < 1) {
      throw new Error('Invalid episode number');
    }

    const matched = await resolveAnime(anime, dubbed);
    const videoSources = await resolveVideoSources(matched.id, ep, dubbed, server);
    return {
      number: ep,
      videoSources,
      debug: {
        matchedAnime: {
          id: matched.id,
          title: matched.title,
          slug: matched.slug
        }
      }
    };
  }
};
