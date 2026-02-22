/**
 * ANIKAI — Consumet Provider
 * Uses @consumet/extensions (HiAnime + AnimeKai + AnimePahe) as a Cloudflare-resilient alternative.
 * Keeps the same interface as all other ANIKAI providers.
 *
 * Sub-provider selection:
 *   req body: { seaProvider: 'hianime' | 'animekai' | 'animepahe' }   (reuses seaProvider field)
 *   defaults to hianime
 */

let ANIME;
try {
  ({ ANIME } = require('@consumet/extensions'));
} catch (e) {
  console.error('[consumet] @consumet/extensions not installed:', e.message);
}

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

// ─── HiAnime wrapper ─────────────────────────────────────────────────────────

async function hianimeEpisodeList(anime, dubbed) {
  const hianime = new ANIME.Hianime();
  const titles = getTitleCandidates(anime);
  if (!titles.length) throw new Error('[consumet/hianime] No anime title');

  let animeId = null;
  for (const query of titles.slice(0, 4)) {
    const res = await hianime.search(query).catch(() => null);
    const results = res?.animes || res?.results || [];
    const match = bestMatch(results, anime);
    if (match?.id) { animeId = match.id; break; }
  }
  if (!animeId) throw new Error('[consumet/hianime] Could not find anime on HiAnime');

  const info = await hianime.fetchAnimeInfo(animeId);
  const episodes =
    info?.seasons?.[0]?.episodes ||
    info?.anime?.episodes ||
    info?.episodes ||
    [];

  return episodes
    .map((ep) => ({
      number: Number(ep.number || ep.episodeId?.match(/(\d+)$/)?.[1] || 0),
      title: ep.title || ep.name || `Episode ${ep.number}`,
      providerEpisodeId: String(ep.episodeId || ep.id || '')
    }))
    .filter((ep) => ep.number > 0)
    .sort((a, b) => a.number - b.number);
}

async function hianimeEpisodeSources(anime, episodeNumber, dubbed, server) {
  const hianime = new ANIME.Hianime();
  const episodes = await hianimeEpisodeList(anime, dubbed);
  const ep = episodes.find((e) => e.number === Number(episodeNumber));
  if (!ep) throw new Error(`[consumet/hianime] Episode ${episodeNumber} not found`);

  const category = dubbed ? 'dub' : 'sub';
  const src = await hianime.fetchEpisodeSources(ep.providerEpisodeId, undefined, category);

  const subtitles = (src?.tracks || [])
    .filter((t) => t.kind === 'captions' && t.file)
    .map((t, i) => ({
      id: `sub-${i}`,
      language: t.label || 'Unknown',
      url: t.file,
      isDefault: Boolean(t.default)
    }));

  const videoSources = [];
  for (const s of src?.sources || []) {
    const isHls = s.isM3U8 || String(s.type || '').toLowerCase() === 'hls';
    videoSources.push({
      server: server || 'consumet-hianime',
      url: s.url,
      label: `Consumet HiAnime (${s.quality || 'auto'})`,
      quality: s.quality || 'auto',
      type: isHls ? 'm3u8' : 'mp4',
      subtitles
    });
  }

  if (!videoSources.length) throw new Error('[consumet/hianime] No video sources found');
  return { number: episodeNumber, videoSources };
}

// ─── AnimeKai wrapper ─────────────────────────────────────────────────────────

async function animekaiEpisodeList(anime, dubbed) {
  const animekai = new ANIME.AnimeKai();
  const titles = getTitleCandidates(anime);
  if (!titles.length) throw new Error('[consumet/animekai] No anime title');

  let animeId = null;
  for (const query of titles.slice(0, 4)) {
    const res = await animekai.search(query).catch(() => null);
    const results = res?.results || [];
    const match = bestMatch(results, anime);
    if (match?.id) { animeId = match.id; break; }
  }
  if (!animeId) throw new Error('[consumet/animekai] Could not find anime on AnimeKai');

  const info = await animekai.fetchAnimeInfo(animeId);
  return (info?.episodes || [])
    .map((ep) => ({
      number: Number(ep.number || 0),
      title: ep.title || ep.name || `Episode ${ep.number}`,
      providerEpisodeId: String(ep.id || '')
    }))
    .filter((ep) => ep.number > 0)
    .sort((a, b) => a.number - b.number);
}

async function animekaiEpisodeSources(anime, episodeNumber, dubbed, server) {
  const animekai = new ANIME.AnimeKai();
  let SubOrSub;
  try {
    ({ SubOrSub } = require('@consumet/extensions/dist/models'));
  } catch (_) {
    SubOrSub = { SUB: 'sub', DUB: 'dub' };
  }

  const episodes = await animekaiEpisodeList(anime, dubbed);
  const ep = episodes.find((e) => e.number === Number(episodeNumber));
  if (!ep) throw new Error(`[consumet/animekai] Episode ${episodeNumber} not found`);

  const category = dubbed ? SubOrSub.DUB : SubOrSub.SUB;
  const src = await animekai.fetchEpisodeSources(ep.providerEpisodeId, undefined, category);

  const subtitles = (src?.tracks || [])
    .filter((t) => t.kind === 'captions' && t.file)
    .map((t, i) => ({
      id: `sub-${i}`,
      language: t.label || 'Unknown',
      url: t.file,
      isDefault: Boolean(t.default)
    }));

  const videoSources = [];
  for (const s of src?.sources || []) {
    const isHls = s.isM3U8 || String(s.type || '').toLowerCase() === 'hls';
    videoSources.push({
      server: server || 'consumet-animekai',
      url: s.url,
      label: `Consumet AnimeKai (${s.quality || 'auto'})`,
      quality: s.quality || 'auto',
      type: isHls ? 'm3u8' : 'mp4',
      subtitles
    });
  }

  if (!videoSources.length) throw new Error('[consumet/animekai] No video sources found');
  return { number: episodeNumber, videoSources };
}

// ─── AnimePahe wrapper ────────────────────────────────────────────────────────

async function animepaheEpisodeList(anime) {
  const animepahe = new ANIME.AnimePahe();
  const titles = getTitleCandidates(anime);
  if (!titles.length) throw new Error('[consumet/animepahe] No anime title');

  let animeId = null;
  for (const query of titles.slice(0, 4)) {
    const res = await animepahe.search(query).catch(() => null);
    const results = res?.results || [];
    const match = bestMatch(results, anime);
    if (match?.id) { animeId = match.id; break; }
  }
  if (!animeId) throw new Error('[consumet/animepahe] Could not find anime on AnimePahe');

  const info = await animepahe.fetchAnimeInfo(animeId);
  return (info?.episodes || [])
    .map((ep) => ({
      number: Number(ep.number || 0),
      title: ep.title || `Episode ${ep.number}`,
      providerEpisodeId: String(ep.id || '')
    }))
    .filter((ep) => ep.number > 0)
    .sort((a, b) => a.number - b.number);
}

async function animepaheEpisodeSources(anime, episodeNumber) {
  const animepahe = new ANIME.AnimePahe();
  const episodes = await animepaheEpisodeList(anime);
  const ep = episodes.find((e) => e.number === Number(episodeNumber));
  if (!ep) throw new Error(`[consumet/animepahe] Episode ${episodeNumber} not found`);

  const src = await animepahe.fetchEpisodeSources(ep.providerEpisodeId);
  const videoSources = (src?.sources || []).map((s) => ({
    server: 'consumet-animepahe',
    url: s.url,
    label: `Consumet AnimePahe (${s.quality || 'auto'})`,
    quality: s.quality || 'auto',
    type: s.isM3U8 ? 'm3u8' : 'mp4',
    subtitles: []
  }));

  if (!videoSources.length) throw new Error('[consumet/animepahe] No video sources found');
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

  /**
   * `seaProvider` field re-used to pick the consumet sub-source:
   *   'hianime'   → HiAnime  (default, best subtitle support)
   *   'animekai'  → AnimeKai (good dub support)
   *   'animepahe' → AnimePahe (good quality, less CF issues)
   */
  async getEpisodeList({ anime, dubbed = false, seaProvider }) {
    if (!ANIME) throw new Error('[consumet] @consumet/extensions is not installed');
    const sub = getSubProvider(seaProvider);
    console.log(`[consumet] getEpisodeList sub=${sub} dubbed=${dubbed}`);

    switch (sub) {
      case 'animekai': return animekaiEpisodeList(anime, dubbed);
      case 'animepahe': return animepaheEpisodeList(anime);
      default: return hianimeEpisodeList(anime, dubbed);
    }
  },

  async getEpisodeSources({ anime, episodeNumber, dubbed = false, server, seaProvider }) {
    if (!ANIME) throw new Error('[consumet] @consumet/extensions is not installed');
    const sub = getSubProvider(seaProvider);
    const ep = Number(episodeNumber);
    console.log(`[consumet] getEpisodeSources ep=${ep} sub=${sub} dubbed=${dubbed}`);

    if (!Number.isFinite(ep) || ep < 1) throw new Error('Invalid episode number');

    switch (sub) {
      case 'animekai': return animekaiEpisodeSources(anime, ep, dubbed, server);
      case 'animepahe': return animepaheEpisodeSources(anime, ep);
      default: return hianimeEpisodeSources(anime, ep, dubbed, server);
    }
  }
};
