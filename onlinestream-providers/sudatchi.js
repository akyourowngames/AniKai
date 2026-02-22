const BASE_URL = (process.env.SUDATCHI_BASE_URL || 'https://sudatchi.com').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.SUDATCHI_TIMEOUT_MS || 15000);

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Referer: `${BASE_URL}/`,
        Origin: BASE_URL,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
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

function toAbsUrl(pathOrUrl) {
  const raw = String(pathOrUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `${BASE_URL}${raw}`;
  return `${BASE_URL}/${raw}`;
}

function getAnimeId(anime, mediaId) {
  const fromAnime = String(anime?.id || '').trim();
  if (fromAnime) return fromAnime;
  const fromMedia = String(mediaId || '').trim();
  if (fromMedia) return fromMedia;
  throw new Error('Missing anime id');
}

async function getAnimePayload(animeId) {
  return fetchJson(`${BASE_URL}/api/anime/${encodeURIComponent(animeId)}`);
}

function normalizeEpisodeList(animeId, payload) {
  const episodes = Array.isArray(payload?.episodes) ? payload.episodes : [];
  return episodes
    .map((ep) => {
      const number = Number(ep?.number);
      if (!Number.isFinite(number) || number < 1) return null;
      return {
        number,
        title: String(ep?.title || `Episode ${number}`),
        providerEpisodeId: `${animeId}/${number}`
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);
}

async function getEpisodePayload(animeId, episodeNumber) {
  return fetchJson(`${BASE_URL}/api/episode/${encodeURIComponent(animeId)}/${encodeURIComponent(String(episodeNumber))}`);
}

function findTargetEpisode(payload, episodeNumber) {
  const direct = payload?.episode;
  if (direct && Number(direct?.number) === Number(episodeNumber)) return direct;

  const episodes = Array.isArray(payload?.episodes) ? payload.episodes : [];
  return episodes.find((ep) => Number(ep?.number) === Number(episodeNumber)) || null;
}

async function getSubtitles(episodeId) {
  const payload = await fetchJson(`${BASE_URL}/api/subtitles/${encodeURIComponent(String(episodeId))}`).catch(() => ({}));
  const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles : [];

  return subtitles
    .map((sub, index) => ({
      id: String(sub?.id || `sub-${index}`),
      url: toAbsUrl(sub?.file || sub?.url),
      language: String(sub?.label || sub?.lang || 'Unknown'),
      isDefault: Boolean(sub?.isDefault) || index === 0
    }))
    .filter((sub) => sub.url);
}

module.exports = {
  id: 'sudatchi',
  name: 'Sudatchi',
  async getEpisodeList({ anime, mediaId }) {
    const animeId = getAnimeId(anime, mediaId);
    const payload = await getAnimePayload(animeId);
    const episodes = normalizeEpisodeList(animeId, payload);
    if (!episodes.length) {
      throw new Error('Sudatchi returned no episodes');
    }
    return episodes;
  },
  async getEpisodeSources({ anime, mediaId, episodeNumber, dubbed = false }) {
    const animeId = getAnimeId(anime, mediaId);
    const epNum = Number(episodeNumber);
    if (!Number.isFinite(epNum) || epNum < 1) {
      throw new Error('Invalid episode number');
    }

    const epPayload = await getEpisodePayload(animeId, epNum);
    const targetEp = findTargetEpisode(epPayload, epNum);
    if (!targetEp?.id) {
      throw new Error('Sudatchi episode not found');
    }

    const subtitles = await getSubtitles(targetEp.id);
    const streamUrl = `${BASE_URL}/api/streams?episodeId=${encodeURIComponent(String(targetEp.id))}`;

    return {
      number: epNum,
      videoSources: [
        {
          server: 'Default',
          url: streamUrl,
          label: dubbed ? 'Sudatchi Dub' : 'Sudatchi Sub',
          quality: 'auto',
          type: 'm3u8',
          subtitles
        }
      ],
      debug: {
        providerUsed: 'sudatchi',
        preferredAudioLanguage: dubbed ? 'English' : 'Japanese',
        episodeId: String(targetEp.id)
      }
    };
  }
};
