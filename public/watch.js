const params = new URLSearchParams(window.location.search);
const animeId = params.get('id');
const sourceParam = params.get('source');
const source = sourceParam === 'mal' ? 'mal' : 'anilist';
const hasQueryProvider = params.has('provider');
const hasQuerySeaProvider = params.has('seaProvider');
const hasQueryDub = params.has('dubbed');
const hasQueryServer = params.has('server');
const hasQueryQuality = params.has('quality');

const titleEl = document.querySelector('#animeTitle');
const metaEl = document.querySelector('#animeMeta');
const descEl = document.querySelector('#animeDesc');
const posterEl = document.querySelector('#animePoster');
const playerHostEl = document.querySelector('#playerHost');
const providerSelectEl = document.querySelector('#providerSelect');
const seaProviderSelectEl = document.querySelector('#seaProviderSelect');
let dubSelectEl = document.querySelector('#dubSelect');
const serverSelectEl = document.querySelector('#serverSelect');
const qualitySelectEl = document.querySelector('#qualitySelect');
const audioSelectEl = document.querySelector('#audioSelect');
const episodeListEl = document.querySelector('#episodeList');
const epCountEl = document.querySelector('#epCount');
const nextEpBtn = document.querySelector('#nextEpBtn');
const prevEpBtn = document.querySelector('#prevEpBtn');
const theaterBtn = document.querySelector('#theaterBtn');
const sidebarToggle = document.querySelector('#sidebarToggle');

// Search refs
const searchInput = document.querySelector('#searchInput');
const searchResults = document.querySelector('#searchResults');
const searchResultTemplate = document.querySelector('#searchResultTemplate');
const firebaseClient = window.AnikaiFirebase || null;
const PLAYER_PREFS_KEY = 'anikai_player_prefs';
const RECENT_SEARCHES_KEY = 'anikai_recent_searches';
const WATCH_ANIME_CACHE_PREFIX = 'anikai_watch_anime_v1';
const WATCH_EPISODES_CACHE_PREFIX = 'anikai_watch_episodes_v1';
const WATCH_ANIME_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const WATCH_EPISODES_CACHE_TTL_MS = 1000 * 60 * 15; // 15m
const ADSTERRA_SCRIPT_SRC = 'https://pl28774943.effectivegatecpm.com/be/a8/ac/bea8ac581664f9ee80688dd92d9263ca.js';
const ADSTERRA_SESSION_KEY = 'anikai_adsterra_loaded_v1';
const ADSTERRA_LAST_TS_KEY = 'anikai_adsterra_last_ts_v1';
const ADSTERRA_COOLDOWN_MS = 1000 * 60 * 15; // 15m

let hlsInstance = null;
let plyrInstance = null;
let selectedEpisode = Number(params.get('episode')) || 1;
let selectedProvider = (params.get('provider') || 'seanime').toLowerCase();
let selectedSeaProvider = (params.get('seaProvider') || '').toLowerCase();
let selectedDub = ['1', 'true', 'yes', 'dub'].includes(String(params.get('dubbed') || '').toLowerCase());
let availableSeaProviders = [];
let selectedServer = params.get('server') || '';
let selectedQuality = params.get('quality') || 'auto';
let currentSources = [];
let sourceCursor = 0;
let currentSourceOrder = [];
let episodeData = [];
let catalog = []; // For quick search
let availableProviderIds = [];
let streamApiBaseUrl = '';
let searchAbortController = null;
const blockedProviderIds = new Set(['animesaturn', 'sudatchi', 'anizone']);
const defaultProviderOptions = [
  { id: 'seanime', name: 'SeaAnime Bridge' },
  { id: 'anicrush', name: 'AniCrush' },
  { id: 'hianime', name: 'HiAnime' },
  { id: 'consumet-hianime', name: 'Consumet HiAnime' },
  { id: 'consumet-animekai', name: 'Consumet AnimeKai' },
  { id: 'consumet-animepahe', name: 'Consumet AnimePahe' },
  { id: 'uniquestream', name: 'Anime UniqueStream' },
  { id: 'tatakai-hindidubbed', name: 'Tatakai HindiDubbed' },
  { id: 'tatakai-desidubanime', name: 'Tatakai DesiDubAnime' },
  { id: 'consumet', name: 'Consumet' }
];

function readPlayerPrefs() {
  try {
    const raw = localStorage.getItem(PLAYER_PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function savePlayerPrefs(next) {
  const current = readPlayerPrefs();
  const merged = { ...current, ...next };
  localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(merged));
}

function safeReadJsonStorage(key, storage = window.sessionStorage) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function safeWriteJsonStorage(key, value, storage = window.sessionStorage) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (_) {
    // Ignore storage quota/private-mode failures.
  }
}

function buildAnimeCacheKey() {
  return `${WATCH_ANIME_CACHE_PREFIX}:${source}:${animeId}`;
}

function buildEpisodesCacheKey() {
  return [
    WATCH_EPISODES_CACHE_PREFIX,
    source,
    animeId,
    selectedProvider || '',
    selectedSeaProvider || '',
    selectedDub ? 'dub' : 'sub'
  ].join(':');
}

function isFreshCache(entry, ttlMs) {
  if (!entry || typeof entry.ts !== 'number') return false;
  return Date.now() - entry.ts < ttlMs;
}

function normalizeAnime(anime) {
  if (!anime || typeof anime !== 'object') return null;
  const genres = Array.isArray(anime.genres) ? anime.genres.filter(Boolean) : [];
  return {
    id: anime.id,
    title: String(anime.title || 'Unknown title'),
    poster: String(anime.poster || ''),
    description: String(anime.description || 'No description available yet.'),
    score: anime.score ?? '0.0',
    year: anime.year ?? 'N/A',
    type: anime.type ?? 'TV',
    genres
  };
}

function renderAnimeDetails(anime) {
  if (!anime) return;
  titleEl.textContent = anime.title;
  posterEl.src = anime.poster || '';
  posterEl.alt = anime.title || 'Poster';
  descEl.textContent = anime.description;

  const topGenres = Array.isArray(anime.genres) ? anime.genres.slice(0, 3) : [];
  metaEl.innerHTML = `
      <div class="pill accent">* ${anime.score || '0.0'}</div>
      <div class="pill">${anime.year || 'N/A'}</div>
      <div class="pill">${anime.type || 'TV'}</div>
      ${topGenres.map((g) => `<div class="pill">${g}</div>`).join('')}
    `;
}

function getSearchUserKey() {
  return firebaseClient?.getCurrentUser?.()?.uid || 'guest';
}

function getRecentSearchStore() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '{}');
  } catch (_) {
    return {};
  }
}

function pushRecentSearch(query) {
  const term = String(query || '').trim();
  if (!term) return;
  const store = getRecentSearchStore();
  const key = getSearchUserKey();
  const list = Array.isArray(store[key]) ? store[key] : [];
  store[key] = [term, ...list.filter((item) => item.toLowerCase() !== term.toLowerCase())].slice(0, 8);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(store));
}

function getRecentSearches(limit = 6) {
  const store = getRecentSearchStore();
  const key = getSearchUserKey();
  const list = Array.isArray(store[key]) ? store[key] : [];
  return list.slice(0, limit);
}

const savedPrefs = readPlayerPrefs();
if (!hasQueryProvider && savedPrefs.provider) selectedProvider = String(savedPrefs.provider).toLowerCase();
if (!hasQuerySeaProvider && savedPrefs.seaProvider) selectedSeaProvider = String(savedPrefs.seaProvider).toLowerCase();
if (!hasQueryDub && typeof savedPrefs.dubbed === 'boolean') selectedDub = savedPrefs.dubbed;
if (!hasQueryServer && savedPrefs.server) selectedServer = String(savedPrefs.server);
if (!hasQueryQuality && savedPrefs.quality) selectedQuality = String(savedPrefs.quality);

function triggerAdsterra(reason = '') {
  const F = window.AnikaiFeatures;
  if (F && typeof F.triggerPopunder === 'function') {
    return F.triggerPopunder(reason);
  }
  return false;
}

function ensureDubSelectElement() {
  const bindDubListener = (el) => {
    if (!el || el.dataset.boundDub === '1') return;
    el.addEventListener('change', async () => {
      selectedDub = el.value === 'dub';
      savePlayerPrefs({ dubbed: selectedDub });
      updateUrlParams({ dubbed: selectedDub ? '1' : null });
      await loadEpisodeList();
    });
    el.dataset.boundDub = '1';
  };

  if (dubSelectEl) {
    bindDubListener(dubSelectEl);
    return dubSelectEl;
  }
  const tools = document.querySelector('.ep-tools-premium');
  if (!tools || !seaProviderSelectEl) return null;

  const node = document.createElement('select');
  node.id = 'dubSelect';
  node.innerHTML = `
    <option value="sub">Language: Sub</option>
    <option value="dub">Language: Dub</option>
  `;
  tools.insertBefore(node, seaProviderSelectEl.nextSibling);
  dubSelectEl = node;
  bindDubListener(dubSelectEl);
  return dubSelectEl;
}

function isDubSelectableProvider() {
  const providerValue = String(providerSelectEl?.value || selectedProvider || '').toLowerCase();
  const seaValue = String(seaProviderSelectEl?.value || selectedSeaProvider || '').toLowerCase();
  return (
    providerValue === 'hianime' ||
    providerValue === 'consumet-hianime' ||
    providerValue === 'consumet-animekai' ||
    providerValue === 'anicrush' ||
    providerValue === 'uniquestream' ||
    (providerValue === 'consumet' && (seaValue === 'hianime' || seaValue === 'animekai')) ||
    (providerValue === 'seanime' && (seaValue === 'hianime' || seaValue === 'anicrush'))
  );
}

function renderDubOption() {
  ensureDubSelectElement();
  if (!dubSelectEl) return;
  const show = isDubSelectableProvider();
  dubSelectEl.style.display = show ? '' : 'none';
  dubSelectEl.value = selectedDub ? 'dub' : 'sub';
}

function showToast(msg, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// --- Sidebar Logic ---
if (sidebarToggle) {
  sidebarToggle.addEventListener('click', () => {
    if (window.innerWidth <= 1100) {
      document.body.classList.toggle('mobile-menu-open');
      return;
    }
    document.body.classList.toggle('collapsed');
    localStorage.setItem('sidebarCollapsed', document.body.classList.contains('collapsed'));
  });
}
function syncSidebarMode() {
  if (window.innerWidth <= 1100) {
    // Ensure drawer navigation keeps text labels visible on small screens.
    document.body.classList.remove('collapsed');
    return;
  }
  if (localStorage.getItem('sidebarCollapsed') === 'true') {
    document.body.classList.add('collapsed');
  } else {
    document.body.classList.remove('collapsed');
  }
}
syncSidebarMode();
window.addEventListener('resize', syncSidebarMode);

document.addEventListener('click', (e) => {
  if (window.innerWidth > 1100) return;
  const clickInsideSidebar = document.querySelector('#sidebar')?.contains(e.target);
  const clickOnToggle = sidebarToggle?.contains(e.target);
  if (!clickInsideSidebar && !clickOnToggle) {
    document.body.classList.remove('mobile-menu-open');
  }
});

// --- Theater Mode ---
theaterBtn.addEventListener('click', () => {
  document.body.classList.toggle('theater-mode');
  showToast(document.body.classList.contains('theater-mode') ? 'Theater mode on' : 'Theater mode off');
});

// --- Navigation Logic ---
function updateEpisodeNavigation() {
  const currentIndex = episodeData.findIndex(ep => ep.number === selectedEpisode);
  prevEpBtn.disabled = currentIndex <= 0;
  nextEpBtn.disabled = currentIndex === -1 || currentIndex >= episodeData.length - 1;
}

nextEpBtn.addEventListener('click', () => {
  const currentIndex = episodeData.findIndex(ep => ep.number === selectedEpisode);
  if (currentIndex < episodeData.length - 1) {
    const next = episodeData[currentIndex + 1];
    changeEpisode(next.number);
  }
});

prevEpBtn.addEventListener('click', () => {
  const currentIndex = episodeData.findIndex(ep => ep.number === selectedEpisode);
  if (currentIndex > 0) {
    const prev = episodeData[currentIndex - 1];
    changeEpisode(prev.number);
  }
});

async function changeEpisode(num) {
  selectedEpisode = num;
  updateUrlParams({ episode: selectedEpisode });

  // UI Update
  document.querySelectorAll('.ep-btn-premium').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.num) === selectedEpisode);
  });

  updateEpisodeNavigation();
  await loadEpisodeSource();
  showToast(`Switched to Episode ${num}`);
}

// --- Core Logic ---
function updateUrlParams(nextValues = {}) {
  const next = new URLSearchParams(window.location.search);
  Object.entries(nextValues).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') {
      next.delete(key);
      return;
    }
    next.set(key, String(value));
  });
  const newUrl = `${window.location.pathname}?${next.toString()}`;
  window.history.replaceState({}, '', newUrl);
}

function withStreamApiBase(pathOrUrl) {
  const input = String(pathOrUrl || '').trim();
  if (!input) return input;
  if (/^https?:\/\//i.test(input)) return input;
  if (!streamApiBaseUrl) return input;
  if (input.startsWith('/')) return `${streamApiBaseUrl}${input}`;
  return `${streamApiBaseUrl}/${input}`;
}

function normalizeVideoSources(sources) {
  const list = Array.isArray(sources) ? sources.slice() : [];
  const subtitlePool = [];
  const seen = new Set();

  list.forEach((item) => {
    const subs = Array.isArray(item?.subtitles) ? item.subtitles : [];
    subs.forEach((sub) => {
      const key = `${String(sub?.url || '').trim()}|${String(sub?.language || '').trim()}`;
      if (!sub?.url || seen.has(key)) return;
      seen.add(key);
      subtitlePool.push(sub);
    });
  });

  if (!subtitlePool.length) return list;

  return list.map((item) => {
    const hasSubs = Array.isArray(item?.subtitles) && item.subtitles.length > 0;
    if (hasSubs || item?.type === 'embed') return item;
    return { ...item, subtitles: subtitlePool.slice() };
  });
}

function resetPlayerHost() {
  if (plyrInstance) {
    plyrInstance.destroy();
    plyrInstance = null;
  }
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  playerHostEl.innerHTML = '<video id="player" controls playsinline crossorigin="anonymous"></video>';
  return playerHostEl.querySelector('#player');
}

function getPlayerEl() {
  return document.querySelector('#player');
}

function clearInjectedSubtitles() {
  const playerEl = getPlayerEl();
  if (!playerEl) return;
  playerEl.querySelectorAll('track[data-anikai-sub="1"]').forEach((node) => node.remove());
}

function attachProviderSubtitles(playerEl, sourceItem) {
  if (!playerEl || !sourceItem) return 0;
  const subtitles = Array.isArray(sourceItem.subtitles) ? sourceItem.subtitles : [];
  if (!subtitles.length) return 0;

  clearInjectedSubtitles();
  let attached = 0;
  subtitles.forEach((sub, index) => {
    const subUrl = String(sub?.url || '').trim();
    if (!subUrl) return;
    // Keep subtitle tracks same-origin to avoid browser track-frame origin restrictions.
    const proxiedSubUrl = subUrl.startsWith('/api/subtitles/file')
      ? subUrl
      : `/api/subtitles/file?url=${encodeURIComponent(subUrl)}&format=${encodeURIComponent(String(sub?.format || ''))}`;
    const track = document.createElement('track');
    track.dataset.anikaiSub = '1';
    track.dataset.anikaiProviderSub = '1';
    track.kind = 'subtitles';
    track.label = String(sub?.language || `Subtitle ${index + 1}`);
    track.srclang = String(sub?.language || 'en').slice(0, 2).toLowerCase();
    track.src = proxiedSubUrl;
    track.default = Boolean(sub?.isDefault) || index === 0;
    playerEl.appendChild(track);
    attached += 1;
  });

  // Force a visible default track so keyboard caption toggle has something to control.
  for (let i = 0; i < playerEl.textTracks.length; i += 1) {
    const tr = playerEl.textTracks[i];
    tr.mode = tr.mode === 'showing' ? 'showing' : 'disabled';
  }
  const firstIndex = Array.from(playerEl.querySelectorAll('track[data-anikai-provider-sub="1"]')).findIndex((node) => node.default);
  const targetIndex = firstIndex >= 0 ? firstIndex : 0;
  if (playerEl.textTracks[targetIndex]) {
    playerEl.textTracks[targetIndex].mode = 'showing';
  }

  if (plyrInstance?.captions && typeof plyrInstance.captions.update === 'function') {
    try {
      plyrInstance.captions.update();
    } catch (_) { }
  }
  if (plyrInstance && typeof plyrInstance.currentTrack === 'number') {
    const activeIndex = Array.from(playerEl.querySelectorAll('track[data-anikai-provider-sub="1"]'))
      .findIndex((node) => node.default);
    plyrInstance.currentTrack = activeIndex >= 0 ? activeIndex : 0;
  }

  return attached;
}

function setupPlyr(playerEl) {
  if (!window.Plyr || !playerEl) return null;
  plyrInstance = new Plyr(playerEl, {
    controls: [
      'play-large',
      'rewind',
      'play',
      'fast-forward',
      'progress',
      'current-time',
      'duration',
      'mute',
      'volume',
      'captions',
      'settings',
      'pip',
      'fullscreen'
    ],
    settings: ['captions', 'quality', 'speed', 'loop'],
    seekTime: 10,
    captions: { active: true, update: true, language: 'auto' },
    keyboard: { focused: true, global: true }
  });
  return plyrInstance;
}

function shouldUseNativePlayerForProvider() {
  const providerValue = String(providerSelectEl?.value || selectedProvider || '').toLowerCase();
  return providerValue === 'hianime';
}

function setAudioSelectState(tracks = [], selectedIndex = -1) {
  if (!audioSelectEl) return;
  audioSelectEl.innerHTML = '';

  if (!Array.isArray(tracks) || tracks.length <= 1) {
    audioSelectEl.style.display = 'none';
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = 'Audio: Default';
    audioSelectEl.appendChild(fallback);
    return;
  }

  tracks.forEach((track, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    const label = String(track?.name || track?.lang || `Track ${index + 1}`).trim();
    option.textContent = `Audio: ${label}`;
    audioSelectEl.appendChild(option);
  });

  const safeSelected = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < tracks.length ? selectedIndex : 0;
  audioSelectEl.value = String(safeSelected);
  audioSelectEl.style.display = '';
}

function syncAudioTracks() {
  if (!hlsInstance) {
    setAudioSelectState([], -1);
    return;
  }
  const tracks = Array.isArray(hlsInstance.audioTracks) ? hlsInstance.audioTracks : [];
  const selected = Number(hlsInstance.audioTrack);
  setAudioSelectState(tracks, selected);
}

function applyPreferredAudioTrack() {
  if (!hlsInstance) return;
  const tracks = Array.isArray(hlsInstance.audioTracks) ? hlsInstance.audioTracks : [];
  if (!tracks.length) return;

  const wanted = selectedDub ? 'english' : 'japanese';
  const index = tracks.findIndex((track) => {
    const name = String(track?.name || '').toLowerCase();
    const lang = String(track?.lang || track?.language || '').toLowerCase();
    return name.includes(wanted) || lang.startsWith(selectedDub ? 'en' : 'ja') || lang === (selectedDub ? 'eng' : 'jpn');
  });
  if (index >= 0) {
    hlsInstance.audioTrack = index;
    if (audioSelectEl) audioSelectEl.value = String(index);
  }
}

function selectSource() {
  const byServer = selectedServer
    ? currentSources.filter((item) => item.server === selectedServer)
    : currentSources;
  const pool = byServer.length ? byServer : currentSources;
  if (!pool.length) return null;

  const exactQuality = pool.find((item) => item.quality === selectedQuality);
  if (exactQuality) return exactQuality;

  const autoQuality = pool.find((item) => item.quality === 'auto');
  if (autoQuality) return autoQuality;

  return pool[0];
}

function buildSourceOrder() {
  const byServer = selectedServer
    ? currentSources.filter((item) => item.server === selectedServer)
    : currentSources.slice();
  const fallbackPool = currentSources.filter((item) => item.server !== selectedServer);
  const primary = byServer.length ? byServer : currentSources.slice();
  if (!primary.length) return [];

  const rankNonEmbedPool = (pool) => {
    const nonEmbed = pool.filter((item) => item.type !== 'embed');
    const exact = nonEmbed.filter((item) => item.quality === selectedQuality);
    const auto = nonEmbed.filter((item) => item.quality === 'auto');
    const rest = nonEmbed.filter((item) => item.quality !== selectedQuality && item.quality !== 'auto');
    return [...exact, ...auto, ...rest];
  };

  const primaryNonEmbed = rankNonEmbedPool(primary);
  const fallbackNonEmbed = rankNonEmbedPool(fallbackPool);
  const allEmbed = [...primary, ...fallbackPool].filter((item) => item.type === 'embed');
  const ranked = [...primaryNonEmbed, ...fallbackNonEmbed, ...allEmbed];

  // De-duplicate by URL to avoid retry loops on identical entries.
  return ranked.filter((item, idx, arr) => arr.findIndex((x) => x.url === item.url) === idx);
}

function renderServerOptions() {
  const servers = [...new Set(currentSources.map((item) => item.server).filter(Boolean))];
  serverSelectEl.innerHTML = '';
  servers.forEach((server) => {
    const option = document.createElement('option');
    option.value = server;
    option.textContent = `Server: ${server}`;
    serverSelectEl.appendChild(option);
  });
  if (!servers.includes(selectedServer)) selectedServer = servers[0] || '';
  serverSelectEl.value = selectedServer;
}

function renderQualityOptions() {
  const pool = selectedServer ? currentSources.filter((item) => item.server === selectedServer) : currentSources;
  const qualities = [...new Set(pool.map((item) => item.quality).filter(Boolean))];
  qualitySelectEl.innerHTML = '';
  qualities.forEach((quality) => {
    const option = document.createElement('option');
    option.value = quality;
    option.textContent = `Quality: ${quality}`;
    qualitySelectEl.appendChild(option);
  });
  if (!qualities.includes(selectedQuality)) selectedQuality = qualities.includes('auto') ? 'auto' : (qualities[0] || '');
  qualitySelectEl.value = selectedQuality;
}

function tryNextSourceFallback() {
  if (!Array.isArray(currentSourceOrder) || currentSourceOrder.length === 0) return false;
  const nextIndex = sourceCursor + 1;
  if (nextIndex >= currentSourceOrder.length) return false;
  sourceCursor = nextIndex;
  const next = currentSourceOrder[sourceCursor];
  if (!next?.url) return false;
  showToast(`Trying fallback source (${next.server || 'next'})`, 'info');
  playSelectedSource(next);
  return true;
}

function playSelectedSource(sourceItem) {
  triggerAdsterra('play-intent');
  if (!sourceItem) {
    playerHostEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#666;font-weight:600;">No stream available for this episode</div>';
    showToast('No stream available for this episode', 'error');
    return;
  }

  if (sourceItem.type === 'youtube' || sourceItem.type === 'embed') {
    if (plyrInstance) {
      plyrInstance.destroy();
      plyrInstance = null;
    }
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    setAudioSelectState([], -1);

    const iframe = document.createElement('iframe');
    iframe.src = sourceItem.type === 'youtube'
      ? `https://www.youtube-nocookie.com/embed/${sourceItem.url}`
      : withStreamApiBase(sourceItem.url);
    iframe.allowFullscreen = true;
    playerHostEl.innerHTML = '';
    playerHostEl.appendChild(iframe);
    return;
  }

  const playerEl = resetPlayerHost();
  const useNativePlayer = shouldUseNativePlayerForProvider();
  if (!useNativePlayer) {
    setupPlyr(playerEl);
  }
  attachProviderSubtitles(playerEl, sourceItem);
  setAudioSelectState([], -1);

  playerEl.addEventListener('error', () => {
    if (tryNextSourceFallback()) return;
    const hint = isDubSelectableProvider()
      ? 'Stream blocked. Switch provider or toggle Sub/Dub.'
      : 'Stream failed. Please switch provider manually.';
    showToast(hint, 'error');
  }, { once: true });

  if (sourceItem.type === 'm3u8' || /\.m3u8($|\?)/i.test(sourceItem.url)) {
    if (window.Hls && Hls.isSupported()) {
      hlsInstance = new Hls({
        xhrSetup: (xhr) => {
          const headers = sourceItem.headers || {};
          Object.entries(headers).forEach(([key, value]) => {
            if (value) xhr.setRequestHeader(key, String(value));
          });
        }
      });
      hlsInstance.loadSource(withStreamApiBase(sourceItem.url));
      hlsInstance.attachMedia(playerEl);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        // Re-attach after HLS manifest setup; some browsers ignore early-added tracks.
        attachProviderSubtitles(playerEl, sourceItem);
        setTimeout(() => attachProviderSubtitles(playerEl, sourceItem), 250);
        syncAudioTracks();
        applyPreferredAudioTrack();
        if (plyrInstance) plyrInstance.play().catch(() => { });
        else playerEl.play().catch(() => { });
      });
      hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        syncAudioTracks();
        applyPreferredAudioTrack();
      });
      hlsInstance.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => syncAudioTracks());
      hlsInstance.on(Hls.Events.ERROR, (_, data) => {
        if (data?.fatal) {
          if (tryNextSourceFallback()) return;
          const hint = isDubSelectableProvider()
            ? 'HLS blocked. Switch provider or toggle Sub/Dub.'
            : 'HLS stream failed. Please switch provider manually.';
          showToast(hint, 'error');
        }
      });
      return;
    }
  }
  playerEl.src = withStreamApiBase(sourceItem.url);
  if (plyrInstance) {
    plyrInstance.play().catch(() => { });
  } else {
    playerEl.play().catch(() => { });
  }
}

function renderAndPlay() {
  renderServerOptions();
  renderQualityOptions();
  const order = buildSourceOrder();
  currentSourceOrder = order;
  const selected = selectSource() || order[0] || null;
  sourceCursor = Math.max(0, order.findIndex((item) => item?.url === selected?.url));
  playSelectedSource(selected);
}

function renderEpisodeList(episodes) {
  episodeListEl.innerHTML = '';
  epCountEl.textContent = `${episodes.length} Episodes`;
  episodes.forEach((episode) => {
    const item = document.createElement('div');
    item.className = `ep-btn-premium ${episode.number === selectedEpisode ? 'active' : ''}`;
    item.textContent = episode.number;
    item.dataset.num = episode.number;
    item.addEventListener('click', () => {
      triggerAdsterra('episode-switch');
      changeEpisode(episode.number);
    });
    episodeListEl.appendChild(item);
  });
}

async function loadEpisodeSource() {
  try {
    const response = await fetch(withStreamApiBase('/api/onlinestream/episode-source'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: Number(animeId),
        episodeNumber: selectedEpisode,
        source,
        provider: selectedProvider,
        server: selectedServer || undefined,
        seaProvider: selectedSeaProvider || undefined,
        dubbed: selectedDub
      })
    });
    const payload = await parseApiJson(response);
    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to load episode source');
    }
    currentSources = normalizeVideoSources(payload.videoSources || []);
    if (!currentSources.length) {
      throw new Error('No stream sources returned');
    }
    if (payload?.debug?.providerUsed) {
      showToast(`Sea source: ${payload.debug.providerUsed}`);
    }
    sourceCursor = 0;
    renderAndPlay();
  } catch (error) {
    console.error(error);
    const hint = isDubSelectableProvider()
      ? 'Source failed. Switch provider or toggle Sub/Dub.'
      : (error.message || 'Failed to load video stream. Switch provider manually.');
    showToast(hint, 'error');
  }
}

async function loadEpisodeList() {
  const cacheKey = buildEpisodesCacheKey();
  const cached = safeReadJsonStorage(cacheKey, window.sessionStorage);
  let renderedFromCache = false;

  if (isFreshCache(cached, WATCH_EPISODES_CACHE_TTL_MS) && Array.isArray(cached?.episodes) && cached.episodes.length > 0) {
    episodeData = cached.episodes;
    if (!episodeData.some((ep) => ep.number === selectedEpisode) && episodeData.length > 0) {
      selectedEpisode = episodeData[0].number;
      updateUrlParams({ episode: selectedEpisode });
    }
    renderEpisodeList(episodeData);
    updateEpisodeNavigation();
    renderedFromCache = true;
    loadEpisodeSource();
  }

  try {
    const response = await fetch(withStreamApiBase('/api/onlinestream/episode-list'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: Number(animeId),
        source,
        provider: selectedProvider,
        seaProvider: selectedSeaProvider || undefined,
        dubbed: selectedDub
      })
    });
    const payload = await parseApiJson(response);
    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to load episode list');
    }
    episodeData = payload.episodes || [];
    if (!episodeData.length) {
      throw new Error('No episodes returned for this anime/provider');
    }
    safeWriteJsonStorage(cacheKey, { ts: Date.now(), episodes: episodeData }, window.sessionStorage);
    renderEpisodeList(episodeData);

    if (!episodeData.some(ep => ep.number === selectedEpisode) && episodeData.length > 0) {
      selectedEpisode = episodeData[0].number;
      updateUrlParams({ episode: selectedEpisode });
    }

    updateEpisodeNavigation();
    await loadEpisodeSource();
  } catch (error) {
    console.error(error);
    if (!renderedFromCache) {
      episodeData = [];
      renderEpisodeList([]);
      showToast(error.message || 'Failed to load episode list', 'error');
    }
  }
}

async function loadSeaProviders() {
  // ── Consumet provider: show sub-provider picker (HiAnime / AnimeKai / AnimePahe) ──
  if (selectedProvider === 'consumet') {
    seaProviderSelectEl.style.display = '';
    const consumetSubProviders = [
      { id: 'hianime', name: 'Consumet: HiAnime (default, best subs)' },
      { id: 'animekai', name: 'Consumet: AnimeKai (dub support)' },
      { id: 'animepahe', name: 'Consumet: AnimePahe (good quality)' }
    ];
    seaProviderSelectEl.innerHTML = consumetSubProviders
      .map((item) => `<option value="${item.id}">${item.name}</option>`)
      .join('');

    const ids = consumetSubProviders.map((p) => p.id);
    if (!ids.includes(selectedSeaProvider)) {
      selectedSeaProvider = 'hianime'; // default
    }
    seaProviderSelectEl.value = selectedSeaProvider;
    updateUrlParams({ seaProvider: selectedSeaProvider });
    renderDubOption();
    return;
  }

  // ── Seanime provider: fetch available sea sources ──
  if (selectedProvider.startsWith('consumet-')) {
    seaProviderSelectEl.style.display = 'none';
    selectedSeaProvider = '';
    updateUrlParams({ seaProvider: null });
    renderDubOption();
    return;
  }
  if (selectedProvider !== 'seanime') {
    seaProviderSelectEl.style.display = 'none';
    renderDubOption();
    return;
  }

  seaProviderSelectEl.style.display = '';
  try {
    const res = await fetch(withStreamApiBase('/api/onlinestream/seanime/providers'));
    const providers = await parseApiJson(res);
    availableSeaProviders = (Array.isArray(providers) ? providers : []).filter((item) => {
      const id = String(item?.id || '').trim().toLowerCase();
      return id && !blockedProviderIds.has(id);
    });
  } catch (_) {
    availableSeaProviders = [];
  }

  const options = [
    { id: '', name: 'Sea source: Auto (fallback)' },
    ...availableSeaProviders.map((item) => ({
      id: String(item.id || '').toLowerCase(),
      name: `Sea source: ${item.name || item.id}`
    }))
  ];

  seaProviderSelectEl.innerHTML = options
    .map((item) => `<option value="${item.id}">${item.name}</option>`)
    .join('');

  const ids = options.map((item) => item.id);
  if (!ids.includes(selectedSeaProvider)) {
    selectedSeaProvider = '';
  }
  seaProviderSelectEl.value = selectedSeaProvider;
  updateUrlParams({ seaProvider: selectedSeaProvider || null });
  renderDubOption();
}

// --- Quick Search Logic ---
async function setupQuickSearch() {
  try {
    const res = await fetch(`/api/anime?source=${source}&page=1&perPage=80`);
    const payload = await parseApiJson(res);
    catalog = Array.isArray(payload) ? payload : [];
  } catch (_) {
    catalog = [];
  }

  searchInput.addEventListener('focus', () => {
    triggerAdsterra('search-focus');
    if (!searchInput.value.trim()) {
      renderRecentSearches();
    }
  });
  searchInput.addEventListener('click', () => triggerAdsterra('search-click'));

  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const first = searchResults.querySelector('.search-item');
    if (first?.href) {
      window.location.href = first.href;
    }
  });

  searchInput.addEventListener('input', async (e) => {
    const term = e.target.value.trim().toLowerCase();
    if (!term || term.length < 2) {
      renderRecentSearches();
      return;
    }

    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();

    try {
      const response = await fetch(
        `/api/anime?source=${source}&search=${encodeURIComponent(term)}&page=1&perPage=8`,
        { signal: searchAbortController.signal }
      );
      const fromApi = response.ok ? await response.json() : [];
      const localMatches = catalog.filter((item) => item.title.toLowerCase().includes(term)).slice(0, 8);
      const byId = new Map();
      [...(Array.isArray(fromApi) ? fromApi : []), ...localMatches].forEach((anime) => {
        if (anime?.id == null) return;
        byId.set(String(anime.id), anime);
      });
      renderSearchResults(Array.from(byId.values()).slice(0, 8));
    } catch (error) {
      if (error?.name === 'AbortError') return;
      const fallback = catalog.filter((item) => item.title.toLowerCase().includes(term)).slice(0, 8);
      renderSearchResults(fallback);
    }
  });
}

function renderSearchResults(items) {
  searchResults.innerHTML = '';
  items.forEach(anime => {
    const node = searchResultTemplate.content.cloneNode(true);
    const link = node.querySelector('.search-item');
    link.href = `/watch.html?id=${anime.id}&source=${source}`;
    link.addEventListener('click', () => pushRecentSearch(anime.title));
    const searchPoster = link.querySelector('.search-poster');
    searchPoster.src = anime.poster;
    searchPoster.alt = `${anime.title} poster`;
    link.querySelector('.search-title').textContent = anime.title;
    link.querySelector('.search-meta').textContent = `${anime.year || 'N/A'}`;
    searchResults.appendChild(node);
  });
  searchResults.classList.toggle('active', items.length > 0);
}

function renderRecentSearches() {
  const recent = getRecentSearches(6);
  if (!recent.length) {
    searchResults.classList.remove('active');
    return;
  }
  const resolved = recent
    .map((term) => catalog.find((anime) => anime.title.toLowerCase() === term.toLowerCase()) || null)
    .filter(Boolean)
    .slice(0, 6);
  if (resolved.length) {
    renderSearchResults(resolved);
    return;
  }
  searchResults.innerHTML = recent
    .map((term) => `<button class="search-recent-chip" type="button">${term}</button>`)
    .join('');
  searchResults.classList.add('active');
  searchResults.querySelectorAll('.search-recent-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      searchInput.value = chip.textContent || '';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

searchInput.addEventListener('blur', () => {
  setTimeout(() => searchResults.classList.remove('active'), 180);
});

// --- Helpers ---

async function parseApiJson(response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return { error: `Unexpected response (${response.status})` };
  }
}

function normalizeProviderList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.data) ? payload.data : []);

  return list
    .map((item) => ({
      id: String(item?.id || '').trim().toLowerCase(),
      name: String(item?.name || item?.id || '').trim()
    }))
    .filter((item) => item.id && !blockedProviderIds.has(item.id));
}

function isTypingContext(target) {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function seekBy(deltaSeconds) {
  const playerEl = getPlayerEl();
  if (!playerEl) return;
  const current = Number.isFinite(playerEl.currentTime) ? playerEl.currentTime : 0;
  const duration = Number.isFinite(playerEl.duration) ? playerEl.duration : Number.POSITIVE_INFINITY;
  const next = Math.max(0, Math.min(duration, current + deltaSeconds));
  playerEl.currentTime = next;
}

function toggleCaptionsShortcut() {
  const playerEl = getPlayerEl();
  if (!playerEl || !playerEl.textTracks || playerEl.textTracks.length === 0) {
    showToast('No captions available', 'error');
    return;
  }

  if (plyrInstance && typeof plyrInstance.currentTrack === 'number') {
    const next = plyrInstance.currentTrack === -1 ? 0 : -1;
    plyrInstance.currentTrack = next;
    showToast(next === -1 ? 'Captions off' : 'Captions on');
    return;
  }

  const first = playerEl.textTracks[0];
  const on = first.mode !== 'showing';
  for (let i = 0; i < playerEl.textTracks.length; i += 1) {
    playerEl.textTracks[i].mode = 'disabled';
  }
  first.mode = on ? 'showing' : 'disabled';
  showToast(on ? 'Captions on' : 'Captions off');
}

async function init() {
  try {
    if (!animeId || Number.isNaN(Number(animeId))) {
      titleEl.textContent = 'Invalid title';
      descEl.textContent = 'Missing or invalid anime id in URL.';
      showToast('Invalid anime id in URL', 'error');
      return;
    }

    ensureDubSelectElement();
    try {
      const configRes = await fetch('/api/client-config');
      const configPayload = await parseApiJson(configRes);
      const cfgBase = String(configPayload?.streamApiBaseUrl || '').trim().replace(/\/+$/, '');
      streamApiBaseUrl = cfgBase;
    } catch (_) {
      streamApiBaseUrl = '';
    }
    if (!window.Plyr) {
      showToast('Advanced player library failed to load. Check network filters.', 'error');
    }
    const animeCacheKey = buildAnimeCacheKey();
    const cachedAnimeEntry = safeReadJsonStorage(animeCacheKey, window.sessionStorage);
    if (isFreshCache(cachedAnimeEntry, WATCH_ANIME_CACHE_TTL_MS)) {
      const normalizedCached = normalizeAnime(cachedAnimeEntry.data);
      if (normalizedCached) {
        renderAnimeDetails(normalizedCached);
      }
    }

    const response = await fetch(`/api/anime/${animeId}?source=${source}`);
    const animePayload = await parseApiJson(response);
    if (!response.ok) {
      throw new Error(animePayload?.error || `Failed to load anime (${response.status})`);
    }
    const anime = normalizeAnime(animePayload);
    if (!anime) {
      throw new Error('Anime payload was empty');
    }
    renderAnimeDetails(anime);
    safeWriteJsonStorage(animeCacheKey, { ts: Date.now(), data: anime }, window.sessionStorage);

    // Fetch providers (with robust fallback so UI stays usable).
    let providers = [];
    try {
      const pRes = await fetch(withStreamApiBase('/api/onlinestream/providers'));
      const payload = await parseApiJson(pRes);
      if (!pRes.ok) {
        throw new Error(payload?.error || `Provider API failed (${pRes.status})`);
      }
      providers = normalizeProviderList(payload);
    } catch (providerError) {
      console.error(providerError);
      showToast('Provider API failed, using local fallback list.', 'error');
    }

    const merged = new Map(defaultProviderOptions.map((p) => [p.id, { ...p }]));
    providers.forEach((provider) => {
      merged.set(provider.id, provider);
    });
    providers = Array.from(merged.values());

    providerSelectEl.innerHTML = providers.map((p) => `<option value="${p.id}">Provider: ${p.name}</option>`).join('');
    const providerIds = providers.map((p) => p.id);
    availableProviderIds = providerIds.slice();

    // Backward compatibility:
    // If URL has provider=seanime with seaProvider equal to a first-class provider id
    // (e.g. hianime), switch to the direct provider automatically.
    if (
      selectedProvider === 'seanime' &&
      selectedSeaProvider &&
      selectedSeaProvider !== 'seanime' &&
      providerIds.includes(selectedSeaProvider)
    ) {
      selectedProvider = selectedSeaProvider;
      selectedSeaProvider = '';
      updateUrlParams({ provider: selectedProvider, seaProvider: null });
    }

    if (selectedProvider === 'consumet' && selectedSeaProvider) {
      const consumetMap = {
        hianime: 'consumet-hianime',
        animekai: 'consumet-animekai',
        animepahe: 'consumet-animepahe'
      };
      const mappedProvider = consumetMap[selectedSeaProvider];
      if (mappedProvider && providerIds.includes(mappedProvider)) {
        selectedProvider = mappedProvider;
        selectedSeaProvider = '';
        updateUrlParams({ provider: selectedProvider, seaProvider: null });
      }
    }

    if (!providerIds.includes(selectedProvider)) {
      selectedProvider = providerIds.includes('seanime') ? 'seanime' : (providerIds[0] || 'seanime');
    }
    providerSelectEl.value = selectedProvider;
    updateUrlParams({ provider: selectedProvider });
    savePlayerPrefs({ provider: selectedProvider });
    renderDubOption();

    await loadSeaProviders();
    renderDubOption();
    updateUrlParams({ dubbed: selectedDub ? '1' : null });
    savePlayerPrefs({
      seaProvider: selectedSeaProvider || '',
      dubbed: selectedDub,
      server: selectedServer || '',
      quality: selectedQuality || 'auto'
    });
    await loadEpisodeList();
    setupQuickSearch();
  } catch (error) {
    console.error(error);
  }
}

providerSelectEl.addEventListener('change', async () => {
  selectedProvider = providerSelectEl.value;
  savePlayerPrefs({ provider: selectedProvider });
  const keepSeaProvider = (selectedProvider === 'seanime' || selectedProvider === 'consumet') ? selectedSeaProvider : null;
  updateUrlParams({ provider: selectedProvider, seaProvider: keepSeaProvider || null });
  await loadSeaProviders();
  renderDubOption();
  await loadEpisodeList();
});

seaProviderSelectEl.addEventListener('change', async () => {
  selectedSeaProvider = seaProviderSelectEl.value;
  savePlayerPrefs({ seaProvider: selectedSeaProvider || '' });
  updateUrlParams({ seaProvider: selectedSeaProvider || null });
  renderDubOption();
  await loadEpisodeList();
});

serverSelectEl.addEventListener('change', () => {
  selectedServer = serverSelectEl.value;
  savePlayerPrefs({ server: selectedServer || '' });
  renderAndPlay();
});

qualitySelectEl.addEventListener('change', () => {
  selectedQuality = qualitySelectEl.value;
  savePlayerPrefs({ quality: selectedQuality || 'auto' });
  renderAndPlay();
});

audioSelectEl?.addEventListener('change', () => {
  if (!hlsInstance) return;
  const next = Number(audioSelectEl.value);
  if (!Number.isInteger(next) || next < 0) return;
  hlsInstance.audioTrack = next;
});

document.addEventListener('keydown', (event) => {
  if (isTypingContext(event.target)) return;
  const key = String(event.key || '').toLowerCase();
  if (key === 'arrowleft') { event.preventDefault(); seekBy(-5); return; }
  if (key === 'arrowright') { event.preventDefault(); seekBy(5); return; }
  if (key === 'j') { event.preventDefault(); seekBy(-10); return; }
  if (key === 'l') { event.preventDefault(); seekBy(10); return; }
  if (key === 'c') { event.preventDefault(); toggleCaptionsShortcut(); return; }
  if (key === 'f') { event.preventDefault(); toggleFullscreen(); return; }
  if (key === 'm') { event.preventDefault(); toggleMute(); return; }
  if (key === 'n') { event.preventDefault(); goNextEpisode(); return; }
  if (key === 's') { event.preventDefault(); skipIntro(); return; }
  if (key === 'o') { event.preventDefault(); skipOutro(); return; }
  if (key === '?') { event.preventDefault(); window.AnikaiFeatures?.toggleShortcutsPanel(); }
});

// ── Toggle Fullscreen ───────────────────────────────────────
function toggleFullscreen() {
  if (plyrInstance) { plyrInstance.fullscreen.toggle(); return; }
  const el = playerHostEl;
  if (!document.fullscreenElement) {
    el?.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

// ── Toggle Mute ──────────────────────────────────────────
function toggleMute() {
  if (plyrInstance) { plyrInstance.muted = !plyrInstance.muted; return; }
  const v = getPlayerEl();
  if (v) v.muted = !v.muted;
}

// ── Next Episode shortcut ──────────────────────────────
function goNextEpisode() {
  const idx = episodeData.findIndex(ep => ep.number === selectedEpisode);
  if (idx >= 0 && idx < episodeData.length - 1) {
    changeEpisode(episodeData[idx + 1].number);
  }
}

// ── Skip Intro (+85s) ─────────────────────────────────
function skipIntro() {
  seekBy(85);
  showToast('Intro skipped (+85s)');
}

function skipOutro() {
  const v = getPlayerEl();
  if (!v || !Number.isFinite(v.duration) || v.duration <= 0) {
    showToast('Outro skip is unavailable right now', 'error');
    return;
  }
  const target = Math.max(0, v.duration - 8);
  v.currentTime = target;
  showToast('Skipped to outro end');
}

// ── Skip Intro Button in player ─────────────────────────
function injectSkipIntroBtn() {
  if (document.getElementById('skipIntroBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'skipIntroBtn';
  btn.className = 'skip-intro-btn';
  btn.textContent = '▶ Skip Intro';
  btn.addEventListener('click', skipIntro);
  playerHostEl.style.position = 'relative';
  playerHostEl.appendChild(btn);

  // Show skip button for first 120s of each episode
  let skipTimer = null;
  function scheduleSkipBtn() {
    btn.classList.remove('show');
    clearTimeout(skipTimer);
    const v = getPlayerEl();
    if (!v) return;
    const onTime = () => {
      if (v.currentTime > 0 && v.currentTime < 120) {
        btn.classList.add('show');
      } else {
        btn.classList.remove('show');
      }
    };
    v.addEventListener('timeupdate', onTime);
  }
  // Re-schedule on episode change
  document.addEventListener('anikai:episodeChanged', scheduleSkipBtn);
  scheduleSkipBtn();
}

function injectSkipOutroBtn() {
  if (document.getElementById('skipOutroBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'skipOutroBtn';
  btn.className = 'skip-intro-btn';
  btn.textContent = 'Skip Outro';
  btn.style.right = '1rem';
  btn.style.bottom = '1rem';
  btn.addEventListener('click', skipOutro);
  playerHostEl.style.position = 'relative';
  playerHostEl.appendChild(btn);

  function scheduleOutroBtn() {
    btn.classList.remove('show');
    const v = getPlayerEl();
    if (!v) return;
    const onTime = () => {
      if (!Number.isFinite(v.duration) || v.duration <= 0) return;
      const nearEnd = v.currentTime >= Math.max(0, v.duration - 120) && v.currentTime < v.duration - 2;
      btn.classList.toggle('show', nearEnd);
    };
    v.addEventListener('timeupdate', onTime);
  }

  document.addEventListener('anikai:episodeChanged', scheduleOutroBtn);
  scheduleOutroBtn();
}

// ── Auto-Play Next Episode ────────────────────────────
let autoPlayEnabled = (localStorage.getItem('anikai_autoplay') !== 'false');
let autoNextTimer = null;

function createAutoNextBanner() {
  if (document.getElementById('autoNextBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'autoNextBanner';
  banner.className = 'autonext-banner';
  banner.innerHTML = `
    <div class="autonext-banner-row">
      <div class="autonext-banner-text">
        <strong>Next Episode Starts In <span id="autoNextCount">5</span>s</strong>
        <small>Up next in queue</small>
        <div class="autonext-progress"><div class="autonext-progress-fill" id="autoNextBar"></div></div>
      </div>
    </div>
    <div class="autonext-actions">
      <button class="autonext-btn" id="autoNextNow">Play Now</button>
      <button class="autonext-cancel-btn" id="autoNextCancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(banner);
  document.getElementById('autoNextNow').addEventListener('click', () => {
    clearAutoNext();
    goNextEpisode();
  });
  document.getElementById('autoNextCancel').addEventListener('click', clearAutoNext);
}

function showAutoNextBanner() {
  const idx = episodeData.findIndex(ep => ep.number === selectedEpisode);
  if (idx < 0 || idx >= episodeData.length - 1) return; // no next ep
  if (!autoPlayEnabled) return;
  createAutoNextBanner();
  const banner = document.getElementById('autoNextBanner');
  const countEl = document.getElementById('autoNextCount');
  const barEl = document.getElementById('autoNextBar');
  banner.classList.add('show');
  let count = 5;
  countEl.textContent = count;
  barEl.style.transition = 'none';
  barEl.style.width = '0%';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      barEl.style.transition = 'width 5s linear';
      barEl.style.width = '100%';
    });
  });
  autoNextTimer = setInterval(() => {
    count -= 1;
    countEl.textContent = count;
    if (count <= 0) {
      clearAutoNext();
      goNextEpisode();
    }
  }, 1000);
}

function clearAutoNext() {
  clearInterval(autoNextTimer);
  autoNextTimer = null;
  const banner = document.getElementById('autoNextBanner');
  if (banner) banner.classList.remove('show');
}

// Hook into video 'ended' to trigger auto-next
function watchForVideoEnd() {
  const v = getPlayerEl();
  if (!v) return;
  v.addEventListener('ended', () => {
    showAutoNextBanner();
  }, { once: true });
}

// ── Watch Position Save / Restore ──────────────────────
function saveWatchPosition() {
  const v = getPlayerEl();
  const F = window.AnikaiFeatures;
  if (!v || !F || !animeId || !v.currentTime || !v.duration) return;
  F.WatchProgress.save(animeId, selectedEpisode, v.currentTime, v.duration);
  const user = firebaseClient?.getCurrentUser?.();
  if (firebaseClient?.ready && firebaseClient.firestoreEnabled && user?.uid) {
    firebaseClient.saveWatchProgress(user.uid, animeId, {
      episode: selectedEpisode,
      currentTime: v.currentTime,
      duration: v.duration,
      pct: v.duration ? (v.currentTime / v.duration) : 0,
      ts: Date.now()
    }).catch((error) => {
      console.error('Watch progress sync failed', error);
    });
  }
}

function restoreWatchPosition() {
  const v = getPlayerEl();
  const F = window.AnikaiFeatures;
  if (!v || !F || !animeId) return;
  const progress = F.WatchProgress.get(animeId, selectedEpisode);
  if (!progress || progress.pct < 0.02 || progress.pct > 0.95) return;
  const resume = () => {
    v.currentTime = progress.currentTime;
    const pct = Math.round(progress.pct * 100);
    showToast(`Resumed from ${Math.floor(progress.currentTime / 60)}m ${Math.round(progress.currentTime % 60)}s (${pct}%)`);
    v.removeEventListener('loadedmetadata', resume);
  };
  v.addEventListener('loadedmetadata', resume);
}

// Autosave position every 5s
setInterval(saveWatchPosition, 5000);

// ── Inject AutoPlay Toggle in Controls Bar ──────────────
function injectWatchExtras() {
  const controlsBar = document.querySelector('.player-controls-bar');
  if (!controlsBar || document.getElementById('watchExtrasInjected')) return;
  controlsBar.setAttribute('id', 'watchExtrasInjected');

  // Auto-play toggle
  const extraGroup = document.createElement('div');
  extraGroup.className = 'action-group control-extra-group';

  const track = document.createElement('div');
  track.className = `toggle-track ${autoPlayEnabled ? 'on' : ''}`;
  track.innerHTML = '<div class="toggle-thumb"></div>';
  track.addEventListener('click', () => {
    autoPlayEnabled = !autoPlayEnabled;
    track.classList.toggle('on', autoPlayEnabled);
    localStorage.setItem('anikai_autoplay', autoPlayEnabled ? 'true' : 'false');
    showToast(`Auto-play ${autoPlayEnabled ? 'enabled' : 'disabled'}`);
  });

  const autoLabel = document.createElement('label');
  autoLabel.className = 'autoplay-label';
  autoLabel.appendChild(track);
  autoLabel.append(' Auto-Play');

  // Share button
  const shareBtn = document.createElement('button');
  shareBtn.className = 'share-watch-btn btn-action';
  shareBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Share`;
  shareBtn.addEventListener('click', () => {
    const F = window.AnikaiFeatures;
    if (F) F.copyToClipboard(window.location.href, 'Episode link copied!');
    else { navigator.clipboard?.writeText(window.location.href); showToast('Link copied!'); }
  });

  extraGroup.appendChild(autoLabel);
  extraGroup.appendChild(shareBtn);
  controlsBar.appendChild(extraGroup);
}

// ── Inject Rating Row for the anime ────────────────────
function injectWatchRatingRow(animeData) {
  if (document.getElementById('watchRatingRow')) return;
  const F = window.AnikaiFeatures;
  if (!F || !animeId) return;

  const detailsEl = document.querySelector('.anime-details-premium');
  if (!detailsEl) return;

  const ratingLabels = ['', 'Terrible', 'Bad', 'Meh', 'Fine', 'OK', 'Good', 'Great', 'Amazing', 'Excellent', 'Masterpiece'];
  const row = document.createElement('div');
  row.id = 'watchRatingRow';
  row.className = 'watch-rating-row';

  const label = document.createElement('span');
  label.className = 'watch-rating-label';
  label.textContent = 'Rate this anime:';

  const stars = document.createElement('div');
  stars.className = 'star-row';

  const ratingLabel = document.createElement('span');
  ratingLabel.className = 'watch-rating-current';
  const cur = F.Ratings.get(animeId);
  ratingLabel.textContent = cur ? ratingLabels[cur] : '';

  function buildStars(current) {
    stars.innerHTML = '';
    for (let i = 1; i <= 10; i++) {
      const btn = document.createElement('button');
      btn.className = `star-btn ${i <= current ? 'active' : ''}`;
      btn.title = ratingLabels[i];
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="${i <= current ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
      btn.addEventListener('click', () => {
        F.Ratings.set(animeId, i);
        ratingLabel.textContent = ratingLabels[i];
        buildStars(i);
        showToast(`Rated ${i}/10 — ${ratingLabels[i]}`, 'success');
      });
      btn.addEventListener('mouseenter', () => buildStars(i));
      btn.addEventListener('mouseleave', () => buildStars(F.Ratings.get(animeId) || 0));
      stars.appendChild(btn);
    }
  }
  buildStars(cur);

  row.appendChild(label);
  row.appendChild(stars);
  row.appendChild(ratingLabel);
  detailsEl.after(row);
}

// ── Patch init to wire all watch features ────────────────
const _origChangeEpisode = changeEpisode;
changeEpisode = async function (num) {
  clearAutoNext();
  saveWatchPosition();
  await _origChangeEpisode(num);
  // After episode loads, restore position & hook auto-next
  setTimeout(() => {
    restoreWatchPosition();
    watchForVideoEnd();
    injectSkipIntroBtn();
    injectSkipOutroBtn();
    document.dispatchEvent(new CustomEvent('anikai:episodeChanged', { detail: { num } }));
  }, 800);
};

// Patch init to also inject UI elements after load
const _origInit = init;
async function initWithFeatures() {
  await _origInit();
  setTimeout(() => {
    injectWatchExtras();
    injectSkipIntroBtn();
    injectSkipOutroBtn();
    watchForVideoEnd();
    restoreWatchPosition();
    window.AnikaiFeatures?.injectTopBarExtras?.();
  }, 600);
  // Inject rating row once anime data is in DOM
  setTimeout(() => {
    injectWatchRatingRow();
  }, 2000);
}

initWithFeatures();
