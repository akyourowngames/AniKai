/**
 * ANIKAI — Consumet Provider (API-based)
 * Uses the public Consumet API (or self-hosted) as a CF-resilient fallback.
 * No heavy npm dependencies — just HTTP calls.
 *
 * Sub-provider selection via seaProvider field:
 *   'hianime'   → Consumet HiAnime  (default)
 *   'animekai'  → Consumet AnimeKai
 *   'animepahe' → Consumet AnimePahe
 */

const CONSUMET_BASE = (process.env.CONSUMET_API || 'https://api.consumet.org').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 20000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/(season|cour|part|the animation|the movie|movie|uncensored)/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function getTitleCandidates(anime) {
  return [
    ...new Set(
      [anime?.title, anime?.titleEnglish, anime?.titleRomaji, anime?.titleNative]
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    )
  ];
}

function levenshteinSimilarity(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const lenA = left.length;
  const lenB = right.length;
  const dp = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      if (left[i - 1] === right[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[lenA][lenB] / Math.max(lenA, lenB);
}

function bestMatch(results, anime) {
  const titles = getTitleCandidates(anime).map(normalize).filter(Boolean);
  if (!titles.length || !results.length) return results[0] || null;

  let best = null;
  let bestScore = -1;

  for (const r of results) {
    const candidates = [
      normalize(r.title || ''),
      normalize(r.japaneseTitle || ''),
      normalize(r.otherName || ''),
      normalize(r.name || '')
    ].filter(Boolean);

    let score = 0;
    for (const t of titles) {
      for (const c of candidates) {
        if (c === t) { score = Math.max(score, 100); break; }
        score = Math.max(score, levenshteinSimilarity(c, t) * 80);
      }
    }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

async function apiFetch(path) {
  const url = `${CONSUMET_BASE}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!res.ok) throw new Error(`Consumet API ${res.status}: ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ─── HiAnime (via Consumet API) ──────────────────────────────────────────────

async function hianimeSearch(anime) {
  const titles = getTitleCandidates(anime);
  for (const q of titles.slice(0, 4)) {
    const data = await apiFetch(`/anime/hianime/${encodeURIComponent(q)}`).catch(() => null);
    const results = data?.results || [];
    const match = bestMatch(results, anime);
    if (match?.id) return match.id;
  }
  throw new Error('[consumet/hianime] Could not find anime');
}

async function hianimeEpisodeList(anime, dubbed) {
  const animeId = await hianimeSearch(anime);
  const info = await apiFetch(`/anime/hianime/info?id=${encodeURIComponent(animeId)}`);
  return (info?.episodes || [])
    .map((ep) => ({
      number: Number(ep.number || 0),
      title: ep.title || `Episode ${ep.number}`,
      providerEpisodeId: String(ep.id || '')
    }))
    .filter((ep) => ep.number > 0)
    .sort((a, b) => a.number - b.number);
}

async function hianimeEpisodeSources(anime, episodeNumber, dubbed) {
  const episodes = await hianimeEpisodeList(anime, dubbed);
  const ep = episodes.find((e) => e.number === episodeNumber);
  if (!ep) throw new Error(`[consumet/hianime] Episode ${episodeNumber} not found`);

  const category = dubbed ? 'dub' : 'sub';
  const data = await apiFetch(`/anime/hianime/watch/${encodeURIComponent(ep.providerEpisodeId)}?category=${category}`);

  const subtitles = (data?.subtitles || data?.tracks || [])
    .filter((t) => t.kind === 'captions' && (t.url || t.file))
    .map((t, i) => ({
      id: `sub-${i}`,
      language: t.lang || t.label || 'Unknown',
      url: t.url || t.file,
      isDefault: Boolean(t.default)
    }));

  const videoSources = (data?.sources || []).map((s) => ({
    server: 'consumet-hianime',
    url: s.url,
    label: `Consumet HiAnime (${s.quality || 'auto'})`,
    quality: s.quality || 'auto',
    type: s.isM3U8 ? 'm3u8' : 'mp4',
    subtitles
  }));

  if (!videoSources.length) throw new Error('[consumet/hianime] No video sources');
  return { number: episodeNumber, videoSources };
}

// ─── AnimeKai (via Consumet API) ─────────────────────────────────────────────

async function animekaiSearch(anime) {
  const titles = getTitleCandidates(anime);
  for (const q of titles.slice(0, 4)) {
    const data = await apiFetch(`/anime/animekai/${encodeURIComponent(q)}`).catch(() => null);
    const results = data?.results || [];
    const match = bestMatch(results, anime);
    if (match?.id) return match.id;
  }
  throw new Error('[consumet/animekai] Could not find anime');
}

async function animekaiEpisodeList(anime, dubbed) {
  const animeId = await animekaiSearch(anime);
  const info = await apiFetch(`/anime/animekai/info?id=${encodeURIComponent(animeId)}`);
  return (info?.episodes || [])
    .map((ep) => ({
      number: Number(ep.number || 0),
      title: ep.title || `Episode ${ep.number}`,
      providerEpisodeId: String(ep.id || '')
    }))
    .filter((ep) => ep.number > 0)
    .sort((a, b) => a.number - b.number);
}

async function animekaiEpisodeSources(anime, episodeNumber, dubbed) {
  const episodes = await animekaiEpisodeList(anime, dubbed);
  const ep = episodes.find((e) => e.number === episodeNumber);
  if (!ep) throw new Error(`[consumet/animekai] Episode ${episodeNumber} not found`);

  const dubParam = dubbed ? '&dub=true' : '';
  const data = await apiFetch(`/anime/animekai/watch/${encodeURIComponent(ep.providerEpisodeId)}?${dubParam}`);

  const subtitles = (data?.subtitles || data?.tracks || [])
    .filter((t) => t.kind === 'captions' && (t.url || t.file))
    .map((t, i) => ({
      id: `sub-${i}`,
      language: t.lang || t.label || 'Unknown',
      url: t.url || t.file,
      isDefault: Boolean(t.default)
    }));

  const videoSources = (data?.sources || []).map((s) => ({
    server: 'consumet-animekai',
    url: s.url,
    label: `Consumet AnimeKai (${s.quality || 'auto'})`,
    quality: s.quality || 'auto',
    type: s.isM3U8 ? 'm3u8' : 'mp4',
    subtitles
  }));

  if (!videoSources.length) throw new Error('[consumet/animekai] No video sources');
  return { number: episodeNumber, videoSources };
}

// ─── AnimePahe (via Consumet API) ────────────────────────────────────────────

async function animepaheSearch(anime) {
  const titles = getTitleCandidates(anime);
  for (const q of titles.slice(0, 4)) {
    const data = await apiFetch(`/anime/animepahe/${encodeURIComponent(q)}`).catch(() => null);
    const results = data?.results || [];
    const match = bestMatch(results, anime);
    if (match?.id) return match.id;
  }
  throw new Error('[consumet/animepahe] Could not find anime');
}

async function animepaheEpisodeList(anime) {
  const animeId = await animepaheSearch(anime);
  const info = await apiFetch(`/anime/animepahe/info/${encodeURIComponent(animeId)}`);
  return (info?.episodes || [])
    .map((ep) => ({
      number: Number(ep.number || ep.episode || 0),
      title: ep.title || `Episode ${ep.number || ep.episode}`,
      providerEpisodeId: String(ep.id || '')
    }))
    .filter((ep) => ep.number > 0)
    .sort((a, b) => a.number - b.number);
}

async function animepaheEpisodeSources(anime, episodeNumber) {
  const episodes = await animepaheEpisodeList(anime);
  const ep = episodes.find((e) => e.number === episodeNumber);
  if (!ep) throw new Error(`[consumet/animepahe] Episode ${episodeNumber} not found`);

  const data = await apiFetch(`/anime/animepahe/watch/${encodeURIComponent(ep.providerEpisodeId)}`);
  const videoSources = (data?.sources || []).map((s) => ({
    server: 'consumet-animepahe',
    url: s.url,
    label: `Consumet AnimePahe (${s.quality || 'auto'})`,
    quality: s.quality || 'auto',
    type: s.isM3U8 ? 'm3u8' : 'mp4',
    subtitles: []
  }));

  if (!videoSources.length) throw new Error('[consumet/animepahe] No video sources');
  return { number: episodeNumber, videoSources };
}

// ─── Sub-provider dispatcher ─────────────────────────────────────────────────

function getSubProvider(seaProvider) {
  const p = String(seaProvider || 'hianime').toLowerCase().trim();
  if (p === 'animekai') return 'animekai';
  if (p === 'animepahe') return 'animepahe';
  return 'hianime';
}

// ─── ANIKAI Provider Interface ────────────────────────────────────────────────

module.exports = {
  id: 'consumet',
  name: 'Consumet',

  async getEpisodeList({ anime, dubbed = false, seaProvider }) {
    const sub = getSubProvider(seaProvider);
    console.log(`[consumet] getEpisodeList sub=${sub} dubbed=${dubbed}`);

    switch (sub) {
      case 'animekai': return animekaiEpisodeList(anime, dubbed);
      case 'animepahe': return animepaheEpisodeList(anime);
      default: return hianimeEpisodeList(anime, dubbed);
    }
  },

  async getEpisodeSources({ anime, episodeNumber, dubbed = false, server, seaProvider }) {
    const sub = getSubProvider(seaProvider);
    const ep = Number(episodeNumber);
    console.log(`[consumet] getEpisodeSources ep=${ep} sub=${sub} dubbed=${dubbed}`);

    if (!Number.isFinite(ep) || ep < 1) throw new Error('Invalid episode number');

    switch (sub) {
      case 'animekai': return animekaiEpisodeSources(anime, ep, dubbed);
      case 'animepahe': return animepaheEpisodeSources(anime, ep);
      default: return hianimeEpisodeSources(anime, ep, dubbed);
    }
  }
};
