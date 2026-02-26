const REQUEST_TIMEOUT_MS = Number(process.env.TATAKAI_TIMEOUT_MS || 20000);
const BASE_URL = String(process.env.TATAKAI_BASE_URL || 'https://anikai-tatakai.onrender.com').trim().replace(/\/+$/, '');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getTitleCandidates(anime) {
  return [...new Set([
    anime?.title,
    anime?.titleEnglish,
    anime?.titleRomaji,
    anime?.titleNative
  ].map((v) => String(v || '').trim()).filter(Boolean))];
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

async function resolveSlugFromSearch(anime) {
  const titleCandidates = getTitleCandidates(anime);
  if (!titleCandidates.length) throw new Error('Missing anime title');

  const matches = [];
  for (const title of titleCandidates.slice(0, 4)) {
    const payload = await fetchJson(`/api/v1/desidubanime/search?q=${encodeURIComponent(title)}`).catch(() => null);
    const items = Array.isArray(payload?.data?.results) ? payload.data.results : [];
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
  if (unique.length) return unique[0];

  // Fallback to featured home if search is empty.
  const home = await fetchJson('/api/v1/desidubanime/home').catch(() => ({}));
  const featured = Array.isArray(home?.data?.featured) ? home.data.featured : [];
  const rankedFeatured = featured
    .map((item) => ({
      slug: String(item?.slug || '').trim(),
      title: String(item?.title || ''),
      score: similarityScore(item?.title, titleCandidates)
    }))
    .filter((item) => item.slug)
    .sort((a, b) => b.score - a.score);

  if (!rankedFeatured.length) throw new Error('Tatakai DesiDubAnime returned no matches');
  return rankedFeatured[0];
}

function mapSourceType(source) {
  if (source?.isM3U8) return 'm3u8';
  const url = String(source?.url || '').toLowerCase();
  if (url.includes('.m3u8')) return 'm3u8';
  if (url.includes('.mp4')) return 'mp4';
  if (source?.isEmbed) return 'embed';
  return 'embed';
}

module.exports = {
  id: 'tatakai-desidubanime',
  name: 'Tatakai DesiDubAnime',
  async getEpisodeList({ anime }) {
    const matched = await resolveSlugFromSearch(anime);
    const payload = await fetchJson(`/api/v1/desidubanime/info/${encodeURIComponent(matched.slug)}`);
    const episodes = Array.isArray(payload?.data?.episodes) ? payload.data.episodes : [];
    const normalized = episodes
      .map((ep, idx) => {
        const number = Number(ep?.number || idx + 1);
        const epId = String(ep?.id || '').trim();
        return {
          number: Number.isFinite(number) && number > 0 ? number : (idx + 1),
          title: String(ep?.title || `Episode ${idx + 1}`),
          providerEpisodeId: epId
        };
      })
      .filter((ep) => ep.number > 0 && ep.providerEpisodeId)
      .sort((a, b) => a.number - b.number);
    if (!normalized.length) throw new Error('Tatakai DesiDubAnime returned no episodes');
    return normalized;
  },
  async getEpisodeSources({ anime, episodeNumber, dubbed = false, server }) {
    const ep = Number(episodeNumber);
    if (!Number.isFinite(ep) || ep < 1) throw new Error('Invalid episode number');

    const matched = await resolveSlugFromSearch(anime);
    const info = await fetchJson(`/api/v1/desidubanime/info/${encodeURIComponent(matched.slug)}`);
    const episodes = Array.isArray(info?.data?.episodes) ? info.data.episodes : [];
    const selected = episodes.find((item) => Number(item?.number) === ep);
    if (!selected?.id) throw new Error(`Episode ${ep} not found`);

    const watch = await fetchJson(`/api/v1/desidubanime/watch/${encodeURIComponent(String(selected.id))}`);
    const rawSources = Array.isArray(watch?.data?.sources) ? watch.data.sources : [];
    const preferredServer = String(server || '').toLowerCase();

    const ranked = rawSources
      .map((source) => {
        const category = String(source?.category || '').toLowerCase();
        const isDubLike = category === 'dub' || String(source?.language || '').toLowerCase().includes('hindi');
        const serverName = String(source?.name || 'server').trim();
        const serverMatch = preferredServer && serverName.toLowerCase() === preferredServer;
        let rank = 0;
        if (serverMatch) rank += 40;
        rank += dubbed ? (isDubLike ? 20 : 0) : (isDubLike ? 0 : 20);
        return { source, rank };
      })
      .sort((a, b) => b.rank - a.rank)
      .map((item) => item.source);

    const videoSources = ranked
      .map((source) => {
        const url = String(source?.url || '').trim();
        if (!url) return null;
        const name = String(source?.name || 'DesiDub').trim();
        return {
          server: name,
          url,
          label: `DesiDub ${name}`,
          quality: String(source?.quality || 'auto'),
          type: mapSourceType(source)
        };
      })
      .filter(Boolean);

    if (!videoSources.length) throw new Error(`Episode ${ep} has no playable sources`);
    return {
      number: ep,
      videoSources,
      debug: {
        providerUsed: 'tatakai-desidubanime',
        slug: matched.slug,
        episodeId: String(selected.id)
      }
    };
  }
};
