const API_BASE = (process.env.UNIQUESTREAM_API_BASE_URL || 'https://anime.uniquestream.net/api/v1').replace(/\/+$/, '');
const WEB_BASE = 'https://anime.uniquestream.net';
const REQUEST_TIMEOUT_MS = Number(process.env.UNIQUESTREAM_TIMEOUT_MS || 15000);

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\bseason\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.85;
  const lset = new Set(left.split(' ').filter(Boolean));
  const rset = new Set(right.split(' ').filter(Boolean));
  const overlap = [...lset].filter((w) => rset.has(w)).length;
  return overlap / Math.max(lset.size, rset.size, 1);
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/javascript, */*;q=0.01',
        Referer: `${WEB_BASE}/`,
        Origin: WEB_BASE,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
        ...(init.headers || {})
      }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function getTitleQueries(anime) {
  const raw = [anime?.titleEnglish, anime?.titleRomaji, anime?.title, anime?.titleNative]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  const simplified = raw
    .map((v) => v
      .replace(/season\s*\d+/ig, ' ')
      .replace(/\bpart\s*\d+\b/ig, ' ')
      .replace(/\bcour\s*\d+\b/ig, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);

  const truncated = simplified
    .map((v) => v.split(' ').slice(0, 3).join(' ').trim())
    .filter(Boolean);

  return [...new Set([...raw, ...simplified, ...truncated])].slice(0, 12);
}

async function resolveSeasonCandidates(anime) {
  const queries = getTitleQueries(anime);
  if (!queries.length) throw new Error('Missing anime title');

  const seasonCandidates = [];
  for (const query of queries) {
    const payload = await fetchJson(`${API_BASE}/search?page=1&query=${encodeURIComponent(query)}&t=all&limit=6`).catch(() => ({}));
    const series = Array.isArray(payload?.series) ? payload.series : [];

    for (const s of series) {
      const details = await fetchJson(`${API_BASE}/series/${encodeURIComponent(String(s?.content_id || ''))}`).catch(() => null);
      if (!details) continue;
      const seasons = Array.isArray(details?.seasons) ? details.seasons : [];
      for (const season of seasons) {
        seasonCandidates.push({
          seasonId: String(season?.content_id || '').trim(),
          title: String(season?.title || s?.title || '').trim()
        });
      }
    }
    if (seasonCandidates.length > 10) break;
  }

  const unique = Array.from(new Map(seasonCandidates.filter((s) => s.seasonId).map((s) => [s.seasonId, s])).values());
  if (!unique.length) throw new Error('UniqueStream season match not found');

  const titles = getTitleQueries(anime);
  const ranked = unique
    .map((item) => ({
      ...item,
      score: Math.max(...titles.map((t) => similarity(item.title, t)))
    }))
    .sort((a, b) => b.score - a.score);

  return ranked;
}

async function getSeasonEpisodes(seasonId) {
  const episodes = [];
  let page = 1;
  while (true) {
    const payload = await fetchJson(`${API_BASE}/season/${encodeURIComponent(seasonId)}/episodes?page=${page}&limit=20&order_by=asc`).catch(() => []);
    if (!Array.isArray(payload) || payload.length === 0) break;
    for (const ep of payload) {
      const number = Number(ep?.episode_number);
      const contentId = String(ep?.content_id || '').trim();
      if (!Number.isFinite(number) || number < 1 || !contentId) continue;
      episodes.push({
        number,
        title: String(ep?.title || `Episode ${number}`),
        providerEpisodeId: contentId
      });
    }
    if (payload.length < 20) break;
    page += 1;
  }
  return episodes.sort((a, b) => a.number - b.number);
}

function mediaToSources(payload, dubbed) {
  const targetPrefix = dubbed ? 'en' : 'ja';
  const versions = Array.isArray(payload?.versions?.hls) ? payload.versions.hls : [];
  const primary = payload?.hls && payload.hls.playlist
    ? [{ locale: String(payload.hls.locale || ''), playlist: payload.hls.playlist }]
    : [];
  const candidates = [
    ...primary,
    ...versions
      .filter((v) => v?.playlist)
      .map((v) => ({ locale: String(v.locale || ''), playlist: v.playlist }))
  ];

  const unique = Array.from(new Map(candidates.map((c) => [c.playlist, c])).values());
  if (!unique.length) return [];

  const scored = unique
    .map((c) => {
      const locale = c.locale.toLowerCase();
      let score = 0;
      if (locale.startsWith(targetPrefix)) score += 3;
      if (locale.startsWith('en') || locale.startsWith('ja')) score += 1;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);

  // Keep only the most reliable streams: target locale first, plus one fallback.
  const selected = scored.slice(0, 2);
  return selected.map((item) => ({
    server: 'Default',
    url: item.playlist,
    label: item.locale || (dubbed ? 'English' : 'Japanese'),
    quality: 'auto',
    type: 'm3u8',
    subtitles: []
  }));
}

module.exports = {
  id: 'uniquestream',
  name: 'Anime UniqueStream',
  async getEpisodeList({ anime }) {
    const seasons = await resolveSeasonCandidates(anime);
    for (const season of seasons) {
      const episodes = await getSeasonEpisodes(season.seasonId).catch(() => []);
      if (episodes.length) return episodes;
    }
    throw new Error('UniqueStream returned no episodes');
  },
  async getEpisodeSources({ anime, episodeNumber, dubbed = false }) {
    const episodes = await this.getEpisodeList({ anime });
    const selected = episodes.find((ep) => ep.number === Number(episodeNumber));
    if (!selected?.providerEpisodeId) {
      throw new Error(`Episode ${episodeNumber} not found on UniqueStream`);
    }

    const primaryLocale = dubbed ? 'en-US' : 'ja-JP';
    const fallbackLocale = dubbed ? 'ja-JP' : 'en-US';

    let payload = await fetchJson(`${API_BASE}/episode/${encodeURIComponent(selected.providerEpisodeId)}/media/hls/${primaryLocale}`).catch(() => null);
    if (!payload) {
      payload = await fetchJson(`${API_BASE}/episode/${encodeURIComponent(selected.providerEpisodeId)}/media/hls/${fallbackLocale}`);
    }

    const videoSources = mediaToSources(payload, dubbed);
    if (!videoSources.length) {
      throw new Error('UniqueStream returned no playable HLS source');
    }

    return {
      number: Number(episodeNumber),
      videoSources,
      debug: {
        providerUsed: 'uniquestream',
        requestedLocale: primaryLocale
      }
    };
  }
};
