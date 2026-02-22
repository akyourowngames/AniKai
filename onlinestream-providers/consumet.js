/**
 * ANIKAI — Consumet Provider
 * Uses @consumet/extensions npm package directly.
 *
 * Sub-provider via seaProvider field:
 *   'hianime'   → ANIME.Hianime   (default, best subtitle support)
 *   'animekai'  → ANIME.AnimeKai  (good dub support)
 *   'animepahe' → ANIME.AnimePahe (good quality)
 *
 * NOTE on class names (these are the ACTUAL export names in the package):
 *   ANIME.Hianime   ← NOT HiAnime or HiAnime.Scraper
 *   ANIME.AnimeKai  ← correct
 *   ANIME.AnimePahe ← correct
 */

let _ANIME = null;
let SubOrSub = { SUB: 'sub', DUB: 'dub' };
let StreamingServers = { VidCloud: 'vidcloud', VidStreaming: 'vidstreaming' };

try {
  const ext = require('@consumet/extensions');
  _ANIME = ext.ANIME;
  const models = require('@consumet/extensions/dist/models');
  if (models.SubOrSub) SubOrSub = models.SubOrSub;
  if (models.StreamingServers) StreamingServers = models.StreamingServers;
} catch (e) {
  console.warn('[consumet] @consumet/extensions unavailable:', e.message);
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

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
  const left = String(a || ''), right = String(b || '');
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const lenA = left.length, lenB = right.length;
  const dp = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;
  for (let i = 1; i <= lenA; i++)
    for (let j = 1; j <= lenB; j++)
      dp[i][j] = left[i - 1] === right[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return 1 - dp[lenA][lenB] / Math.max(lenA, lenB);
}

function bestMatch(results, anime) {
  const titles = getTitleCandidates(anime).map(normalize).filter(Boolean);
  if (!titles.length || !results.length) return results[0] || null;

  let best = null, bestScore = -1;
  for (const r of results) {
    const candidates = [r.title, r.japaneseTitle, r.otherName, r.name]
      .map((v) => normalize(v || '')).filter(Boolean);
    let score = 0;
    for (const t of titles)
      for (const c of candidates) {
        if (c === t) { score = 100; break; }
        score = Math.max(score, levenshteinSimilarity(c, t) * 80);
      }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

// ─── HiAnime wrapper ─────────────────────────────────────────────────────────

async function hianimeEpisodeList(anime, dubbed) {
  const client = new _ANIME.Hianime();
  const titles = getTitleCandidates(anime);

  let animeId = null;
  for (const query of titles.slice(0, 4)) {
    const res = await client.search(query).catch(() => null);
    const match = bestMatch(res?.results || [], anime);
    if (match?.id) { animeId = match.id; break; }
  }
  if (!animeId) throw new Error('[consumet/hianime] Could not find anime');

  const info = await client.fetchAnimeInfo(animeId);
  return (info?.episodes || [])
    .map((ep) => ({
      number: Number(ep.number || 0),
      title: ep.title || `Episode ${ep.number}`,
      providerEpisodeId: String(ep.id || '')
    }))
    .filter((ep) => ep.number > 0 && ep.providerEpisodeId)
    .sort((a, b) => a.number - b.number);
}

async function hianimeEpisodeSources(anime, episodeNumber, dubbed) {
  const client = new _ANIME.Hianime();
  const episodes = await hianimeEpisodeList(anime, dubbed);
  const ep = episodes.find((e) => e.number === episodeNumber);
  if (!ep) throw new Error(`[consumet/hianime] Episode ${episodeNumber} not found`);

  const category = dubbed ? SubOrSub.DUB : SubOrSub.SUB;
  const src = await client.fetchEpisodeSources(ep.providerEpisodeId, StreamingServers.VidCloud, category);

  const subtitles = (src?.tracks || [])
    .filter((t) => t.kind === 'captions' && t.file)
    .map((t, i) => ({ id: `sub-${i}`, language: t.label || 'Unknown', url: t.file, isDefault: Boolean(t.default) }));

  const videoSources = (src?.sources || []).map((s) => ({
    server: 'consumet-hianime',
    url: s.url,
    label: `Consumet HiAnime (${s.quality || 'auto'})`,
    quality: s.quality || 'auto',
    type: s.isM3U8 ? 'm3u8' : 'mp4',
    subtitles,
    headers: src?.headers || {}
  }));

  if (!videoSources.length) throw new Error('[consumet/hianime] No video sources');
  return { number: episodeNumber, videoSources };
}

// ─── AnimeKai wrapper ─────────────────────────────────────────────────────────

async function animekaiEpisodeList(anime, dubbed) {
  const client = new _ANIME.AnimeKai();
  const titles = getTitleCandidates(anime);

  let animeId = null;
  for (const query of titles.slice(0, 4)) {
    const res = await client.search(query).catch(() => null);
    const match = bestMatch(res?.results || [], anime);
    if (match?.id) { animeId = match.id; break; }
  }
  if (!animeId) throw new Error('[consumet/animekai] Could not find anime');

  const info = await client.fetchAnimeInfo(animeId);
  return (info?.episodes || [])
    .map((ep) => ({
      number: Number(ep.number || 0),
      title: ep.title || `Episode ${ep.number}`,
      providerEpisodeId: String(ep.id || '')
    }))
    .filter((ep) => ep.number > 0 && ep.providerEpisodeId)
    .sort((a, b) => a.number - b.number);
}

async function animekaiEpisodeSources(anime, episodeNumber, dubbed) {
  const client = new _ANIME.AnimeKai();
  const episodes = await animekaiEpisodeList(anime, dubbed);
  const ep = episodes.find((e) => e.number === episodeNumber);
  if (!ep) throw new Error(`[consumet/animekai] Episode ${episodeNumber} not found`);

  const category = dubbed ? SubOrSub.DUB : SubOrSub.SUB;
  const src = await client.fetchEpisodeSources(ep.providerEpisodeId, undefined, category);

  const subtitles = (src?.tracks || [])
    .filter((t) => t.kind === 'captions' && t.file)
    .map((t, i) => ({ id: `sub-${i}`, language: t.label || 'Unknown', url: t.file, isDefault: Boolean(t.default) }));

  const videoSources = (src?.sources || []).map((s) => ({
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

// ─── AnimePahe wrapper ────────────────────────────────────────────────────────

async function animepaheEpisodeList(anime) {
  const client = new _ANIME.AnimePahe();
  const titles = getTitleCandidates(anime);

  let animeId = null;
  for (const query of titles.slice(0, 4)) {
    const res = await client.search(query).catch(() => null);
    const match = bestMatch(res?.results || [], anime);
    if (match?.id) { animeId = match.id; break; }
  }
  if (!animeId) throw new Error('[consumet/animepahe] Could not find anime');

  const info = await client.fetchAnimeInfo(animeId);
  return (info?.episodes || [])
    .map((ep) => ({
      number: Number(ep.number || ep.episode || 0),
      title: ep.title || `Episode ${ep.number || ep.episode}`,
      providerEpisodeId: String(ep.id || '')
    }))
    .filter((ep) => ep.number > 0 && ep.providerEpisodeId)
    .sort((a, b) => a.number - b.number);
}

async function animepaheEpisodeSources(anime, episodeNumber) {
  const client = new _ANIME.AnimePahe();
  const episodes = await animepaheEpisodeList(anime);
  const ep = episodes.find((e) => e.number === episodeNumber);
  if (!ep) throw new Error(`[consumet/animepahe] Episode ${episodeNumber} not found`);

  const src = await client.fetchEpisodeSources(ep.providerEpisodeId);
  const videoSources = (src?.sources || []).map((s) => ({
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

// ─── Sub-provider dispatcher ──────────────────────────────────────────────────

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
    if (!_ANIME) throw new Error('[consumet] @consumet/extensions not available on this server');
    const sub = getSubProvider(seaProvider);
    console.log(`[consumet] getEpisodeList sub=${sub} dubbed=${dubbed}`);

    switch (sub) {
      case 'animekai': return animekaiEpisodeList(anime, dubbed);
      case 'animepahe': return animepaheEpisodeList(anime);
      default: return hianimeEpisodeList(anime, dubbed);
    }
  },

  async getEpisodeSources({ anime, episodeNumber, dubbed = false, seaProvider }) {
    if (!_ANIME) throw new Error('[consumet] @consumet/extensions not available on this server');
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
