const animeGrid = document.querySelector('#animeGrid');
const latestGrid = document.querySelector('#latestGrid');
const topList = document.querySelector('#topList');
const continueGrid = document.querySelector('#continueGrid');
const continueSection = document.querySelector('#continueWatchingSection');
const watchListGrid = document.querySelector('#watchListGrid');
const watchListSection = document.querySelector('#watchListSection');
const cardTemplate = document.querySelector('#cardTemplate');
const listTemplate = document.querySelector('#listTemplate');
const searchResultTemplate = document.querySelector('#searchResultTemplate');
const searchInput = document.querySelector('#searchInput');
const searchResults = document.querySelector('#searchResults');
const hero = document.querySelector('#hero');
const heroTitle = document.querySelector('#heroTitle');
const heroDesc = document.querySelector('#heroDesc');
const heroMeta = document.querySelector('#heroMeta');
const heroWatchBtn = document.querySelector('#heroWatchBtn');
const sidebarToggle = document.querySelector('#sidebarToggle');
const sidebar = document.querySelector('#sidebar');
const randomBtn = document.querySelector('#randomBtn');
const myListLink = document.querySelector('#myListLink');
const anilistLoginBtn = document.querySelector('#anilistLoginBtn');
const anilistModal = document.querySelector('#anilistModal');
const closeAnilistModal = document.querySelector('#closeAnilistModal');
const openAnilistTokenPage = document.querySelector('#openAnilistTokenPage');
const anilistTokenInput = document.querySelector('#anilistTokenInput');
const saveAnilistTokenBtn = document.querySelector('#saveAnilistTokenBtn');
const anilistAuthStatus = document.querySelector('#anilistAuthStatus');
const catalogSyncStatus = document.querySelector('#catalogSyncStatus');

const sourceParam = new URLSearchParams(window.location.search).get('source');
const source = sourceParam === 'mal' ? 'mal' : 'anilist';

let catalog = [];
let watchList = JSON.parse(localStorage.getItem('watchList')) || [];
const ANILIST_START_URL = '/api/auth/anilist/start';
const CATALOG_PAGE_SIZE = 24;
const CATALOG_MAX_PAGES = 200;
const renderedLatestIds = new Set();
const renderedTrendingIds = new Set();

if (openAnilistTokenPage) {
  openAnilistTokenPage.href = ANILIST_START_URL;
  openAnilistTokenPage.textContent = 'Login with AniList';
}

if (anilistLoginBtn && anilistModal) {
  anilistLoginBtn.addEventListener('click', () => {
    anilistModal.style.display = 'grid';
    if (anilistTokenInput) {
      anilistTokenInput.focus();
    }
  });
}

if (closeAnilistModal && anilistModal) {
  closeAnilistModal.addEventListener('click', () => {
    anilistModal.style.display = 'none';
  });
}

if (anilistModal) {
  anilistModal.addEventListener('click', (event) => {
    if (event.target === anilistModal) {
      anilistModal.style.display = 'none';
    }
  });
}

if (saveAnilistTokenBtn && anilistTokenInput) {
  saveAnilistTokenBtn.addEventListener('click', async () => {
    const token = anilistTokenInput.value.trim();
    if (!token) {
      if (anilistAuthStatus) anilistAuthStatus.textContent = 'Please paste a token first.';
      return;
    }

    saveAnilistTokenBtn.disabled = true;
    if (anilistAuthStatus) anilistAuthStatus.textContent = 'Saving token to this website...';

    try {
      const response = await fetch('/api/auth/anilist-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Failed to save token');
      }

      if (anilistAuthStatus) anilistAuthStatus.textContent = 'Token saved to website backend.';
      showToast('AniList token saved to website', 'success');
      localStorage.setItem('anilistTokenSavedAt', String(Date.now()));
    } catch (error) {
      if (anilistAuthStatus) anilistAuthStatus.textContent = `Error: ${error.message}`;
      showToast(`AniList auth failed: ${error.message}`, 'error');
    } finally {
      saveAnilistTokenBtn.disabled = false;
    }
  });
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
  const clickInsideSidebar = sidebar?.contains(e.target);
  const clickOnToggle = sidebarToggle?.contains(e.target);
  if (!clickInsideSidebar && !clickOnToggle) {
    document.body.classList.remove('mobile-menu-open');
  }
});

// --- Watch List Logic ---
function toggleWatchList(e, anime) {
  e.preventDefault();
  e.stopPropagation();
  const index = watchList.findIndex(item => item.id === anime.id);
  if (index > -1) {
    watchList.splice(index, 1);
    showToast(`${anime.title} removed from list`, 'info');
  } else {
    watchList.push(anime);
    showToast(`${anime.title} added to list`, 'success');
  }
  localStorage.setItem('watchList', JSON.stringify(watchList));
  renderWatchList();
  
  // Update button state if visible
  const btn = e.target.closest('.card-action-btn');
  if (btn) {
    btn.classList.toggle('active');
    btn.innerHTML = index > -1 
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"></path></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  }
}

function renderWatchList() {
  if (watchList.length === 0) {
    watchListSection.style.display = 'none';
    return;
  }
  watchListGrid.innerHTML = '';
  renderGrid(watchListGrid, watchList);
  watchListSection.style.display = 'block';
}

myListLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (watchList.length > 0) {
    watchListSection.style.display = 'block';
    watchListSection.scrollIntoView({ behavior: 'smooth' });
  } else {
    showToast('Your watch list is empty', 'info');
  }
});

// --- Continue Watching Logic ---
function loadContinueWatching() {
  const history = JSON.parse(localStorage.getItem('watchHistory')) || {};
  const ids = Object.keys(history).sort((a, b) => history[b].timestamp - history[a].timestamp).slice(0, 4);
  
  if (ids.length === 0) {
    continueSection.style.display = 'none';
    return;
  }

  continueGrid.innerHTML = '';
  const items = catalog.filter(a => ids.includes(String(a.id)));
  
  if (items.length > 0) {
    continueSection.style.display = 'block';
    renderGrid(continueGrid, items, true);
  }
}

// --- Live Search ---
let searchTimeout;
searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const term = e.target.value.trim().toLowerCase();
  
  if (!term) {
    searchResults.classList.remove('active');
    return;
  }

  searchTimeout = setTimeout(() => {
    const filtered = catalog.filter(a => a.title.toLowerCase().includes(term)).slice(0, 5);
    renderSearchResults(filtered);
  }, 200);
});

searchInput.addEventListener('blur', () => {
  setTimeout(() => searchResults.classList.remove('active'), 200);
});

function renderSearchResults(items) {
  searchResults.innerHTML = '';
  if (items.length === 0) {
    searchResults.innerHTML = '<div style="padding:1rem; color:var(--text-dim); text-align:center;">No results found</div>';
  } else {
    items.forEach(anime => {
      const node = searchResultTemplate.content.cloneNode(true);
      const link = node.querySelector('.search-item');
      link.href = `/watch.html?id=${anime.id}&source=${source}`;
      link.querySelector('.search-poster').src = anime.poster;
      link.querySelector('.search-title').textContent = anime.title;
      link.querySelector('.search-meta').textContent = `${anime.year || 'TV'} • ${anime.genres[0] || ''}`;
      searchResults.appendChild(node);
    });
  }
  searchResults.classList.add('active');
}

// --- Random Anime ---
randomBtn.addEventListener('click', (e) => {
  e.preventDefault();
  if (catalog.length > 0) {
    const random = catalog[Math.floor(Math.random() * catalog.length)];
    window.location.href = `/watch.html?id=${random.id}&source=${source}`;
  }
});

// --- Render Logic ---
function renderGrid(container, items, isHistory = false) {
  if (!items.length) return;

  items.forEach((anime, index) => {
    const cardNode = cardTemplate.content.cloneNode(true);
    const card = cardNode.querySelector('.card');
    const poster = anime.poster || 'https://via.placeholder.com/400x600?text=No+Image';
    const img = card.querySelector('.poster-img');

    img.src = poster;
    img.alt = anime.title;
    
    // Watch List Button
    const actionBtn = card.querySelector('.card-action-btn');
    const inList = watchList.some(i => i.id === anime.id);
    if (inList) {
      actionBtn.classList.add('active');
      actionBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    }
    actionBtn.addEventListener('click', (e) => toggleWatchList(e, anime));

    card.querySelector('.card-title').textContent = anime.title;
    card.querySelector('.card-title').title = anime.title;
    
    if (anime.episodeCount) {
        card.querySelector('.tag-eps').textContent = `EP ${anime.episodeCount}`;
    }

    if (isHistory) {
       const history = JSON.parse(localStorage.getItem('watchHistory')) || {};
       const progress = history[anime.id];
       card.querySelector('.card-meta').textContent = `Ep ${progress?.episode || 1}`;
       card.href = `/watch.html?id=${anime.id}&episode=${progress?.episode || 1}&source=${source}`;
    } else {
       card.querySelector('.card-meta').textContent = `${anime.year || 'N/A'} • ${anime.genres[0] || 'Unknown'}`;
       card.href = `/watch.html?id=${anime.id}&source=${source}`;
    }

    card.classList.add('reveal-item');
    card.style.animationDelay = `${Math.min(index, 9) * 50}ms`;
    container.appendChild(cardNode);
  });
}

function renderTopList(items) {
  topList.innerHTML = '';
  items.slice(0, 10).forEach((anime, index) => {
    const listNode = listTemplate.content.cloneNode(true);
    const item = listNode.querySelector('.list-item');
    
    item.querySelector('.list-rank').textContent = (index + 1).toString().padStart(2, '0');
    item.querySelector('.list-img').src = anime.poster;
    item.querySelector('.list-title').textContent = anime.title;
    item.querySelector('.list-meta').textContent = `${anime.type || 'TV'} • ${anime.score || '0.0'}`;
    item.href = `/watch.html?id=${anime.id}&source=${source}`;

    topList.appendChild(listNode);
  });
}

function renderCatalogSections() {
  latestGrid.innerHTML = '';
  animeGrid.innerHTML = '';
  topList.innerHTML = '';
  renderedLatestIds.clear();
  renderedTrendingIds.clear();

  if (!catalog.length) {
    return;
  }

  renderHero(catalog[0]);
  const latestItems = catalog.slice(0, 12);
  const trendingItems = catalog.slice(12, 24);
  renderGrid(latestGrid, latestItems);
  renderGrid(animeGrid, trendingItems);
  latestItems.forEach((anime) => renderedLatestIds.add(String(anime.id)));
  trendingItems.forEach((anime) => renderedTrendingIds.add(String(anime.id)));
  renderTopList(catalog.slice(0, 10));
  loadContinueWatching();
  renderWatchList();
}

function mergeCatalogChunk(items) {
  const byId = new Map(catalog.map((anime) => [String(anime.id), anime]));
  const added = [];
  items.forEach((anime) => {
    if (anime?.id != null && !byId.has(String(anime.id))) {
      byId.set(String(anime.id), anime);
      added.push(anime);
    }
  });
  catalog = Array.from(byId.values());
  return added;
}

function appendNewCatalogToSections(items) {
  if (!Array.isArray(items) || !items.length) return;

  items.forEach((anime) => {
    const animeId = String(anime.id);
    if (renderedLatestIds.size < 12 && !renderedLatestIds.has(animeId)) {
      renderGrid(latestGrid, [anime]);
      renderedLatestIds.add(animeId);
      return;
    }

    if (!renderedTrendingIds.has(animeId)) {
      renderGrid(animeGrid, [anime]);
      renderedTrendingIds.add(animeId);
    }
  });
}

function setCatalogSyncStatus(text) {
  if (catalogSyncStatus) {
    catalogSyncStatus.textContent = text;
  }
}

function renderHero(anime) {
  if (!anime) return;
  const poster = anime.poster || '';
  hero.style.backgroundImage = `url('${poster}')`;
  heroTitle.textContent = anime.title;
  heroDesc.textContent = anime.description || 'No description available.';
  heroMeta.innerHTML = `
    <span style="color:var(--accent)">★ ${anime.score || '0.0'}</span>
    <span>${anime.year || 'N/A'}</span>
    <span>${anime.type || 'TV'}</span>
    <span>${anime.genres.slice(0, 3).join(', ')}</span>
  `;
  heroWatchBtn.href = `/watch.html?id=${anime.id}&source=${source}`;
}

// --- Toast ---
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

// --- Init ---
async function loadCatalog() {
  try {
    setCatalogSyncStatus('Loading library...');
    const firstPageResponse = await fetch(`/api/anime?source=${source}&page=1&perPage=${CATALOG_PAGE_SIZE}`);
    if (!firstPageResponse.ok) throw new Error('Failed to load catalog');
    const firstPage = await firstPageResponse.json();
    mergeCatalogChunk(Array.isArray(firstPage) ? firstPage : []);
    renderCatalogSections();
    setCatalogSyncStatus(`Syncing library... ${catalog.length} titles`);
    loadCatalogInBackground(2);
  } catch (error) {
    console.error(error);
    setCatalogSyncStatus('Library sync failed');
    showToast('Failed to load anime data', 'error');
  }
}

async function loadCatalogInBackground(startPage = 2) {
  for (let page = startPage; page <= CATALOG_MAX_PAGES; page += 1) {
    try {
      const response = await fetch(`/api/anime?source=${source}&page=${page}&perPage=${CATALOG_PAGE_SIZE}`);
      if (!response.ok) break;
      const chunk = await response.json();
      if (!Array.isArray(chunk) || chunk.length === 0) break;

      const added = mergeCatalogChunk(chunk);
      appendNewCatalogToSections(added);
      setCatalogSyncStatus(`Syncing library... ${catalog.length} titles`);

      if (chunk.length < CATALOG_PAGE_SIZE) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    } catch (_) {
      setCatalogSyncStatus(`Library loaded: ${catalog.length} titles`);
      break;
    }
  }
  setCatalogSyncStatus(`Library loaded: ${catalog.length} titles`);
}

loadCatalog();

(async function loadAnilistAuthStatus() {
  try {
    const response = await fetch('/api/auth/anilist-token/status');
    if (!response.ok) return;
    const status = await response.json();
    if (status?.configured && anilistAuthStatus) {
      anilistAuthStatus.textContent = `Configured on website backend. Saved at: ${status.savedAt || 'unknown'}`;
    }
  } catch (_) {}
})();

document.addEventListener('mousemove', (e) => {
  if (!hero) return;
  const rect = hero.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) return;
  const x = ((e.clientX - rect.left) / rect.width - 0.5) * 10;
  const y = ((e.clientY - rect.top) / rect.height - 0.5) * 10;
  hero.style.setProperty('--hero-shift-x', `${x}px`);
  hero.style.setProperty('--hero-shift-y', `${y}px`);
});
