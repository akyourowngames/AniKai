const params = new URLSearchParams(window.location.search);
const animeId = params.get('id');
const sourceParam = params.get('source');
const source = sourceParam === 'mal' ? 'mal' : 'anilist';

const titleEl = document.querySelector('#animeTitle');
const metaEl = document.querySelector('#animeMeta');
const descEl = document.querySelector('#animeDesc');
const posterEl = document.querySelector('#animePoster');
const playerHostEl = document.querySelector('#playerHost');
const providerSelectEl = document.querySelector('#providerSelect');
const seaProviderSelectEl = document.querySelector('#seaProviderSelect');
const serverSelectEl = document.querySelector('#serverSelect');
const qualitySelectEl = document.querySelector('#qualitySelect');
const audioSelectEl = document.querySelector('#audioSelect');
const subtitleLanguageEl = document.querySelector('#subtitleLanguage');
const subtitleFormatEl = document.querySelector('#subtitleFormat');
const subtitleHiEl = document.querySelector('#subtitleHi');
const subtitleSearchBtn = document.querySelector('#subtitleSearchBtn');
const subtitleListEl = document.querySelector('#subtitleList');
const episodeListEl = document.querySelector('#episodeList');
const epCountEl = document.querySelector('#epCount');
const nextEpBtn = document.querySelector('#nextEpBtn');
const prevEpBtn = document.querySelector('#prevEpBtn');
const theaterBtn = document.querySelector('#theaterBtn');
const subtitlePanelToggleBtn = document.querySelector('#subtitlePanelToggle');
const subtitlePanelEl = document.querySelector('#subtitlePanel');
const sidebarToggle = document.querySelector('#sidebarToggle');

// Search refs
const searchInput = document.querySelector('#searchInput');
const searchResults = document.querySelector('#searchResults');
const searchResultTemplate = document.querySelector('#searchResultTemplate');

let hlsInstance = null;
let plyrInstance = null;
let selectedEpisode = Number(params.get('episode')) || 1;
let selectedProvider = (params.get('provider') || 'seanime').toLowerCase();
let selectedSeaProvider = (params.get('seaProvider') || '').toLowerCase();
let availableSeaProviders = [];
let selectedServer = params.get('server') || '';
let selectedQuality = params.get('quality') || 'auto';
let currentSources = [];
let sourceCursor = 0;
let episodeData = [];
let catalog = []; // For quick search
let subtitleResults = [];
let availableProviderIds = [];

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
if (localStorage.getItem('sidebarCollapsed') === 'true') {
  document.body.classList.add('collapsed');
}

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

subtitlePanelToggleBtn?.addEventListener('click', () => {
  subtitlePanelEl?.classList.toggle('open');
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
  await searchSubtitles();
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

function resetPlayerHost() {
  if (plyrInstance) {
    plyrInstance.destroy();
    plyrInstance = null;
  }
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  playerHostEl.innerHTML = '<video id="player" controls playsinline></video>';
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

  const rankPool = (pool) => {
    const exact = pool.filter((item) => item.quality === selectedQuality);
    const auto = pool.filter((item) => item.quality === 'auto');
    const rest = pool.filter((item) => item.quality !== selectedQuality && item.quality !== 'auto');
    return [...exact, ...auto, ...rest];
  };

  const ranked = [...rankPool(primary), ...rankPool(fallbackPool)];

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

function playSelectedSource(sourceItem) {
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
    iframe.src = sourceItem.type === 'youtube' ? `https://www.youtube-nocookie.com/embed/${sourceItem.url}` : sourceItem.url;
    iframe.allowFullscreen = true;
    playerHostEl.innerHTML = '';
    playerHostEl.appendChild(iframe);
    return;
  }

  const playerEl = resetPlayerHost();
  setupPlyr(playerEl);
  clearInjectedSubtitles();
  setAudioSelectState([], -1);

  playerEl.addEventListener('error', () => {
    if (!tryNextSource('Stream')) {
      showToast('Stream failed. Please select another source manually.', 'error');
    }
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
      hlsInstance.loadSource(sourceItem.url);
      hlsInstance.attachMedia(playerEl);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        syncAudioTracks();
        if (plyrInstance) plyrInstance.play().catch(() => {});
        else playerEl.play().catch(() => {});
      });
      hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => syncAudioTracks());
      hlsInstance.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => syncAudioTracks());
      hlsInstance.on(Hls.Events.ERROR, (_, data) => {
        if (data?.fatal) {
          if (!tryNextSource('HLS stream')) {
            showToast('HLS stream failed. Please select another source manually.', 'error');
          }
        }
      });
      return;
    }
  }
  playerEl.src = sourceItem.url;
  if (plyrInstance) {
    plyrInstance.play().catch(() => {});
  } else {
    playerEl.play().catch(() => {});
  }
}

function renderSubtitleResults() {
  if (!subtitleListEl) return;
  if (!subtitleResults.length) {
    subtitleListEl.innerHTML = '<div style="color: var(--text-dim); font-size: 12px;">No subtitles found for this episode.</div>';
    return;
  }

  subtitleListEl.innerHTML = '';
  subtitleResults.forEach((sub, index) => {
    const item = document.createElement('div');
    item.className = 'subtitle-item';
    const language = String(sub.display || sub.language || 'Unknown');
    const format = String(sub.format || '').toUpperCase();
    item.innerHTML = `
      <div>
        <div>${language}${sub.isHearingImpaired ? ' [CC]' : ''}</div>
        <small>${format || 'UNK'} - ${sub.source || 'subtitle'}</small>
      </div>
      <button type="button" data-sub-index="${index}">Use</button>
    `;
    subtitleListEl.appendChild(item);
  });
}

async function attachSubtitle(index) {
  const sub = subtitleResults[index];
  if (!sub) return;
  const playerEl = getPlayerEl();
  if (!playerEl || playerEl.tagName !== 'VIDEO') {
    showToast('Subtitle works only on direct video streams', 'error');
    return;
  }

  try {
    const proxyUrl = `/api/subtitles/file?url=${encodeURIComponent(sub.url)}&format=${encodeURIComponent(sub.format || '')}`;
    clearInjectedSubtitles();
    const track = document.createElement('track');
    track.dataset.anikaiSub = '1';
    track.kind = 'subtitles';
    track.label = `${sub.display || sub.language || 'Subtitle'} ${sub.format ? `[${String(sub.format).toUpperCase()}]` : ''}`.trim();
    track.srclang = String(sub.language || 'en').toLowerCase();
    track.src = proxyUrl;
    track.default = true;
    track.addEventListener('load', () => {
      if (track.track) track.track.mode = 'showing';
      if (plyrInstance) {
        plyrInstance.currentTrack = Array.from(playerEl.textTracks).findIndex((item) => item === track.track);
      }
    });
    playerEl.appendChild(track);
    showToast(`Subtitle loaded: ${sub.display || sub.language || 'Unknown'}`);
  } catch (error) {
    console.error(error);
    showToast('Failed to attach subtitle', 'error');
  }
}

async function searchSubtitles() {
  if (!animeId || !subtitleListEl || !subtitleSearchBtn) return;
  subtitleSearchBtn.disabled = true;
  subtitleListEl.innerHTML = '<div style="color: var(--text-dim); font-size: 12px;">Searching subtitles...</div>';

  try {
    const response = await fetch('/api/subtitles/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: Number(animeId),
        source,
        episodeNumber: selectedEpisode,
        seasonNumber: 1,
        language: subtitleLanguageEl?.value || 'all',
        format: subtitleFormatEl?.value || 'all',
        hi: Boolean(subtitleHiEl?.checked)
      })
    });
    const payload = await parseApiJson(response);
    if (!response.ok) throw new Error(payload?.error || 'Subtitle search failed');
    subtitleResults = Array.isArray(payload?.results) ? payload.results : [];
    renderSubtitleResults();
  } catch (error) {
    console.error(error);
    subtitleResults = [];
    subtitleListEl.innerHTML = '<div style="color: #d66; font-size: 12px;">Subtitle search failed.</div>';
    showToast(error.message || 'Subtitle search failed', 'error');
  } finally {
    subtitleSearchBtn.disabled = false;
  }
}

function renderAndPlay() {
  renderServerOptions();
  renderQualityOptions();
  const order = buildSourceOrder();
  const selected = selectSource() || order[0] || null;
  sourceCursor = Math.max(0, order.findIndex((item) => item?.url === selected?.url));
  playSelectedSource(selected);
}

function playSourceAt(index) {
  const order = buildSourceOrder();
  if (!order.length) return false;
  if (index < 0 || index >= order.length) return false;
  sourceCursor = index;
  playSelectedSource(order[index]);
  return true;
}

function tryNextSource(reason = 'Stream') {
  const ok = playSourceAt(sourceCursor + 1);
  if (ok) {
    showToast(`${reason} failed, trying another source...`, 'error');
  }
  return ok;
}

function renderEpisodeList(episodes) {
  episodeListEl.innerHTML = '';
  epCountEl.textContent = `${episodes.length} Episodes`;
  episodes.forEach((episode) => {
    const item = document.createElement('div');
    item.className = `ep-btn-premium ${episode.number === selectedEpisode ? 'active' : ''}`;
    item.textContent = episode.number;
    item.dataset.num = episode.number;
    item.addEventListener('click', () => changeEpisode(episode.number));
    episodeListEl.appendChild(item);
  });
}

async function loadEpisodeSource() {
  const fetchSource = async (providerId, seaProviderId) => {
    const response = await fetch('/api/onlinestream/episode-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: Number(animeId),
        episodeNumber: selectedEpisode,
        source,
        provider: providerId,
        server: selectedServer || undefined,
        seaProvider: seaProviderId || undefined
      })
    });
    const payload = await parseApiJson(response);
    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to load episode source');
    }
    if (!Array.isArray(payload?.videoSources) || !payload.videoSources.length) {
      throw new Error('No stream sources returned');
    }
    return payload;
  };

  try {
    const payload = await fetchSource(selectedProvider, selectedSeaProvider);
    currentSources = payload.videoSources || [];
    if (payload?.debug?.providerUsed) {
      showToast(`Sea source: ${payload.debug.providerUsed}`);
    }
    sourceCursor = 0;
    renderAndPlay();
  } catch (error) {
    const fallbackAttempts = [];

    if (selectedProvider === 'seanime' && selectedSeaProvider) {
      fallbackAttempts.push({ providerId: 'seanime', seaProviderId: '' });
    }

    availableProviderIds
      .filter((id) => id !== selectedProvider)
      .forEach((id) => fallbackAttempts.push({ providerId: id, seaProviderId: '' }));

    for (const attempt of fallbackAttempts) {
      try {
        const payload = await fetchSource(attempt.providerId, attempt.seaProviderId);
        selectedProvider = attempt.providerId;
        selectedSeaProvider = attempt.seaProviderId || '';
        providerSelectEl.value = selectedProvider;
        await loadSeaProviders();
        updateUrlParams({
          provider: selectedProvider,
          seaProvider: selectedProvider === 'seanime' ? (selectedSeaProvider || null) : null
        });
        currentSources = payload.videoSources || [];
        sourceCursor = 0;
        renderAndPlay();
        showToast(`Switched to provider: ${selectedProvider}`);
        return;
      } catch (_) {}
    }

    console.error(error);
    showToast(error.message || 'Failed to load video stream', 'error');
  }
}

async function loadEpisodeList() {
  try {
    const response = await fetch('/api/onlinestream/episode-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: Number(animeId),
        source,
        provider: selectedProvider,
        seaProvider: selectedSeaProvider || undefined
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
    renderEpisodeList(episodeData);
    
    if (!episodeData.some(ep => ep.number === selectedEpisode) && episodeData.length > 0) {
        selectedEpisode = episodeData[0].number;
    }
    
    updateEpisodeNavigation();
    await loadEpisodeSource();
  } catch (error) {
    console.error(error);
    episodeData = [];
    renderEpisodeList([]);
    showToast(error.message || 'Failed to load episode list', 'error');
  }
}

async function loadSeaProviders() {
  if (selectedProvider !== 'seanime') {
    seaProviderSelectEl.style.display = 'none';
    return;
  }

  seaProviderSelectEl.style.display = '';
  try {
    const res = await fetch('/api/onlinestream/seanime/providers');
    const providers = await parseApiJson(res);
    availableSeaProviders = Array.isArray(providers) ? providers : [];
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
}

// --- Quick Search Logic ---
async function setupQuickSearch() {
  const res = await fetch(`/api/anime?source=${source}`);
  const payload = await parseApiJson(res);
  catalog = Array.isArray(payload) ? payload : [];
  
  searchInput.addEventListener('input', (e) => {
    const term = e.target.value.trim().toLowerCase();
    if (!term) {
      searchResults.classList.remove('active');
      return;
    }
    const filtered = catalog.filter(a => a.title.toLowerCase().includes(term)).slice(0, 5);
    renderSearchResults(filtered);
  });
}

function renderSearchResults(items) {
  searchResults.innerHTML = '';
  items.forEach(anime => {
    const node = searchResultTemplate.content.cloneNode(true);
    const link = node.querySelector('.search-item');
    link.href = `/watch.html?id=${anime.id}&source=${source}`;
    link.querySelector('.search-poster').src = anime.poster;
    link.querySelector('.search-title').textContent = anime.title;
    link.querySelector('.search-meta').textContent = `${anime.year || 'N/A'}`;
    searchResults.appendChild(node);
  });
  searchResults.classList.toggle('active', items.length > 0);
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
    if (!window.Plyr) {
      showToast('Advanced player library failed to load. Check network filters.', 'error');
    }
    if (subtitlePanelEl && window.innerWidth > 820) {
      subtitlePanelEl.classList.add('open');
    }
    const response = await fetch(`/api/anime/${animeId}?source=${source}`);
    const anime = await parseApiJson(response);
    
    titleEl.textContent = anime.title;
    posterEl.src = anime.poster;
    descEl.textContent = anime.description;
    
    metaEl.innerHTML = `
      <div class="pill accent">* ${anime.score || '0.0'}</div>
      <div class="pill">${anime.year || 'N/A'}</div>
      <div class="pill">${anime.type || 'TV'}</div>
      ${anime.genres.slice(0, 3).map(g => `<div class="pill">${g}</div>`).join('')}
    `;

    // Fetch providers
    const pRes = await fetch('/api/onlinestream/providers');
    const providers = await parseApiJson(pRes);
    providerSelectEl.innerHTML = providers.map(p => `<option value="${p.id}">Provider: ${p.name}</option>`).join('');
    const providerIds = providers.map((p) => p.id);
    availableProviderIds = providerIds.slice();

    // Backward compatibility:
    // If URL has provider=seanime with seaProvider equal to a first-class provider id
    // (e.g. animesaturn), switch to the direct provider automatically.
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

    if (!providerIds.includes(selectedProvider)) {
      selectedProvider = providerIds.includes('seanime') ? 'seanime' : (providerIds[0] || 'seanime');
    }
    if (selectedProvider === 'animesaturn' && providerIds.includes('seanime')) {
      selectedProvider = 'seanime';
      selectedSeaProvider = '';
    }
    providerSelectEl.value = selectedProvider;
    updateUrlParams({ provider: selectedProvider });

    await loadSeaProviders();
    if (selectedProvider === 'seanime') {
      const seaIds = availableSeaProviders.map((item) => String(item.id || '').toLowerCase());
      const preferredSea = ['hianime', 'zoro', 'anicrush'].find((id) => seaIds.includes(id)) || '';
      if ((!selectedSeaProvider || !seaIds.includes(selectedSeaProvider)) && preferredSea) {
        selectedSeaProvider = preferredSea;
        seaProviderSelectEl.value = selectedSeaProvider;
        updateUrlParams({ seaProvider: selectedSeaProvider });
      }
    }
    await loadEpisodeList();
    await searchSubtitles();
    setupQuickSearch();
  } catch (error) {
    console.error(error);
  }
}

providerSelectEl.addEventListener('change', async () => {
    selectedProvider = providerSelectEl.value;
    updateUrlParams({ provider: selectedProvider, seaProvider: selectedProvider === 'seanime' ? selectedSeaProvider : null });
    await loadSeaProviders();
    await loadEpisodeList();
});

seaProviderSelectEl.addEventListener('change', async () => {
    selectedSeaProvider = seaProviderSelectEl.value;
    updateUrlParams({ seaProvider: selectedSeaProvider || null });
    await loadEpisodeList();
});

serverSelectEl.addEventListener('change', () => {
    selectedServer = serverSelectEl.value;
    renderAndPlay();
});

qualitySelectEl.addEventListener('change', () => {
    selectedQuality = qualitySelectEl.value;
    renderAndPlay();
});

audioSelectEl?.addEventListener('change', () => {
    if (!hlsInstance) return;
    const next = Number(audioSelectEl.value);
    if (!Number.isInteger(next) || next < 0) return;
    hlsInstance.audioTrack = next;
});

subtitleSearchBtn?.addEventListener('click', searchSubtitles);
subtitleListEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-sub-index]');
    if (!btn) return;
    const index = Number(btn.dataset.subIndex);
    if (Number.isNaN(index)) return;
    attachSubtitle(index);
});

document.addEventListener('keydown', (event) => {
    if (isTypingContext(event.target)) return;
    const key = String(event.key || '').toLowerCase();
    if (key === 'arrowleft') {
      event.preventDefault();
      seekBy(-5);
      return;
    }
    if (key === 'arrowright') {
      event.preventDefault();
      seekBy(5);
      return;
    }
    if (key === 'j') {
      event.preventDefault();
      seekBy(-10);
      return;
    }
    if (key === 'l') {
      event.preventDefault();
      seekBy(10);
      return;
    }
    if (key === 'c') {
      event.preventDefault();
      toggleCaptionsShortcut();
    }
});

init();


