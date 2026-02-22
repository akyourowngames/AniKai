const BASE_URL = (process.env.ANIZONE_BASE_URL || 'https://anizone.to').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.ANIZONE_TIMEOUT_MS || 15000);
const anicrushFallback = require('./anicrush');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\bseason\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left && !right) return 0;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (left[i - 1] === right[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[left.length][right.length];
}

function similarity(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const dist = levenshtein(left, right);
  return 1 - dist / Math.max(left.length, right.length);
}

async function fetchText(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: '*/*',
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        ...extraHeaders
      },
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseSearch(html) {
  const items = [];
  const regex = /<a[^>]*href="(?:https?:\/\/anizone\.to)?\/anime\/([^"/?#]+)"[^>]*title="([^"]+)"[^>]*>/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    const animeId = String(match[1] || '').trim();
    const title = String(match[2] || '').trim();
    if (!animeId || !title) continue;
    items.push({ animeId, title });
  }
  return Array.from(new Map(items.map((i) => [i.animeId, i])).values());
}

function pickBestAnimeId(candidates, anime) {
  const titles = [anime?.title, anime?.titleEnglish, anime?.titleRomaji, anime?.titleNative]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  if (!candidates.length) return null;
  if (!titles.length) return candidates[0].animeId;

  const ranked = candidates
    .map((item) => ({
      ...item,
      score: Math.max(...titles.map((t) => similarity(item.title, t)))
    }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.animeId || candidates[0].animeId;
}

function parseEpisodeLinks(html, animeId) {
  const episodes = [];
  const regex = new RegExp(`/anime/${animeId}/(\\d+)`, 'gi');
  const seen = new Set();
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number < 1 || seen.has(number)) continue;
    seen.add(number);
    episodes.push({
      number,
      title: `Episode ${number}`,
      providerEpisodeId: `${animeId}/${number}`
    });
  }
  return episodes.sort((a, b) => a.number - b.number);
}

function parseSubtitles(html) {
  const subtitles = [];
  const regex = /<track[^>]*src=["']([^"']+)["'][^>]*label=["']([^"']+)["'][^>]*srclang=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(String(html || ''))) !== null) {
    const src = String(match[1] || '').trim();
    const label = String(match[2] || '').trim();
    const lang = String(match[3] || '').trim();
    if (!src) continue;
    subtitles.push({
      id: lang || `sub-${subtitles.length}`,
      url: src.startsWith('http') ? src : `${BASE_URL}${src.startsWith('/') ? '' : '/'}${src}`,
      language: label || lang || 'Unknown',
      isDefault: /default/i.test(match[0]) || subtitles.length === 0
    });
  }
  return subtitles;
}

module.exports = {
  id: 'anizone',
  name: 'AniZone',
  async getEpisodeList({ anime, mediaId }) {
    try {
      const queries = [anime?.titleEnglish, anime?.titleRomaji, anime?.title, anime?.titleNative]
        .map((v) => String(v || '').trim())
        .filter(Boolean);
      if (!queries.length) throw new Error('Missing anime title');

      let candidates = [];
      for (const query of queries.slice(0, 6)) {
        const html = await fetchText(`${BASE_URL}/anime?search=${encodeURIComponent(query)}`).catch(() => '');
        candidates = candidates.concat(parseSearch(html));
        if (candidates.length > 10) break;
      }
      candidates = Array.from(new Map(candidates.map((i) => [i.animeId, i])).values());
      if (!candidates.length) {
        const fallbackId = String(mediaId || anime?.id || '').trim();
        if (!fallbackId) throw new Error('AniZone search returned no results');
        candidates = [{ animeId: fallbackId, title: fallbackId }];
      }

      const animeId = pickBestAnimeId(candidates, anime);
      if (!animeId) throw new Error('AniZone match failed');

      const animePageHtml = await fetchText(`${BASE_URL}/anime/${encodeURIComponent(animeId)}`);
      const episodes = parseEpisodeLinks(animePageHtml, animeId);
      if (!episodes.length) throw new Error('AniZone returned no episodes');
      return episodes;
    } catch (error) {
      const msg = String(error?.message || '');
      if (msg.includes('HTTP 403')) {
        return anicrushFallback.getEpisodeList({ anime, mediaId, dubbed: false });
      }
      throw error;
    }
  },
  async getEpisodeSources({ anime, mediaId, episodeNumber }) {
    try {
      const episodes = await this.getEpisodeList({ anime, mediaId });
      const ep = Number(episodeNumber);
      const selected = episodes.find((item) => item.number === ep);
      if (!selected?.providerEpisodeId) {
        throw new Error(`Episode ${ep} not found on AniZone`);
      }

      const [animeId, epNumber] = selected.providerEpisodeId.split('/');
      const pageUrl = `${BASE_URL}/anime/${encodeURIComponent(animeId)}/${encodeURIComponent(epNumber)}`;
      const html = await fetchText(pageUrl);
      const srcMatch = html.match(/<media-player[^>]+src="([^"]+\.m3u8[^"]*)"/i);
      if (!srcMatch?.[1]) throw new Error('AniZone m3u8 source not found');

      const masterUrl = srcMatch[1];
      const manifest = await fetchText(masterUrl, { Referer: pageUrl }).catch(() => '');
      const qRegex = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)/gi;
      const qualityTags = [];
      let m;
      while ((m = qRegex.exec(manifest)) !== null) {
        qualityTags.push(`${m[1]}p`);
      }
      const qualities = qualityTags.length ? Array.from(new Set(qualityTags)) : ['auto'];
      const subtitles = parseSubtitles(html);

      return {
        number: ep,
        videoSources: qualities.map((quality) => ({
          server: 'HLS',
          url: masterUrl,
          label: `AniZone ${quality}`,
          quality,
          type: 'm3u8',
          subtitles
        }))
      };
    } catch (error) {
      const msg = String(error?.message || '');
      if (msg.includes('HTTP 403')) {
        return anicrushFallback.getEpisodeSources({ anime, mediaId, episodeNumber, dubbed: false });
      }
      throw error;
    }
  }
};
