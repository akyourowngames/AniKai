const BASE_URL = (process.env.HIANIME_BASE_URL || 'https://hianime.to').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.HIANIME_TIMEOUT_MS || 15000);

const SERVER_MAP = {
  'HD-1': 'hd-1',
  'HD-2': 'hd-2',
  'HD-3': 'hd-3'
};

const DEFAULT_SERVER_ORDER = ['HD-1', 'HD-2', 'HD-3'];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/(season|cour|part|the animation|the movie|movie|uncensored)/g, '')
    .replace(/\d+(st|nd|rd|th)\b/g, (m) => m.replace(/(st|nd|rd|th)\b/g, ''))
    .replace(/[^a-z0-9]+/g, '')
    .replace(/(?<!i)ii(?!i)/g, '2')
    .trim();
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/\\u0026/g, '&')
    .replace(/&#(\d+);?/g, (_m, dec) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
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
      if (left[i - 1] === right[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  const distance = dp[lenA][lenB];
  const maxLen = Math.max(lenA, lenB);
  return 1 - distance / maxLen;
}

async function fetchJson(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        ...extraHeaders
      },
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        ...extraHeaders
      },
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function getTitleCandidates(anime) {
  return [...new Set([
    anime?.title,
    anime?.titleEnglish,
    anime?.titleRomaji,
    anime?.titleNative
  ].map((v) => String(v || '').trim()).filter(Boolean))];
}

function parseSuggestMatches(html) {
  const out = [];
  const regex = /<a href="\/([^"]+)" class="nav-item">[\s\S]*?<h3 class="film-name"[^>]*data-jname="([^"]*)"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<div class="film-infor">([\s\S]*?)<\/div>/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    const pageUrl = String(match[1] || '').trim();
    if (!pageUrl || pageUrl.startsWith('search?')) continue;
    const idMatch = pageUrl.match(/-(\d+)$/);
    const id = idMatch ? idMatch[1] : pageUrl;
    const title = stripTags(match[3] || '');
    const jname = decodeHtmlEntities(match[2] || '');
    const info = stripTags(match[4] || '');
    const formatToken = (info.split('|').map((s) => s.trim()).find(Boolean) || '').toUpperCase();

    out.push({
      id,
      pageUrl,
      title: decodeHtmlEntities(title),
      titleJP: decodeHtmlEntities(jname),
      normTitle: normalize(title),
      normTitleJP: normalize(jname),
      format: formatToken
    });
  }
  return out;
}

function scoreMatch(candidate, anime) {
  const titles = getTitleCandidates(anime).map(normalize).filter(Boolean);
  if (!titles.length) return 0;
  if (titles.includes(candidate.normTitle) || titles.includes(candidate.normTitleJP)) return 100;

  let max = 0;
  for (const t of titles) {
    max = Math.max(max, levenshteinSimilarity(candidate.normTitle, t), levenshteinSimilarity(candidate.normTitleJP, t));
  }
  if (max >= 0.9) return 90;
  if (max >= 0.82) return 75;
  if (max >= 0.72) return 55;
  if (max >= 0.62) return 35;
  return 0;
}

async function resolveAnime(anime) {
  const queries = getTitleCandidates(anime);
  if (!queries.length) throw new Error('Missing anime title');

  const all = [];
  for (const q of queries.slice(0, 6)) {
    const url = `${BASE_URL}/ajax/search/suggest?keyword=${encodeURIComponent(q)}`;
    const payload = await fetchJson(url).catch(() => null);
    const html = String(payload?.html || '');
    if (!html) continue;
    all.push(...parseSuggestMatches(html));
    if (all.length > 20) break;
  }

  const unique = Array.from(new Map(all.map((item) => [item.id, item])).values());
  if (!unique.length) throw new Error('HiAnime returned no search results');

  const ranked = unique
    .map((item) => ({ ...item, score: scoreMatch(item, anime) }))
    .sort((a, b) => b.score - a.score);

  const selected = ranked[0];
  if (!selected?.id) throw new Error('HiAnime match failed');
  return selected;
}

function parseEpisodes(html, subOrDub) {
  const episodes = [];
  const regex = /<a[^>]*class="[^"]*\bep-item\b[^"]*"[^>]*data-number="([^"]+)"[^>]*data-id="([^"]+)"[^>]*href="([^"]+)"[\s\S]*?<div class="ep-name[^"]*"[^>]*title="([^"]*)"/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number < 1) continue;
    episodes.push({
      number,
      title: decodeHtmlEntities(match[4] || `Episode ${number}`) || `Episode ${number}`,
      providerEpisodeId: `${String(match[2] || '').trim()}/${subOrDub}`
    });
  }

  const dedup = new Map();
  for (const ep of episodes) dedup.set(ep.number, ep);
  return Array.from(dedup.values()).sort((a, b) => a.number - b.number);
}

async function getEpisodes(animeId, dubbed) {
  const subOrDub = dubbed ? 'dub' : 'sub';
  const payload = await fetchJson(`${BASE_URL}/ajax/v2/episode/list/${encodeURIComponent(animeId)}`);
  const html = String(payload?.html || '');
  return parseEpisodes(html, subOrDub);
}

function parseServerList(html, subOrDub) {
  const map = new Map();
  const regex = /<div[^>]*class="item server-item"[^>]*data-type="([^"]+)"[^>]*data-id="([^"]+)"[^>]*>\s*<a[^>]*>\s*([^<]+)\s*<\/a>/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    const type = String(match[1] || '').toLowerCase().trim();
    const id = String(match[2] || '').trim();
    const name = String(match[3] || '').trim();
    const wanted = subOrDub === 'sub' ? (type === 'sub' || type === 'raw') : type === 'dub';
    if (!wanted || !id || !name) continue;
    map.set(name.toLowerCase(), { id, name });
  }
  return map;
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

  const sourcesJson = await fetch(`${baseDomain}embed-2/v3/e-1/getSources?id=${fileId}&_k=${nonce}`, { headers }).then((r) => r.json());
  return {
    sources: Array.isArray(sourcesJson?.sources) ? sourcesJson.sources : [],
    tracks: Array.isArray(sourcesJson?.tracks) ? sourcesJson.tracks : []
  };
}

async function resolveVideoSources(episodeProviderId, preferredServer) {
  const [episodeId, subOrDub] = String(episodeProviderId || '').split('/');
  if (!episodeId || !subOrDub) throw new Error('Invalid episode provider id');

  const serversPayload = await fetchJson(`${BASE_URL}/ajax/v2/episode/servers?episodeId=${encodeURIComponent(episodeId)}`);
  const serverMap = parseServerList(serversPayload?.html || '', subOrDub);
  if (!serverMap.size) throw new Error('HiAnime servers not found');

  const mappedPreferred = SERVER_MAP[preferredServer] || String(preferredServer || '').toLowerCase();
  const candidateNames = [];
  if (mappedPreferred) candidateNames.push(mappedPreferred);
  for (const name of DEFAULT_SERVER_ORDER.map((s) => SERVER_MAP[s])) {
    if (name && !candidateNames.includes(name)) candidateNames.push(name);
  }
  for (const name of serverMap.keys()) {
    if (!candidateNames.includes(name)) candidateNames.push(name);
  }

  const failures = [];
  const sources = [];
  for (const candidate of candidateNames) {
    const server = serverMap.get(candidate.toLowerCase());
    if (!server?.id) continue;

    try {
      const sourcePayload = await fetchJson(`${BASE_URL}/ajax/v2/episode/sources?id=${encodeURIComponent(server.id)}`);
      const embedLink = String(sourcePayload?.link || '').trim();
      if (!embedLink) throw new Error('missing embed link');

      let decryptData = null;
      try {
        decryptData = await extractMegaCloud(embedLink);
      } catch (_) {}

      if (!decryptData) {
        decryptData = await fetch(
          `https://ac-api.ofchaos.com/api/anime/embed/convert/v2?embedUrl=${encodeURIComponent(embedLink)}`
        ).then((r) => r.json());
      }

      const subtitles = (Array.isArray(decryptData?.tracks) ? decryptData.tracks : [])
        .filter((t) => t?.kind === 'captions' && t?.file)
        .map((track, index) => ({
          id: `sub-${index}`,
          language: String(track?.label || 'Unknown'),
          url: String(track.file),
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
        const rawType = String(src?.type || '').toLowerCase();
        const type = rawType === 'hls' ? 'm3u8' : (rawType || 'unknown');
        const quality = String(src?.label || src?.quality || '').trim() || 'auto';
        sources.push({
          server: server.name,
          url: file,
          label: `HiAnime ${server.name}`,
          quality,
          type,
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

      sources.push({
        server: server.name,
        url: embedLink,
        label: `HiAnime ${server.name} Embed`,
        quality: 'auto',
        type: 'embed'
      });
    } catch (error) {
      failures.push(`${server.name}: ${error.message}`);
    }
  }

  if (sources.length) return sources;
  throw new Error(`HiAnime returned no playable source (${failures.join(' | ')})`);
}

module.exports = {
  id: 'hianime',
  name: 'HiAnime',
  async getEpisodeList({ anime, dubbed = false }) {
    const matched = await resolveAnime(anime);
    const episodes = await getEpisodes(matched.id, dubbed);
    if (!episodes.length) throw new Error('HiAnime returned no episodes');
    return episodes;
  },
  async getEpisodeSources({ anime, episodeNumber, dubbed = false, server }) {
    const ep = Number(episodeNumber);
    if (!Number.isFinite(ep) || ep < 1) {
      throw new Error('Invalid episode number');
    }

    const matched = await resolveAnime(anime);
    const episodes = await getEpisodes(matched.id, dubbed);
    const selected = episodes.find((item) => item.number === ep);
    if (!selected?.providerEpisodeId) {
      throw new Error(`Episode ${ep} not found on HiAnime`);
    }

    const videoSources = await resolveVideoSources(selected.providerEpisodeId, server);
    return {
      number: ep,
      videoSources,
      debug: {
        matchedAnime: {
          id: matched.id,
          title: matched.title,
          pageUrl: matched.pageUrl
        }
      }
    };
  }
};
