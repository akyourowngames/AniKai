const sidebarToggle = document.querySelector('#sidebarToggle');
const sidebar = document.querySelector('#sidebar');
const searchInput = document.querySelector('#searchInput');
const searchResults = document.querySelector('#searchResults');
const searchResultTemplate = document.querySelector('#searchResultTemplate');

const loginBtn = document.querySelector('#loginBtn');
const logoutBtn = document.querySelector('#logoutBtn');
const userChip = document.querySelector('#userChip');
const anilistLoginBtn = document.querySelector('#anilistLoginBtn');
const anilistModal = document.querySelector('#anilistModal');
const closeAnilistModal = document.querySelector('#closeAnilistModal');
const openAnilistTokenPage = document.querySelector('#openAnilistTokenPage');
const anilistTokenInput = document.querySelector('#anilistTokenInput');
const saveAnilistTokenBtn = document.querySelector('#saveAnilistTokenBtn');
const anilistAuthStatus = document.querySelector('#anilistAuthStatus');

const firebaseAuthModal = document.querySelector('#firebaseAuthModal');
const firebaseAuthConfirmBtn = document.querySelector('#firebaseAuthConfirmBtn');
const firebaseGoogleBtn = document.querySelector('#firebaseGoogleBtn');
const firebaseAuthCancelBtn = document.querySelector('#firebaseAuthCancelBtn');
const firebaseAuthStatus = document.querySelector('#firebaseAuthStatus');
const authDisplayNameInput = document.querySelector('#authDisplayNameInput');
const authEmailInput = document.querySelector('#authEmailInput');
const authPasswordInput = document.querySelector('#authPasswordInput');

const accountProfile = document.querySelector('#accountProfile');
const accountStats = document.querySelector('#accountStats');
const accountPlaylistList = document.querySelector('#accountPlaylistList');
const accountJourneyList = document.querySelector('#accountJourneyList');
const exportPlaylistBtn = document.querySelector('#exportPlaylistBtn');
const clearJourneyBtn = document.querySelector('#clearJourneyBtn');

const sourceParam = new URLSearchParams(window.location.search).get('source');
const source = sourceParam === 'mal' ? 'mal' : 'anilist';

const ANILIST_START_URL = '/api/auth/anilist/start';
const USER_SESSION_KEY = 'anikai_user_session';
const USER_PLAYLISTS_KEY = 'anikai_user_playlists';
const GUEST_WATCHLIST_KEY = 'anikai_guest_watchlist';
const WATCH_PROGRESS_KEY = 'anikai_watch_positions';
const RECENT_SEARCHES_KEY = 'anikai_recent_searches';
const ACCOUNT_CATALOG_CACHE_KEY_PREFIX = 'anikai_account_catalog_cache_';
const ACCOUNT_CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const firebaseClient = window.AnikaiFirebase || null;

let currentUser = readJson(USER_SESSION_KEY, null);
let watchList = [];
let cloudProgressByAnime = new Map();
let catalog = [];
let searchAbortController = null;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) { }
}

function getAccountCatalogCacheKey() {
  return `${ACCOUNT_CATALOG_CACHE_KEY_PREFIX}${source}`;
}

function readAccountCatalogCache() {
  const payload = readJson(getAccountCatalogCacheKey(), null);
  if (!payload || !Array.isArray(payload.items)) return null;
  const savedAt = Number(payload.savedAt || 0);
  if (!savedAt || Date.now() - savedAt > ACCOUNT_CATALOG_CACHE_TTL_MS) return null;
  return payload.items;
}

function writeAccountCatalogCache(items) {
  if (!Array.isArray(items) || !items.length) return;
  writeJson(getAccountCatalogCacheKey(), {
    savedAt: Date.now(),
    items
  });
}

function getStorageUserKey() {
  return currentUser?.uid ? String(currentUser.uid) : 'guest';
}

function getRecentSearchStore() {
  return readJson(RECENT_SEARCHES_KEY, {});
}

function getRecentSearches(limit = 6) {
  const store = getRecentSearchStore();
  const list = Array.isArray(store[getStorageUserKey()]) ? store[getStorageUserKey()] : [];
  return list.slice(0, limit);
}

function pushRecentSearch(query) {
  const term = String(query || '').trim();
  if (!term) return;
  const store = getRecentSearchStore();
  const key = getStorageUserKey();
  const current = Array.isArray(store[key]) ? store[key] : [];
  store[key] = [term, ...current.filter((item) => item.toLowerCase() !== term.toLowerCase())].slice(0, 8);
  writeJson(RECENT_SEARCHES_KEY, store);
}

function showToast(msg, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

// Sidebar
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

document.addEventListener('click', (event) => {
  if (window.innerWidth > 1100) return;
  const clickInsideSidebar = sidebar?.contains(event.target);
  const clickOnToggle = sidebarToggle?.contains(event.target);
  if (!clickInsideSidebar && !clickOnToggle) {
    document.body.classList.remove('mobile-menu-open');
  }
});

// Auth UI
if (openAnilistTokenPage) {
  openAnilistTokenPage.href = ANILIST_START_URL;
  openAnilistTokenPage.textContent = 'Login with AniList';
}

if (anilistLoginBtn && anilistModal) {
  anilistLoginBtn.addEventListener('click', () => {
    anilistModal.style.display = 'grid';
    if (anilistTokenInput) anilistTokenInput.focus();
  });
}

if (closeAnilistModal && anilistModal) {
  closeAnilistModal.addEventListener('click', () => {
    anilistModal.style.display = 'none';
  });
}

if (anilistModal) {
  anilistModal.addEventListener('click', (event) => {
    if (event.target === anilistModal) anilistModal.style.display = 'none';
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
    if (anilistAuthStatus) anilistAuthStatus.textContent = 'Saving token...';
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
      if (anilistAuthStatus) anilistAuthStatus.textContent = 'Token saved.';
      showToast('AniList token saved', 'success');
    } catch (error) {
      if (anilistAuthStatus) anilistAuthStatus.textContent = `Error: ${error.message}`;
      showToast(error.message, 'error');
    } finally {
      saveAnilistTokenBtn.disabled = false;
    }
  });
}

function renderAuthUi() {
  const isAuthed = Boolean(currentUser?.uid);
  if (userChip) {
    userChip.style.display = isAuthed ? 'inline-flex' : 'none';
    userChip.textContent = isAuthed ? (currentUser.displayName || 'User') : '';
  }
  if (loginBtn) loginBtn.style.display = isAuthed ? 'none' : 'inline-flex';
  if (logoutBtn) logoutBtn.style.display = isAuthed ? 'inline-flex' : 'none';
}

function openFirebaseAuthModal() {
  if (!firebaseAuthModal) return;
  firebaseAuthModal.style.display = 'grid';
  if (firebaseAuthStatus) {
    firebaseAuthStatus.textContent = 'Sign in with Google or Email to sync data.';
  }
  if (authDisplayNameInput) authDisplayNameInput.focus();
}

function closeFirebaseAuthModal() {
  if (firebaseAuthModal) firebaseAuthModal.style.display = 'none';
}

async function signInWithEmail() {
  const name = authDisplayNameInput?.value.trim() || '';
  const email = authEmailInput?.value.trim() || '';
  const password = authPasswordInput?.value || '';
  if (!email || !email.includes('@')) {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Enter a valid email.';
    return;
  }
  if (!password || password.length < 6) {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Use at least 6 characters password.';
    return;
  }

  if (!firebaseClient?.ready || !firebaseClient.authEnabled) {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Firebase auth unavailable in this session.';
    return;
  }

  try {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Signing in...';
    const user = await firebaseClient.signInWithEmail(email, password);
    if (name && user?.updateProfile) await user.updateProfile({ displayName: name });
    closeFirebaseAuthModal();
  } catch (error) {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = `Firebase error: ${error.message}`;
    showToast(`Login failed: ${error.message}`, 'error');
  }
}

async function signInWithGoogle() {
  if (!firebaseClient?.ready || !firebaseClient.authEnabled) {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Google sign-in unavailable.';
    return;
  }
  try {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Opening Google login...';
    await firebaseClient.signInWithGoogle();
    closeFirebaseAuthModal();
  } catch (error) {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = `Google sign-in failed: ${error.message}`;
  }
}

async function signOutUser() {
  if (firebaseClient?.ready && firebaseClient.authEnabled) {
    try {
      await firebaseClient.signOut();
      return;
    } catch (_) { }
  }
}

if (loginBtn) loginBtn.addEventListener('click', openFirebaseAuthModal);
if (logoutBtn) logoutBtn.addEventListener('click', signOutUser);
if (firebaseGoogleBtn) firebaseGoogleBtn.addEventListener('click', signInWithGoogle);
if (firebaseAuthConfirmBtn) firebaseAuthConfirmBtn.addEventListener('click', signInWithEmail);
if (firebaseAuthCancelBtn) firebaseAuthCancelBtn.addEventListener('click', closeFirebaseAuthModal);

if (firebaseAuthModal) {
  firebaseAuthModal.addEventListener('click', (event) => {
    if (event.target === firebaseAuthModal) closeFirebaseAuthModal();
  });
}

[authDisplayNameInput, authEmailInput, authPasswordInput].forEach((input) => {
  if (!input) return;
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') signInWithEmail();
  });
});

// Data
function getUserPlaylistsStore() {
  return readJson(USER_PLAYLISTS_KEY, {});
}

function setUserPlaylistsStore(store) {
  writeJson(USER_PLAYLISTS_KEY, store);
}

async function loadWatchListForCurrentUser() {
  if (!currentUser?.uid) {
    const guestList = readJson(GUEST_WATCHLIST_KEY, readJson('watchList', []));
    writeJson('watchList', guestList);
    watchList = Array.isArray(guestList) ? guestList : [];
    return;
  }

  const localStore = getUserPlaylistsStore();
  watchList = Array.isArray(localStore[currentUser.uid]) ? localStore[currentUser.uid] : [];
  writeJson('watchList', watchList);

  if (firebaseClient?.ready && firebaseClient.firestoreEnabled) {
    try {
      const cloudList = await firebaseClient.loadPlaylist(currentUser.uid);
      if (Array.isArray(cloudList)) {
        watchList = cloudList;
        writeJson('watchList', watchList);
        localStore[currentUser.uid] = watchList;
        setUserPlaylistsStore(localStore);
      }
    } catch (error) {
      console.error('Playlist load failed', error);
    }
  }
}

function getLocalLatestProgressByAnime() {
  const allProgress = readJson(WATCH_PROGRESS_KEY, {});
  const latestByAnime = new Map();
  Object.entries(allProgress).forEach(([key, value]) => {
    const [animeId, episodeRaw] = key.split('_');
    if (!animeId || !value) return;
    const episode = Number(episodeRaw) || 1;
    const ts = Number(value.ts) || 0;
    const current = latestByAnime.get(String(animeId));
    if (!current || ts > current.ts) {
      latestByAnime.set(String(animeId), {
        episode,
        currentTime: Number(value.currentTime) || 0,
        duration: Number(value.duration) || 0,
        pct: Number(value.pct) || 0,
        ts
      });
    }
  });
  return latestByAnime;
}

async function loadCloudProgressForCurrentUser() {
  cloudProgressByAnime = new Map();
  if (!currentUser?.uid || !firebaseClient?.ready || !firebaseClient.firestoreEnabled) return;
  try {
    const entries = await firebaseClient.loadWatchProgress(currentUser.uid, 120);
    const next = new Map();
    (entries || []).forEach((entry) => {
      if (!entry?.animeId) return;
      next.set(String(entry.animeId), {
        episode: Number(entry.episode || 1),
        currentTime: Number(entry.currentTime || 0),
        duration: Number(entry.duration || 0),
        pct: Number(entry.pct || 0),
        ts: Number(entry.ts || 0)
      });
    });
    cloudProgressByAnime = next;
  } catch (error) {
    console.error('Progress load failed', error);
  }
}

function getLatestProgressByAnime() {
  const localMap = getLocalLatestProgressByAnime();
  if (!cloudProgressByAnime.size) return localMap;
  const merged = new Map(localMap);
  cloudProgressByAnime.forEach((cloudValue, animeId) => {
    const localValue = merged.get(String(animeId));
    if (!localValue || Number(cloudValue.ts || 0) > Number(localValue.ts || 0)) {
      merged.set(String(animeId), cloudValue);
    }
  });
  return merged;
}

function formatAgo(ts) {
  const diff = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getJourneyEntries(limit = 20) {
  const latestByAnime = getLatestProgressByAnime();
  return Array.from(latestByAnime.entries())
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
    .slice(0, limit)
    .map(([animeId, progress]) => {
      const anime = catalog.find((item) => String(item.id) === String(animeId));
      if (!anime) return null;
      return { anime, progress };
    })
    .filter(Boolean);
}

function renderProfile() {
  const entries = getJourneyEntries(200);
  const watchedMinutes = Math.round(entries.reduce((sum, item) => sum + ((item.progress?.currentTime || 0) / 60), 0));
  const profileLines = [
    `User: ${currentUser?.displayName || 'Guest'}`,
    `Email: ${currentUser?.email || 'Not connected'}`,
    `Auth: ${currentUser?.provider || 'local'}`
  ];
  const statsLines = [
    `Saved playlist: ${watchList.length} titles`,
    `Journey entries: ${entries.length}`,
    `Watch time: ${watchedMinutes} min`
  ];
  accountProfile.innerHTML = profileLines.map((line) => `<div>${line}</div>`).join('');
  accountStats.innerHTML = statsLines.map((line) => `<div>${line}</div>`).join('');
}

function renderPlaylist() {
  if (!watchList.length) {
    accountPlaylistList.innerHTML = '<div class="account-empty">No saved playlist yet.</div>';
    return;
  }
  accountPlaylistList.innerHTML = watchList.slice(0, 12).map((anime) => `
    <a class="journey-item" href="/watch.html?id=${anime.id}&source=${source}">
      <img class="journey-poster" src="${anime.poster || ''}" alt="${anime.title}" loading="lazy" />
      <div class="journey-info">
        <div class="journey-title">${anime.title}</div>
        <div class="journey-meta">${anime.year || 'N/A'} • ${anime.genres?.[0] || 'Anime'}</div>
      </div>
    </a>
  `).join('');
}

function renderJourney() {
  const entries = getJourneyEntries(20);
  if (!entries.length) {
    accountJourneyList.innerHTML = '<div class="account-empty">No watch activity yet.</div>';
    return;
  }
  accountJourneyList.innerHTML = entries.map(({ anime, progress }) => {
    const pct = Math.max(0, Math.min(100, Math.round((progress.pct || 0) * 100)));
    return `
      <a class="journey-item" href="/watch.html?id=${anime.id}&episode=${progress.episode || 1}&source=${source}">
        <img class="journey-poster" src="${anime.poster || ''}" alt="${anime.title}" loading="lazy" />
        <div class="journey-info">
          <div class="journey-title">${anime.title}</div>
          <div class="journey-meta">Episode ${progress.episode || 1} • ${pct}% watched • ${formatAgo(progress.ts)}</div>
          <div class="journey-progress"><span style="width:${pct}%"></span></div>
        </div>
      </a>
    `;
  }).join('');
}

if (exportPlaylistBtn) {
  exportPlaylistBtn.addEventListener('click', () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      user: currentUser?.uid || 'guest',
      items: watchList
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `anikai-playlist-${Date.now()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
    showToast('Playlist exported', 'success');
  });
}

if (clearJourneyBtn) {
  clearJourneyBtn.addEventListener('click', async () => {
    if (!window.confirm('Clear your watch journey progress?')) return;
    writeJson(WATCH_PROGRESS_KEY, {});
    cloudProgressByAnime = new Map();
    if (firebaseClient?.ready && firebaseClient.firestoreEnabled && currentUser?.uid && typeof firebaseClient.clearWatchProgress === 'function') {
      try {
        await firebaseClient.clearWatchProgress(currentUser.uid);
      } catch (error) {
        console.error('Cloud journey clear failed', error);
      }
    }
    renderJourney();
    renderProfile();
    showToast('Watch journey cleared', 'info');
  });
}

// Search
searchInput?.addEventListener('focus', () => {
  if (!searchInput.value.trim()) renderRecentSearches();
});

searchInput?.addEventListener('blur', () => {
  setTimeout(() => searchResults.classList.remove('active'), 180);
});

searchInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const first = searchResults.querySelector('.search-item');
  if (first?.href) window.location.href = first.href;
});

searchInput?.addEventListener('input', async (event) => {
  const term = String(event.target.value || '').trim().toLowerCase();
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

function renderSearchResults(items) {
  searchResults.innerHTML = '';
  items.forEach((anime) => {
    const node = searchResultTemplate.content.cloneNode(true);
    const link = node.querySelector('.search-item');
    link.href = `/watch.html?id=${anime.id}&source=${source}`;
    link.addEventListener('click', () => pushRecentSearch(anime.title));
    const searchPoster = link.querySelector('.search-poster');
    searchPoster.src = anime.poster;
    searchPoster.alt = `${anime.title} poster`;
    link.querySelector('.search-title').textContent = anime.title;
    link.querySelector('.search-meta').textContent = `${anime.year || 'N/A'} • ${anime.genres?.[0] || ''}`;
    searchResults.appendChild(node);
  });
  searchResults.classList.toggle('active', items.length > 0);
}

async function applyAuthUser(user, options = {}) {
  const keepExistingOnNull = Boolean(options.keepExistingOnNull);

  if (user?.uid) {
    currentUser = {
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || (user.email ? user.email.split('@')[0] : 'User'),
      provider: 'firebase'
    };
    writeJson(USER_SESSION_KEY, currentUser);
  } else if (!keepExistingOnNull) {
    currentUser = null;
    localStorage.removeItem(USER_SESSION_KEY);
  }

  renderAuthUi();
  await loadWatchListForCurrentUser();
  await loadCloudProgressForCurrentUser();
  renderProfile();
  renderPlaylist();
  renderJourney();
}

async function init() {
  const cachedCatalog = readAccountCatalogCache();
  if (Array.isArray(cachedCatalog) && cachedCatalog.length) {
    catalog = cachedCatalog;
  }

  renderAuthUi();
  await loadWatchListForCurrentUser();
  await loadCloudProgressForCurrentUser();
  renderProfile();
  renderPlaylist();
  renderJourney();

  if (firebaseClient?.ready && firebaseClient.authEnabled) {
    firebaseClient.onAuthStateChanged((user) => {
      applyAuthUser(user);
    });
  } else {
    await applyAuthUser(currentUser, { keepExistingOnNull: true });
  }

  fetch(`/api/anime/all?source=${source}`)
    .then((catalogRes) => catalogRes.json().catch(() => []))
    .then((payload) => {
      catalog = Array.isArray(payload) ? payload : [];
      writeAccountCatalogCache(catalog);
      renderProfile();
      renderPlaylist();
      renderJourney();
    })
    .catch(() => {
      if (!catalog.length) {
        catalog = [];
      }
    });
}

init();
