const BASE_URL = (process.env.ANIMESATURN_BASE_URL || 'https://www.animesaturn.cx').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.ANIMESATURN_TIMEOUT_MS || 15000);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const providerCache = new Map();

function toAbsUrl(pathOrUrl) {
  const raw = String(pathOrUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${BASE_URL}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(text) {
  return decodeHtml(String(text || '').replace(/<[^>]*>/g, ' '));
}

function normalizeTitle(text) {
  return stripTags(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\bseason\b/g, ' ')
    .replace(/\b(stagione|cour|part|parte)\b/g, ' ')
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function animeTitles(anime) {
  return [...new Set([
    anime?.title,
    anime?.titleEnglish,
    anime?.titleRomaji,
    anime?.titleNative
  ].map((v) => String(v || '').trim()).filter(Boolean))];
}

function getSearchQueries(anime) {
  const raw = animeTitles(anime);
  const normalized = raw.map(normalizeTitle).filter(Boolean);
  const noSeason = normalized.map((v) => v.replace(/\bseason\s*\d+\b/gi, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const truncated = normalized.map((v) => v.split(' ').slice(0, 4).join(' ')).filter(Boolean);
  const withSeasonNumber = raw
    .map((v) => {
      const clean = String(v || '').replace(/[\[\]【】]/g, ' ').replace(/\s+/g, ' ').trim();
      const seasonMatch = clean.match(/^(.*?)(?:\s+season\s*(\d+))(?:\s*[:\-].*)?$/i);
      if (!seasonMatch) return '';
      const base = String(seasonMatch[1] || '').trim();
      const season = String(seasonMatch[2] || '').trim();
      if (!base || !season) return '';
      return `${base} ${season}`.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);
  const beforeColon = raw
    .map((v) => String(v || '').split(':')[0].trim())
    .filter(Boolean);
  return [...new Set([...raw, ...normalized, ...withSeasonNumber, ...beforeColon, ...noSeason, ...truncated])].slice(0, 18);
}

function getSubOrDubFromUrl(url) {
  const s = String(url || '').toLowerCase();
  if (s.includes('ita') && !s.includes('sub')) return 'dub';
  return 'sub';
}

function scoreCandidate(candidate, anime) {
  const cand = normalizeTitle(candidate);
  if (!cand) return 0;
  const titles = animeTitles(anime).map(normalizeTitle).filter(Boolean);
  if (!titles.length) return 0;
  if (titles.includes(cand)) return 100;
  if (titles.some((t) => cand.includes(t) || t.includes(cand))) return 80;
  if (titles.some((t) => {
    const a = cand.split(' ').filter((p) => p.length > 2);
    const b = t.split(' ').filter((p) => p.length > 2);
    const overlap = a.filter((p) => b.includes(p)).length;
    return overlap >= 2;
  })) return 60;
  return 0;
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
        'User-Agent': UA,
        ...extraHeaders
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseTotalPages(html) {
  const match = String(html || '').match(/totalPages\s*:\s*(\d+)/i);
  if (!match) return 1;
  const pages = Number(match[1]);
  return Number.isFinite(pages) && pages > 0 ? pages : 1;
}

function parseSearchItems(html) {
  const items = [];
  const regex = /item-archivio[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<[^>]+class="[^"]*\bbadge\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    const href = toAbsUrl(match[1] || '');
    const title = stripTags(match[2] || '');
    if (!href || !title) continue;
    items.push({
      url: href,
      id: href.replace(BASE_URL, '').replace(/^\/+/, ''),
      title,
      subOrDub: getSubOrDubFromUrl(href)
    });
  }
  return items;
}

function parseEpisodes(html) {
  const episodes = [];
  const linkRegex = /<a\b[^>]*class="[^"]*\bbottone-ep\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(String(html || ''))) !== null) {
    const anchor = match[0] || '';
    const href = toAbsUrl(anchor.match(/href="([^"]+)"/i)?.[1] || '');
    const title = stripTags(anchor.replace(/^[^>]*>/, '').replace(/<\/a>$/i, ''));
    const epMatch = href.match(/-ep-(\d+)/i);
    const number = Number(epMatch?.[1]);
    if (!href || !Number.isFinite(number) || number < 1) continue;
    episodes.push({
      number,
      title: title || `Episode ${number}`,
      providerEpisodeId: href
    });
  }
  return episodes.sort((a, b) => a.number - b.number);
}

function getMasterVariants(masterText, masterUrl) {
  const lines = String(masterText || '')
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);

  const variants = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const next = lines[i + 1] || '';
    if (!next || next.startsWith('#')) continue;

    const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    const quality = resMatch ? `${resMatch[2]}p` : 'auto';
    const url = toAbsUrl(new URL(next, masterUrl).toString());
    variants.push({ quality, url });
  }
  return variants;
}

async function resolveAnimePageUrl(anime, dubbed) {
  const key = `${anime?.id || ''}:${dubbed ? 'dub' : 'sub'}`;
  if (providerCache.has(key)) return providerCache.get(key);

  const queries = getSearchQueries(anime);
  if (!queries.length) throw new Error('Missing anime title');

  let best = null;
  let firstFiltered = null;
  for (const query of queries) {
    const searchUrl = `${BASE_URL}/animelist?search=${encodeURIComponent(query)}`;
    const firstPage = await fetchText(searchUrl).catch(() => '');
    if (!firstPage) continue;

    const totalPages = Math.min(4, parseTotalPages(firstPage));
    const results = [];
    for (let page = 1; page <= totalPages; page += 1) {
      const html = page === 1 ? firstPage : await fetchText(`${BASE_URL}/animelist?page=${page}&search=${encodeURIComponent(query)}`).catch(() => '');
      results.push(...parseSearchItems(html));
    }

    const filtered = results.filter((item) => (dubbed ? item.subOrDub === 'dub' : item.subOrDub === 'sub'));
    if (!firstFiltered && filtered.length) {
      firstFiltered = filtered[0];
    }
    for (const item of filtered) {
      const score = scoreCandidate(item.title, anime);
      if (!best || score > best.score) {
        best = { ...item, score };
      }
    }

    if (best?.score >= 95) break;
  }

  if (best?.url && best.score >= 20) {
    providerCache.set(key, best.url);
    return best.url;
  }
  if (firstFiltered?.url) {
    providerCache.set(key, firstFiltered.url);
    return firstFiltered.url;
  }
  if (!best?.url) {
    throw new Error('AnimeSaturn search match not found');
  }
  providerCache.set(key, best.url);
  return best.url;
}

async function extractEpisodeSources(episodeUrl) {
  const epHtml = await fetchText(episodeUrl);
  const watchHref = epHtml.match(/<a[^>]+href="([^"]*watch[^"]*)"[^>]*>/i)?.[1] || '';
  const watchUrl = toAbsUrl(watchHref);
  if (!watchUrl) throw new Error('AnimeSaturn watch URL not found');

  const watchAltUrl = watchUrl.includes('?') ? `${watchUrl}&s=alt` : `${watchUrl}?s=alt`;
  const watchHtml = await fetchText(watchAltUrl);

  const m3u8 = watchHtml.match(/<source[^>]+src="(https:\/\/[^"]+\.m3u8[^"]*)"/i)?.[1] || '';
  const mp4 = watchHtml.match(/file:\s*"(https:\/\/[^"]+\.mp4[^"]*)"/i)?.[1] || '';

  if (!m3u8 && !mp4) {
    throw new Error('No playable source found on AnimeSaturn');
  }

  const baseHeaders = {
    Referer: `${BASE_URL}/`,
    Origin: BASE_URL,
    'User-Agent': UA
  };

  if (m3u8) {
    const master = await fetchText(m3u8, { Referer: watchAltUrl }).catch(() => '');
    const variants = getMasterVariants(master, m3u8);
    if (variants.length) {
      return variants.map((variant) => ({
        server: 'animesaturn',
        url: variant.url,
        label: `AnimeSaturn ${variant.quality}`,
        quality: variant.quality,
        type: 'm3u8',
        headers: baseHeaders
      }));
    }

    return [
      {
        server: 'animesaturn',
        url: m3u8,
        label: 'AnimeSaturn Auto',
        quality: 'auto',
        type: 'm3u8',
        headers: baseHeaders
      }
    ];
  }

  return [
    {
      server: 'animesaturn',
      url: mp4,
      label: 'AnimeSaturn 720p',
      quality: '720p',
      type: 'mp4',
      headers: baseHeaders
    }
  ];
}

module.exports = {
  id: 'animesaturn',
  name: 'AnimeSaturn',
  async getEpisodeList({ anime, dubbed = false }) {
    const animePageUrl = await resolveAnimePageUrl(anime, dubbed);
    const html = await fetchText(animePageUrl);
    const episodes = parseEpisodes(html);
    if (!episodes.length) {
      throw new Error('AnimeSaturn returned no episodes');
    }
    return episodes;
  },
  async getEpisodeSources({ anime, episodeNumber, dubbed = false }) {
    const targetEp = Number(episodeNumber);
    if (!Number.isFinite(targetEp) || targetEp < 1) {
      throw new Error('Invalid episode number');
    }

    const episodes = await this.getEpisodeList({ anime, dubbed });
    const selected = episodes.find((ep) => ep.number === targetEp);
    if (!selected?.providerEpisodeId) {
      throw new Error(`Episode ${targetEp} not found on AnimeSaturn`);
    }

    const videoSources = await extractEpisodeSources(selected.providerEpisodeId);
    return {
      number: targetEp,
      videoSources
    };
  }
};
