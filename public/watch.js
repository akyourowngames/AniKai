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

let hlsInstance = null;
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
const AUTO_ROTATE_MIN_DELAY_MS = 5000;
const AUTO_ROTATE_MAX_DELAY_MS = 5000;
let autoRotateTimer = null;
let autoRotateInProgress = false;
let autoRotateTriedSeaProviders = new Set();

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
  resetAutoRotateState();
  
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

function resetPlayerHost() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  playerHostEl.innerHTML = '<video id="player" controls playsinline></video>';
  return playerHostEl.querySelector('#player');
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

function clearAutoRotateTimer() {
  if (autoRotateTimer) {
    clearTimeout(autoRotateTimer);
    autoRotateTimer = null;
  }
  autoRotateInProgress = false;
}

function resetAutoRotateState() {
  clearAutoRotateTimer();
  autoRotateTriedSeaProviders = new Set();
  if (selectedProvider === 'seanime') {
    autoRotateTriedSeaProviders.add(String(selectedSeaProvider || '').toLowerCase());
  }
}

function getSeaProviderLabel(providerId) {
  if (!providerId) return 'Auto (fallback)';
  const match = availableSeaProviders.find((item) => String(item.id || '').toLowerCase() === providerId);
  return match?.name || providerId;
}

function randomRotateDelay() {
  return Math.floor(Math.random() * (AUTO_ROTATE_MAX_DELAY_MS - AUTO_ROTATE_MIN_DELAY_MS + 1)) + AUTO_ROTATE_MIN_DELAY_MS;
}

function getSeaProviderRotationQueue() {
  const ids = ['', ...availableSeaProviders.map((item) => String(item.id || '').toLowerCase())];
  const uniq = [...new Set(ids)];
  return uniq.filter((id) => !autoRotateTriedSeaProviders.has(id));
}

function scheduleSeaProviderRotation(reason = 'Stream unavailable') {
  if (selectedProvider !== 'seanime') return false;
  if (autoRotateInProgress || autoRotateTimer) return true;

  const queue = getSeaProviderRotationQueue();
  if (!queue.length) {
    showToast('All Sea sources exhausted for this episode', 'error');
    return false;
  }

  const nextSeaProvider = queue[0];
  const delay = randomRotateDelay();
  autoRotateInProgress = true;
  showToast(`${reason}. Rotating Sea source in ${Math.round(delay / 1000)}s`, 'error');

  autoRotateTimer = setTimeout(async () => {
    autoRotateTimer = null;
    autoRotateInProgress = false;
    selectedSeaProvider = nextSeaProvider;
    autoRotateTriedSeaProviders.add(nextSeaProvider);
    if (seaProviderSelectEl) {
      seaProviderSelectEl.value = selectedSeaProvider;
    }
    updateUrlParams({ seaProvider: selectedSeaProvider || null });
    showToast(`Trying Sea source: ${getSeaProviderLabel(selectedSeaProvider)}`);
    await loadEpisodeSource();
  }, delay);

  return true;
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
    if (!scheduleSeaProviderRotation('No stream available')) {
      showToast('No stream available for this episode', 'error');
    }
    return;
  }

  clearAutoRotateTimer();

  if (sourceItem.type === 'youtube' || sourceItem.type === 'embed') {
    const iframe = document.createElement('iframe');
    iframe.src = sourceItem.type === 'youtube' ? `https://www.youtube-nocookie.com/embed/${sourceItem.url}` : sourceItem.url;
    iframe.allowFullscreen = true;
    playerHostEl.innerHTML = '';
    playerHostEl.appendChild(iframe);
    return;
  }

  const playerEl = resetPlayerHost();
  const nextSource = () => {
    const order = buildSourceOrder();
    if (sourceCursor >= order.length - 1) return false;
    sourceCursor += 1;
    const fallback = order[sourceCursor];
    if (!fallback) return false;
    selectedServer = fallback.server || selectedServer;
    selectedQuality = fallback.quality || selectedQuality;
    if (serverSelectEl && selectedServer) {
      serverSelectEl.value = selectedServer;
    }
    if (qualitySelectEl && selectedQuality) {
      qualitySelectEl.value = selectedQuality;
    }
    updateUrlParams({ server: selectedServer, quality: selectedQuality });
    showToast(`Switching to ${selectedServer} (${selectedQuality})`, 'error');
    playSelectedSource(fallback);
    return true;
  };

  playerEl.addEventListener('error', () => {
    if (!nextSource() && !scheduleSeaProviderRotation('All stream servers failed')) {
      showToast('All stream servers failed for this episode', 'error');
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
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => playerEl.play().catch(() => {}));
      hlsInstance.on(Hls.Events.ERROR, (_, data) => {
        if (data?.fatal) {
          if (!nextSource() && !scheduleSeaProviderRotation('All stream servers failed')) {
            showToast('All stream servers failed for this episode', 'error');
          }
        }
      });
      return;
    }
  }
  playerEl.src = sourceItem.url;
  playerEl.play().catch(() => {});
}

function renderAndPlay() {
  renderServerOptions();
  renderQualityOptions();
  const order = buildSourceOrder();
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
    item.addEventListener('click', () => changeEpisode(episode.number));
    episodeListEl.appendChild(item);
  });
}

async function loadEpisodeSource() {
  try {
    const response = await fetch('/api/onlinestream/episode-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mediaId: Number(animeId),
        episodeNumber: selectedEpisode,
        source,
        provider: selectedProvider,
        seaProvider: selectedSeaProvider || undefined
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || 'Failed to load episode source');
    }
    currentSources = payload.videoSources || [];
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
    if (!scheduleSeaProviderRotation(error.message || 'Failed to load video stream')) {
      showToast(error.message || 'Failed to load video stream', 'error');
    }
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
    const payload = await response.json();
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
    const providers = await res.json();
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
  resetAutoRotateState();
}

// --- Quick Search Logic ---
async function setupQuickSearch() {
  const res = await fetch(`/api/anime?source=${source}`);
  catalog = await res.json();
  
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
function showToast(msg, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

async function init() {
  try {
    const response = await fetch(`/api/anime/${animeId}?source=${source}`);
    const anime = await response.json();
    
    titleEl.textContent = anime.title;
    posterEl.src = anime.poster;
    descEl.textContent = anime.description;
    
    metaEl.innerHTML = `
      <div class="pill accent">★ ${anime.score || '0.0'}</div>
      <div class="pill">${anime.year || 'N/A'}</div>
      <div class="pill">${anime.type || 'TV'}</div>
      ${anime.genres.slice(0, 3).map(g => `<div class="pill">${g}</div>`).join('')}
    `;

    // Fetch providers
    const pRes = await fetch('/api/onlinestream/providers');
    const providers = await pRes.json();
    providerSelectEl.innerHTML = providers.map(p => `<option value="${p.id}">Provider: ${p.name}</option>`).join('');
    const providerIds = providers.map((p) => p.id);
    if (!providerIds.includes(selectedProvider)) {
      selectedProvider = providerIds.includes('seanime') ? 'seanime' : (providerIds[0] || 'seanime');
    }
    providerSelectEl.value = selectedProvider;
    updateUrlParams({ provider: selectedProvider });

    await loadSeaProviders();
    resetAutoRotateState();
    await loadEpisodeList();
    setupQuickSearch();
  } catch (error) {
    console.error(error);
  }
}

providerSelectEl.addEventListener('change', async () => {
    selectedProvider = providerSelectEl.value;
    updateUrlParams({ provider: selectedProvider, seaProvider: selectedProvider === 'seanime' ? selectedSeaProvider : null });
    await loadSeaProviders();
    resetAutoRotateState();
    await loadEpisodeList();
});

seaProviderSelectEl.addEventListener('change', async () => {
    selectedSeaProvider = seaProviderSelectEl.value;
    updateUrlParams({ seaProvider: selectedSeaProvider || null });
    resetAutoRotateState();
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

init();
