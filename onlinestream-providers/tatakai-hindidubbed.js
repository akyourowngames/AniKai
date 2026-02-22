const REQUEST_TIMEOUT_MS = Number(process.env.TATAKAI_TIMEOUT_MS || 20000);
const BASE_URL = String(process.env.TATAKAI_BASE_URL || 'http://localhost:4000').trim().replace(/\/+$/, '');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function similarityScore(candidate, titles) {
  const value = normalize(candidate);
  if (!value) return 0;
  let score = 0;
  for (const rawTitle of titles) {
    const title = normalize(rawTitle);
    if (!title) continue;
    if (value === title) return 100;
    if (value.includes(title) || title.includes(value)) score = Math.max(score, 85);
    else if (value.split(' ').some((token) => token.length > 2 && title.includes(token))) score = Math.max(score, 65);
  }
  return score;
}

async function fetchJson(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return response.json();
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

async function resolveAnimeSlug(anime) {
  const titleCandidates = getTitleCandidates(anime);
  if (!titleCandidates.length) throw new Error('Missing anime title');

  const matches = [];
  for (const title of titleCandidates.slice(0, 4)) {
    const payload = await fetchJson(`/api/v1/hindidubbed/search?title=${encodeURIComponent(title)}`).catch(() => null);
    const items = Array.isArray(payload?.data?.animeList) ? payload.data.animeList : [];
    for (const item of items) {
      const slug = String(item?.slug || '').trim();
      if (!slug) continue;
      matches.push({
        slug,
        title: String(item?.title || slug),
        score: similarityScore(item?.title, titleCandidates)
      });
    }
    if (matches.length >= 10) break;
  }

  const unique = Array.from(new Map(matches.map((m) => [m.slug, m])).values());
  unique.sort((a, b) => b.score - a.score);
  if (!unique.length) throw new Error('Tatakai HindiDubbed search returned no matches');
  return unique[0];
}

function mapEpisodeServerType(url) {
  const value = String(url || '').toLowerCase();
  if (value.includes('.m3u8')) return 'm3u8';
  if (value.includes('.mp4')) return 'mp4';
  return 'embed';
}

module.exports = {
  id: 'tatakai-hindidubbed',
  name: 'Tatakai HindiDubbed',
  async getEpisodeList({ anime }) {
    const matched = await resolveAnimeSlug(anime);
    const payload = await fetchJson(`/api/v1/hindidubbed/anime/${encodeURIComponent(matched.slug)}`);
    const episodes = Array.isArray(payload?.data?.episodes) ? payload.data.episodes : [];
    const normalized = episodes
      .map((ep, idx) => {
        const number = Number(ep?.number || idx + 1);
        return {
          number: Number.isFinite(number) && number > 0 ? number : (idx + 1),
          title: String(ep?.title || `Episode ${idx + 1}`),
          providerEpisodeId: String(ep?.number || idx + 1)
        };
      })
      .filter((ep) => ep.number > 0)
      .sort((a, b) => a.number - b.number);
    if (!normalized.length) throw new Error('Tatakai HindiDubbed returned no episodes');
    return normalized;
  },
  async getEpisodeSources({ anime, episodeNumber, server }) {
    const ep = Number(episodeNumber);
    if (!Number.isFinite(ep) || ep < 1) throw new Error('Invalid episode number');

    const matched = await resolveAnimeSlug(anime);
    const payload = await fetchJson(`/api/v1/hindidubbed/anime/${encodeURIComponent(matched.slug)}`);
    const episodes = Array.isArray(payload?.data?.episodes) ? payload.data.episodes : [];
    const selected = episodes.find((item) => Number(item?.number) === ep);
    if (!selected) throw new Error(`Episode ${ep} not found`);

    const preferredServer = String(server || '').toLowerCase();
    const rawServers = Array.isArray(selected?.servers) ? selected.servers : [];
    const ordered = [
      ...rawServers.filter((s) => String(s?.name || '').toLowerCase() === preferredServer),
      ...rawServers.filter((s) => String(s?.name || '').toLowerCase() !== preferredServer)
    ];

    const videoSources = ordered
      .map((item) => {
        const url = String(item?.url || '').trim();
        if (!url) return null;
        const name = String(item?.name || 'Hindi Server').trim();
        return {
          server: name,
          url,
          label: `HindiDubbed ${name}`,
          quality: 'auto',
          type: mapEpisodeServerType(url)
        };
      })
      .filter(Boolean);

    if (!videoSources.length) throw new Error(`Episode ${ep} has no playable sources`);
    return {
      number: ep,
      videoSources,
      debug: {
        providerUsed: 'tatakai-hindidubbed',
        slug: matched.slug
      }
    };
  }
};
