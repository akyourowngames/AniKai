const animeGrid = document.querySelector('#animeGrid');
const latestGrid = document.querySelector('#latestGrid');
const topList = document.querySelector('#topList');
const continueGrid = document.querySelector('#continueGrid');
const continueSection = document.querySelector('#continueWatchingSection');
const continueResumeBtn = document.querySelector('#continueResumeBtn');
const watchListGrid = document.querySelector('#watchListGrid');
const watchListSection = document.querySelector('#watchListSection');
const journeySection = document.querySelector('#journeySection');
const journeyList = document.querySelector('#journeyList');
const cardTemplate = document.querySelector('#cardTemplate');
const listTemplate = document.querySelector('#listTemplate');
const searchResultTemplate = document.querySelector('#searchResultTemplate');
const searchInput = document.querySelector('#searchInput');
const searchResults = document.querySelector('#searchResults');
const hero = document.querySelector('#hero');
const heroImage = document.querySelector('#heroImage');
const heroTitle = document.querySelector('#heroTitle');
const heroDesc = document.querySelector('#heroDesc');
const heroMeta = document.querySelector('#heroMeta');
const heroWatchBtn = document.querySelector('#heroWatchBtn');
const heroShareBtn = document.querySelector('#heroShareBtn');
const trendingCarousel = document.querySelector('#trendingCarousel');
const trendingSection = document.querySelector('#trending');
const sidebarToggle = document.querySelector('#sidebarToggle');
const sidebar = document.querySelector('#sidebar');
const randomBtn = document.querySelector('#randomBtn');
const myListLink = document.querySelector('#myListLink');
const journeyLink = document.querySelector('#journeyLink');
const loginBtn = document.querySelector('#loginBtn');
const logoutBtn = document.querySelector('#logoutBtn');
const userChip = document.querySelector('#userChip');
const firebaseAuthModal = document.querySelector('#firebaseAuthModal');
const firebaseAuthConfirmBtn = document.querySelector('#firebaseAuthConfirmBtn');
const firebaseGoogleBtn = document.querySelector('#firebaseGoogleBtn');
const firebaseAuthCancelBtn = document.querySelector('#firebaseAuthCancelBtn');
const firebaseAuthStatus = document.querySelector('#firebaseAuthStatus');
const authDisplayNameInput = document.querySelector('#authDisplayNameInput');
const authEmailInput = document.querySelector('#authEmailInput');
const authPasswordInput = document.querySelector('#authPasswordInput');
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
const ANILIST_START_URL = '/api/auth/anilist/start';
const USER_SESSION_KEY = 'anikai_user_session';
const USER_PLAYLISTS_KEY = 'anikai_user_playlists';
const GUEST_WATCHLIST_KEY = 'anikai_guest_watchlist';
const WATCH_PROGRESS_KEY = 'anikai_watch_positions';
const RECENT_SEARCHES_KEY = 'anikai_recent_searches';
const CATALOG_CACHE_KEY_PREFIX = 'anikai_catalog_cache_';
const CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_PAGE_SIZE = 24;
const CATALOG_MAX_PAGES = 80;
const MAX_LATEST_VISIBLE = 12;
const MAX_TRENDING_VISIBLE = 24;
const MAX_LATEST_VISIBLE_MOBILE = 6;
const MAX_TRENDING_VISIBLE_MOBILE = 14;
const MAX_TOP_VISIBLE_MOBILE = 0;
const BACKGROUND_SYNC_START_DELAY_MS = 20000;
const BACKGROUND_SYNC_IDLE_TIMEOUT_MS = 2000;
const BACKGROUND_CACHE_WRITE_EVERY_PAGES = 6;
const FEATURE_BOOT_DELAY_MS = 25000;
const CAROUSEL_AUTOPLAY_DELAY_MS = 7000;
const CAROUSEL_PLACEHOLDER_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const renderedLatestIds = new Set();
const renderedTrendingIds = new Set();
let carouselInterval = null;
let carouselItems = [];
let carouselIndex = 0;
let searchAbortController = null;
let currentUser = readJson(USER_SESSION_KEY, null);
let watchList = [];
let cloudProgressByAnime = new Map();
let firebaseClient = window.AnikaiFirebase || null;
let firebaseScriptsPromise = null;
let firebaseAuthUnsubscribe = null;
let featuresAssetsPromise = null;
let featuresBootstrapped = false;
let featureBootScheduled = false;
let catalogBackgroundSyncQueued = false;
let hasUserInteraction = false;
let runtimeCatalogPageSize = CATALOG_PAGE_SIZE;
let hasShownSyncError = false;

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

function isCompactViewport() {
  return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
}

function getCatalogRenderLimits() {
  if (isCompactViewport()) {
    return {
      latest: MAX_LATEST_VISIBLE_MOBILE,
      trending: MAX_TRENDING_VISIBLE_MOBILE,
      top: MAX_TOP_VISIBLE_MOBILE
    };
  }
  return {
    latest: MAX_LATEST_VISIBLE,
    trending: MAX_TRENDING_VISIBLE,
    top: 10
  };
}

function handleFirstInteraction() {
  if (hasUserInteraction) return;
  hasUserInteraction = true;
  if (catalog.length) {
    renderCatalogSections();
  }
  scheduleCatalogBackgroundSync(2, runtimeCatalogPageSize);
  scheduleDeferredFeatureBoot();
}

function registerInteractionSignals() {
  const events = ['pointerdown', 'touchstart', 'keydown', 'scroll'];
  events.forEach((eventName) => {
    window.addEventListener(eventName, handleFirstInteraction, { once: true, passive: true });
  });
}

function optimizePosterUrl(rawUrl, variant = 'card') {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  const compact = isCompactViewport();

  if (url.includes('/anilistcdn/media/anime/cover/large/')) {
    if (variant === 'hero' && !compact) {
      return url;
    }
    return url.replace('/cover/large/', '/cover/medium/');
  }

  if (url.includes('image.tmdb.org/t/p/')) {
    const target = (variant === 'hero' && !compact) ? '/w780/' : '/w342/';
    return url
      .replace('/original/', target)
      .replace('/w1280/', target)
      .replace('/w780/', target)
      .replace('/w500/', target);
  }

  return url;
}

function whenBrowserIdle(task, timeout = 1200) {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => task(), { timeout });
    return;
  }
  window.setTimeout(task, Math.min(timeout, 400));
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-dynamic-src="${src}"]`) || document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.dynamicSrc = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

function loadStylesheetOnce(href) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`link[data-dynamic-href="${href}"]`) || document.querySelector(`link[href="${href}"]`)) {
      resolve();
      return;
    }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.dynamicHref = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load stylesheet: ${href}`));
    document.head.appendChild(link);
  });
}

function initFeaturesIfReady() {
  const F = window.AnikaiFeatures;
  if (!F) return;
  F.setFullCatalog(catalog);
  if (!featuresBootstrapped) {
    F.initHomeFeatures();
    featuresBootstrapped = true;
  }
}

function enhanceRenderedCardsWithFeatures() {
  const F = window.AnikaiFeatures;
  if (!F) return;
  document.querySelectorAll('.card').forEach((card) => {
    const anime = card._animeData;
    if (!anime) return;
    F.addMoreInfoBtn(card, anime);
    F.addProgressBar(card, anime.id);
  });
}

async function ensureFeaturesAssetsLoaded() {
  if (window.AnikaiFeatures) {
    initFeaturesIfReady();
    return window.AnikaiFeatures;
  }
  if (!featuresAssetsPromise) {
    featuresAssetsPromise = (async () => {
      await loadStylesheetOnce('features.css');
      await loadScriptOnce('features.js');
      initFeaturesIfReady();
      enhanceRenderedCardsWithFeatures();
      return window.AnikaiFeatures || null;
    })().catch((error) => {
      console.warn('Features load failed', error);
      return null;
    });
  }
  return featuresAssetsPromise;
}

function bindFirebaseAuthListener() {
  if (!firebaseClient?.ready || !firebaseClient.authEnabled || firebaseAuthUnsubscribe) return;
  firebaseAuthUnsubscribe = firebaseClient.onAuthStateChanged((user) => {
    applyAuthUser(user);
  });
}

async function ensureFirebaseClientLoaded() {
  if (firebaseClient?.ready) {
    bindFirebaseAuthListener();
    return firebaseClient;
  }
  if (!firebaseScriptsPromise) {
    firebaseScriptsPromise = (async () => {
      await loadScriptOnce('https://www.gstatic.com/firebasejs/10.12.4/firebase-app-compat.js');
      await loadScriptOnce('https://www.gstatic.com/firebasejs/10.12.4/firebase-auth-compat.js');
      await loadScriptOnce('https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore-compat.js');
      await loadScriptOnce('firebase-client.js');
      firebaseClient = window.AnikaiFirebase || null;
      bindFirebaseAuthListener();
      return firebaseClient;
    })().catch((error) => {
      console.warn('Firebase load failed', error);
      firebaseClient = window.AnikaiFirebase || null;
      return firebaseClient;
    });
  }
  return firebaseScriptsPromise;
}

function sanitizeUserId(value) {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || `guest-${Date.now()}`;
}

function getUserPlaylistsStore() {
  return readJson(USER_PLAYLISTS_KEY, {});
}

function setUserPlaylistsStore(store) {
  writeJson(USER_PLAYLISTS_KEY, store);
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
  const userKey = getStorageUserKey();
  const current = Array.isArray(store[userKey]) ? store[userKey] : [];
  const next = [term, ...current.filter((item) => item.toLowerCase() !== term.toLowerCase())].slice(0, 8);
  store[userKey] = next;
  writeJson(RECENT_SEARCHES_KEY, store);
}

function getCatalogCacheKey() {
  return `${CATALOG_CACHE_KEY_PREFIX}${source}`;
}

function readCatalogCache() {
  const payload = readJson(getCatalogCacheKey(), null);
  if (!payload || !Array.isArray(payload.items)) return null;
  const savedAt = Number(payload.savedAt || 0);
  if (!savedAt || Date.now() - savedAt > CATALOG_CACHE_TTL_MS) return null;
  return payload.items;
}

function writeCatalogCache(items) {
  if (!Array.isArray(items) || !items.length) return;
  writeJson(getCatalogCacheKey(), {
    savedAt: Date.now(),
    items
  });
}

function loadWatchListForCurrentUser() {
  if (!currentUser?.uid) {
    const guestList = readJson(GUEST_WATCHLIST_KEY, readJson('watchList', []));
    writeJson(GUEST_WATCHLIST_KEY, guestList);
    writeJson('watchList', guestList);
    watchList = Array.isArray(guestList) ? guestList : [];
    return;
  }

  const localStore = getUserPlaylistsStore();
  const localUserList = Array.isArray(localStore[currentUser.uid]) ? localStore[currentUser.uid] : [];
  writeJson('watchList', localUserList);
  watchList = localUserList;

  if (firebaseClient?.ready && firebaseClient.firestoreEnabled) {
    firebaseClient.loadPlaylist(currentUser.uid)
      .then((cloudList) => {
        if (!Array.isArray(cloudList)) return;
        watchList = cloudList;
        writeJson('watchList', watchList);
        const store = getUserPlaylistsStore();
        store[currentUser.uid] = watchList;
        setUserPlaylistsStore(store);
        renderWatchList();
      })
      .catch((error) => {
        console.error('Playlist load failed', error);
      });
  }
}

function syncWatchListToCurrentUser() {
  if (!currentUser?.uid) {
    writeJson(GUEST_WATCHLIST_KEY, watchList);
    writeJson('watchList', watchList);
    return;
  }
  const store = getUserPlaylistsStore();
  store[currentUser.uid] = watchList;
  setUserPlaylistsStore(store);
  writeJson('watchList', watchList);
  if (firebaseClient?.ready && firebaseClient.firestoreEnabled) {
    firebaseClient.savePlaylist(currentUser.uid, watchList).catch((error) => {
      console.error('Playlist save failed', error);
      if (!hasShownSyncError) {
        hasShownSyncError = true;
        showToast('Firebase sync failed. Check Firestore rules/Auth.', 'error');
      }
    });
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

function loadCloudProgressForCurrentUser() {
  cloudProgressByAnime = new Map();
  if (!currentUser?.uid || !firebaseClient?.ready || !firebaseClient.firestoreEnabled) return;
  firebaseClient.loadWatchProgress(currentUser.uid, 60)
    .then((entries) => {
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
      loadContinueWatching();
      renderJourney();
    })
    .catch((error) => {
      console.error('Progress load failed', error);
    });
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

function formatAgo(ts) {
  const diff = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

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

function renderAuthUi() {
  const isAuthed = Boolean(currentUser?.uid);
  if (userChip) {
    userChip.style.display = isAuthed ? 'inline-flex' : 'none';
    userChip.textContent = isAuthed
      ? `${currentUser.displayName || 'User'}`
      : '';
  }
  if (loginBtn) loginBtn.style.display = isAuthed ? 'none' : 'inline-flex';
  if (logoutBtn) logoutBtn.style.display = isAuthed ? 'inline-flex' : 'none';
}

async function openFirebaseAuthModal() {
  if (!firebaseAuthModal) return;
  firebaseAuthModal.style.display = 'grid';
  if (firebaseAuthStatus) {
    firebaseAuthStatus.textContent = 'Preparing secure sign-in...';
  }

  try {
    await ensureFirebaseClientLoaded();
    if (firebaseAuthStatus) {
      firebaseAuthStatus.textContent = firebaseClient?.ready
        ? 'Sign in with Google or Email to sync playlists and journey.'
        : 'Firebase unavailable. Local fallback will be used.';
    }
  } catch (_) {
    if (firebaseAuthStatus) {
      firebaseAuthStatus.textContent = 'Firebase unavailable. Local fallback will be used.';
    }
  }
  if (authDisplayNameInput) authDisplayNameInput.focus();
}

function closeFirebaseAuthModal() {
  if (!firebaseAuthModal) return;
  firebaseAuthModal.style.display = 'none';
}

async function signInFrontendUser() {
  const name = authDisplayNameInput?.value.trim() || '';
  const email = authEmailInput?.value.trim() || '';
  const password = authPasswordInput?.value || '';
  if (!email || !email.includes('@')) {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Enter a valid email.';
    return;
  }
  if (!password || password.length < 6) {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Use a password with at least 6 characters.';
    return;
  }

  if (!firebaseClient?.ready) {
    await ensureFirebaseClientLoaded();
  }

  if (firebaseClient?.ready && firebaseClient.authEnabled) {
    try {
      if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Signing in with Firebase...';
      const user = await firebaseClient.signInWithEmail(email, password);
      if (name && user?.updateProfile) {
        await user.updateProfile({ displayName: name });
      }
      closeFirebaseAuthModal();
      return;
    } catch (error) {
      if (firebaseAuthStatus) firebaseAuthStatus.textContent = `Firebase error: ${error.message}`;
      showToast(`Login failed: ${error.message}`, 'error');
      return;
    }
  }

  const displayName = name || email.split('@')[0];
  const uid = sanitizeUserId(email);
  writeJson(GUEST_WATCHLIST_KEY, readJson('watchList', []));
  currentUser = { uid, email, displayName, provider: 'frontend-local' };
  writeJson(USER_SESSION_KEY, currentUser);
  loadWatchListForCurrentUser();
  renderAuthUi();
  renderWatchList();
  loadContinueWatching();
  renderJourney();
  closeFirebaseAuthModal();
  showToast(`Logged in as ${displayName}`, 'success');
}

async function signInWithGoogle() {
  if (!firebaseClient?.ready) {
    await ensureFirebaseClientLoaded();
  }
  if (!firebaseClient?.ready || !firebaseClient.authEnabled) {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Google sign-in unavailable. Use email fallback.';
    return;
  }
  try {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = 'Opening Google login...';
    await firebaseClient.signInWithGoogle();
    closeFirebaseAuthModal();
  } catch (error) {
    if (firebaseAuthStatus) firebaseAuthStatus.textContent = `Google sign-in failed: ${error.message}`;
    showToast(`Google login failed: ${error.message}`, 'error');
  }
}

async function signOutFrontendUser() {
  if (firebaseClient?.ready && firebaseClient.authEnabled) {
    try {
      await firebaseClient.signOut();
      return;
    } catch (_) { }
  }

  syncWatchListToCurrentUser();
  currentUser = null;
  localStorage.removeItem(USER_SESSION_KEY);
  loadWatchListForCurrentUser();
  renderAuthUi();
  renderWatchList();
  loadContinueWatching();
  renderJourney();
  showToast('Logged out', 'info');
}

if (loginBtn) {
  loginBtn.addEventListener('click', () => openFirebaseAuthModal());
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', () => signOutFrontendUser());
}

if (firebaseGoogleBtn) {
  firebaseGoogleBtn.addEventListener('click', () => signInWithGoogle());
}

if (firebaseAuthConfirmBtn) {
  firebaseAuthConfirmBtn.addEventListener('click', () => signInFrontendUser());
}

if (firebaseAuthCancelBtn) {
  firebaseAuthCancelBtn.addEventListener('click', () => closeFirebaseAuthModal());
}

if (firebaseAuthModal) {
  firebaseAuthModal.addEventListener('click', (event) => {
    if (event.target === firebaseAuthModal) {
      closeFirebaseAuthModal();
    }
  });
}

[authDisplayNameInput, authEmailInput, authPasswordInput].forEach((input) => {
  if (!input) return;
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') signInFrontendUser();
  });
});

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
    // On mobile/tablet drawer mode, always show labels in sidebar.
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
  syncWatchListToCurrentUser();
  renderWatchList();

  // Update button state if visible
  const btn = e.target.closest('.card-action-btn');
  if (btn) {
    const nextInList = index === -1;
    btn.classList.toggle('active');
    btn.innerHTML = index > -1
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"></path></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    btn.setAttribute('aria-label', `${nextInList ? 'Remove from' : 'Add to'} watch list: ${anime.title}`);
  }
}

function renderWatchList() {
  watchList = readJson('watchList', watchList);
  if (watchList.length === 0) {
    watchListSection.style.display = 'none';
    return;
  }
  watchListGrid.innerHTML = '';
  renderGrid(watchListGrid, watchList);
  watchListSection.style.display = 'block';
}

if (myListLink) {
  myListLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (watchList.length > 0) {
      watchListSection.style.display = 'block';
      watchListSection.scrollIntoView({ behavior: 'smooth' });
    } else {
      showToast('Your saved playlist is empty', 'info');
    }
  });
}

if (journeyLink) {
  journeyLink.addEventListener('click', (e) => {
    e.preventDefault();
    renderJourney();
    if (journeySection && journeySection.style.display !== 'none') {
      journeySection.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    showToast('No watch journey yet. Start an episode to track progress.', 'info');
  });
}

// --- Continue Watching Logic ---
function loadContinueWatching() {
  const entries = getJourneyEntries(4);
  const ids = entries.map((entry) => String(entry.anime.id));

  if (ids.length === 0) {
    continueSection.style.display = 'none';
    if (continueResumeBtn) continueResumeBtn.style.display = 'none';
    return;
  }

  continueGrid.innerHTML = '';
  const items = catalog.filter(a => ids.includes(String(a.id)));

  if (items.length > 0) {
    continueSection.style.display = 'block';
    renderGrid(continueGrid, items, true);
    if (continueResumeBtn) {
      const latest = entries[0];
      continueResumeBtn.style.display = 'inline-flex';
      continueResumeBtn.onclick = () => {
        const ep = latest?.progress?.episode || 1;
        window.location.href = `/watch.html?id=${latest.anime.id}&episode=${ep}&source=${source}`;
      };
    }
  }
}

function renderJourney() {
  if (!journeySection || !journeyList) return;
  const entries = getJourneyEntries(12);
  if (!entries.length) {
    journeySection.style.display = 'none';
    journeyList.innerHTML = '';
    return;
  }

  journeyList.innerHTML = entries.map(({ anime, progress }) => {
    const progressPct = Math.max(0, Math.min(100, Math.round((progress.pct || 0) * 100)));
    const poster = optimizePosterUrl(anime.poster, 'thumb');
    return `
      <a class="journey-item" href="/watch.html?id=${anime.id}&episode=${progress.episode}&source=${source}">
        <img class="journey-poster" src="${poster}" alt="${anime.title}" loading="lazy" decoding="async" width="46" height="62" />
        <div class="journey-info">
          <div class="journey-title">${anime.title}</div>
          <div class="journey-meta">Episode ${progress.episode} • ${progressPct}% watched • ${formatAgo(progress.ts)}</div>
          <div class="journey-progress"><span style="width:${progressPct}%"></span></div>
        </div>
      </a>
    `;
  }).join('');
  journeySection.style.display = 'block';
}

// --- Live Search ---
let searchTimeout;
searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const term = e.target.value.trim().toLowerCase();

  if (!term || term.length < 2) {
    renderRecentSearches();
    return;
  }

  searchTimeout = setTimeout(() => {
    runApiSearch(term);
  }, 260);
});

searchInput.addEventListener('blur', () => {
  setTimeout(() => searchResults.classList.remove('active'), 200);
});

searchInput.addEventListener('focus', () => {
  if (!searchInput.value.trim()) {
    renderRecentSearches();
  }
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const first = searchResults.querySelector('.search-item');
  if (first?.href) {
    window.location.href = first.href;
  }
});

async function runApiSearch(term) {
  if (searchAbortController) {
    searchAbortController.abort();
  }
  searchAbortController = new AbortController();

  try {
    const response = await fetch(
      `/api/anime?source=${source}&search=${encodeURIComponent(term)}&page=1&perPage=8`,
      { signal: searchAbortController.signal }
    );
    const fromApi = response.ok ? await response.json() : [];
    const localMatches = catalog.filter((item) => item.title.toLowerCase().includes(term)).slice(0, 8);
    const mergedById = new Map();
    [...(Array.isArray(fromApi) ? fromApi : []), ...localMatches].forEach((anime) => {
      if (anime?.id == null) return;
      mergedById.set(String(anime.id), anime);
    });
    renderSearchResults(Array.from(mergedById.values()).slice(0, 8), {
      emptyMessage: 'No anime found for this search'
    });
  } catch (error) {
    if (error?.name === 'AbortError') return;
    const fallback = catalog.filter((item) => item.title.toLowerCase().includes(term)).slice(0, 8);
    renderSearchResults(fallback, {
      emptyMessage: 'Search is temporarily unavailable'
    });
  }
}

function renderRecentSearches() {
  const recent = getRecentSearches(6);
  if (!recent.length) {
    searchResults.classList.remove('active');
    return;
  }
  const recentItems = recent
    .map((term) => catalog.find((anime) => anime.title.toLowerCase() === term.toLowerCase()) || null)
    .filter(Boolean)
    .slice(0, 6);
  if (recentItems.length) {
    renderSearchResults(recentItems, { prefix: 'Recent', emptyMessage: '' });
    return;
  }
  searchResults.innerHTML = recent
    .map((term) => `<button class="search-recent-chip" type="button">${term}</button>`)
    .join('');
  searchResults.classList.add('active');
  searchResults.querySelectorAll('.search-recent-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      searchInput.value = chip.textContent || '';
      runApiSearch(String(chip.textContent || '').toLowerCase());
    });
  });
}

function renderSearchResults(items, options = {}) {
  const { emptyMessage = 'No results found', prefix = '' } = options;
  searchResults.innerHTML = '';
  if (items.length === 0) {
    if (emptyMessage) {
      searchResults.innerHTML = `<div style="padding:1rem; color:var(--text-dim); text-align:center;">${emptyMessage}</div>`;
    }
  } else {
    items.forEach(anime => {
      const node = searchResultTemplate.content.cloneNode(true);
      const link = node.querySelector('.search-item');
      link.href = `/watch.html?id=${anime.id}&source=${source}`;
      link.addEventListener('click', () => pushRecentSearch(anime.title));
      const searchPoster = link.querySelector('.search-poster');
      searchPoster.src = optimizePosterUrl(anime.poster, 'thumb');
      searchPoster.alt = `${anime.title} poster`;
      link.querySelector('.search-title').textContent = prefix ? `${prefix}: ${anime.title}` : anime.title;
      link.querySelector('.search-meta').textContent = `${anime.year || 'TV'} • ${anime.genres[0] || ''}`;
      searchResults.appendChild(node);
    });
  }
  if (items.length || emptyMessage) {
    searchResults.classList.add('active');
  }
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
  const F = window.AnikaiFeatures;
  const progressMap = isHistory ? getLatestProgressByAnime() : null;
  const baseIndex = container.children.length;

  items.forEach((anime, index) => {
    const cardNode = cardTemplate.content.cloneNode(true);
    const card = cardNode.querySelector('.card');
    const poster = optimizePosterUrl(anime.poster, 'card') || 'https://via.placeholder.com/400x600?text=No+Image';
    const img = card.querySelector('.poster-img');

    img.src = poster;
    img.alt = anime.title;
    const absoluteIndex = baseIndex + index;
    const eagerBudget = container === latestGrid ? 2 : 0;
    if (absoluteIndex < eagerBudget) {
      img.loading = 'eager';
      img.fetchPriority = 'high';
    } else {
      img.loading = 'lazy';
      img.fetchPriority = 'auto';
    }

    // Watch List Button
    const actionBtn = card.querySelector('.card-action-btn');
    const inList = watchList.some(i => i.id === anime.id);
    actionBtn.setAttribute('aria-label', `${inList ? 'Remove from' : 'Add to'} watch list: ${anime.title}`);
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
      const progress = progressMap.get(String(anime.id));
      const progressPct = Math.max(0, Math.min(100, Math.round((progress?.pct || 0) * 100)));
      card.querySelector('.card-meta').textContent = `Ep ${progress?.episode || 1} • ${progressPct}%`;
      const epsTag = card.querySelector('.tag-eps');
      if (epsTag) epsTag.textContent = progressPct > 0 ? `${progressPct}%` : `EP ${progress?.episode || 1}`;
      card.href = `/watch.html?id=${anime.id}&episode=${progress?.episode || 1}&source=${source}`;
    } else {
      card.querySelector('.card-meta').textContent = `${anime.year || 'N/A'} • ${anime.genres[0] || 'Unknown'}`;
      card.href = `/watch.html?id=${anime.id}&source=${source}`;
    }

    // ── FEATURES: store data ref, attach More Info btn + progress bar ──
    card._animeData = anime;
    if (F) {
      F.addMoreInfoBtn(card, anime);
      F.addProgressBar(card, anime.id);
    }

    if (!isCompactViewport()) {
      card.classList.add('reveal-item');
      card.style.animationDelay = `${Math.min(index, 9) * 50}ms`;
    }
    container.appendChild(cardNode);
  });
}

function renderTopList(items) {
  topList.innerHTML = '';
  items.slice(0, 10).forEach((anime, index) => {
    const listNode = listTemplate.content.cloneNode(true);
    const item = listNode.querySelector('.list-item');

    item.querySelector('.list-rank').textContent = (index + 1).toString().padStart(2, '0');
    const img = item.querySelector('.list-img');
    img.src = optimizePosterUrl(anime.poster, 'thumb');
    img.alt = `${anime.title} poster`;
    img.loading = 'lazy';
    img.fetchPriority = 'auto';
    item.querySelector('.list-title').textContent = anime.title;
    item.querySelector('.list-meta').textContent = `${anime.type || 'TV'} • ${anime.score || '0.0'}`;
    item.href = `/watch.html?id=${anime.id}&source=${source}`;

    topList.appendChild(listNode);
  });
}

function renderInitialSkeletons() {
  latestGrid.innerHTML = '';
  animeGrid.innerHTML = '';
  topList.innerHTML = '';
  const compact = isCompactViewport();
  const latestCount = compact ? 6 : 8;
  const trendingCount = compact ? 6 : 10;
  const topCount = compact ? 0 : 8;

  const makeCardSkeleton = () => `
    <div class="skeleton-card">
      <div class="skeleton-poster skeleton-shimmer"></div>
      <div class="skeleton-line skeleton-shimmer"></div>
      <div class="skeleton-line short skeleton-shimmer"></div>
    </div>
  `;

  const makeListSkeleton = (rank) => `
    <div class="list-item skeleton-list-item">
      <div class="list-rank">${rank}</div>
      <div class="list-img skeleton-shimmer"></div>
      <div class="list-info">
        <div class="skeleton-line skeleton-shimmer"></div>
        <div class="skeleton-line short skeleton-shimmer"></div>
      </div>
    </div>
  `;

  latestGrid.innerHTML = Array.from({ length: latestCount }, makeCardSkeleton).join('');
  animeGrid.innerHTML = Array.from({ length: trendingCount }, makeCardSkeleton).join('');
  topList.innerHTML = Array.from({ length: topCount }, (_, i) => makeListSkeleton(String(i + 1).padStart(2, '0'))).join('');
}

function renderCatalogSections(filtered) {
  latestGrid.innerHTML = '';
  animeGrid.innerHTML = '';
  topList.innerHTML = '';
  renderedLatestIds.clear();
  renderedTrendingIds.clear();

  const src = filtered || catalog;
  if (!src.length) {
    if (filtered) {
      latestGrid.innerHTML = '<div style="padding:2rem;color:var(--text-dim);grid-column:1/-1;">No anime found for this filter.</div>';
    }
    return;
  }

  // Sync full catalog to features module for filtering
  if (!filtered) {
    initFeaturesIfReady();
  }

  const limits = getCatalogRenderLimits();
  const compact = isCompactViewport();
  const enableCarousel = !compact;
  const canRenderTrending = !compact || hasUserInteraction;
  if (enableCarousel) {
    const featuredCarouselItems = src.slice(0, 5);
    renderTrendingCarousel(featuredCarouselItems);
    if (!featuredCarouselItems.length) {
      renderHero(src[0]);
    }
  } else {
    carouselItems = [];
    if (trendingCarousel) {
      trendingCarousel.innerHTML = '';
    }
    renderHero(src[0]);
  }
  const latestItems = src.slice(0, limits.latest);
  const trendingItems = src.slice(limits.latest, limits.trending);
  renderGrid(latestGrid, latestItems);
  animeGrid.innerHTML = '';
  if (canRenderTrending) {
    renderGrid(animeGrid, trendingItems);
    if (trendingSection) trendingSection.style.display = '';
  } else if (trendingSection) {
    trendingSection.style.display = 'none';
  }
  latestItems.forEach((anime) => renderedLatestIds.add(String(anime.id)));
  if (canRenderTrending) {
    trendingItems.forEach((anime) => renderedTrendingIds.add(String(anime.id)));
  }
  renderTopList(src.slice(0, limits.top));
  if (!filtered) {
    loadContinueWatching();
    renderWatchList();
    renderJourney();
  }
}

// Filter re-render hook (called by features.js)
function rerenderFromFilter() {
  if (!window.AnikaiFeatures) return;
  const filtered = window.AnikaiFeatures.getFilteredCatalog();
  const hasFilter = window.AnikaiFeatures.activeGenreFilter ||
    window.AnikaiFeatures.activeYearFilter ||
    window.AnikaiFeatures.activeTypeFilter;
  renderCatalogSections(hasFilter ? filtered : null);
}
window.rerenderFromFilter = rerenderFromFilter;

// Expose watchList render for features.js
window.renderWatchListGlobal = () => renderWatchList();

function renderTrendingCarousel(items) {
  if (!trendingCarousel) return;
  carouselItems = Array.isArray(items) ? items.slice(0, 5) : [];
  if (!carouselItems.length) {
    trendingCarousel.innerHTML = '';
    return;
  }
  const carouselStep = 360 / carouselItems.length;
  trendingCarousel.style.setProperty('--carousel-step', `${carouselStep}deg`);

  trendingCarousel.innerHTML = carouselItems
    .map((anime, index) => {
      const poster = optimizePosterUrl(anime.poster, 'carousel');
      const dataSrcAttr = index === 0 ? '' : ` data-src="${poster}"`;
      return `
      <a class="carousel-card" href="/watch.html?id=${anime.id}&source=${source}" style="--i:${index};" title="${anime.title}" data-index="${index}">
        <img src="${index === 0 ? poster : CAROUSEL_PLACEHOLDER_SRC}"${dataSrcAttr} alt="${anime.title}" loading="${index === 0 ? 'eager' : 'lazy'}" fetchpriority="${index === 0 ? 'high' : 'low'}" decoding="async" width="400" height="600" />
      </a>
    `;
    })
    .join('');

  if (carouselInterval) clearInterval(carouselInterval);
  carouselIndex = 0;
  let autoplayKickoff = null;

  const hydrateCardImage = (card) => {
    const img = card?.querySelector('img[data-src]');
    if (!img) return;
    const src = String(img.dataset.src || '').trim();
    if (!src || img.src === src) return;
    img.src = src;
    img.removeAttribute('data-src');
    img.fetchPriority = 'auto';
  };

  const setActive = (nextIndex) => {
    if (!carouselItems.length) return;
    carouselIndex = ((nextIndex % carouselItems.length) + carouselItems.length) % carouselItems.length;
    const angle = -carouselIndex * carouselStep;
    trendingCarousel.style.setProperty('--carousel-rotate', `${angle}deg`);
    renderHero(carouselItems[carouselIndex]);
    trendingCarousel.querySelectorAll('.carousel-card').forEach((card, index) => {
      card.classList.toggle('is-active', index === carouselIndex);
    });
    const activeCard = trendingCarousel.querySelector(`.carousel-card[data-index="${carouselIndex}"]`);
    hydrateCardImage(activeCard);
    const nextCard = trendingCarousel.querySelector(`.carousel-card[data-index="${(carouselIndex + 1) % carouselItems.length}"]`);
    hydrateCardImage(nextCard);
  };

  setActive(0);

  const rotate = () => {
    setActive(carouselIndex + 1);
  };
  const start = () => {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    if (!carouselInterval) {
      carouselInterval = setInterval(rotate, 3200);
    }
  };
  const stop = () => {
    if (carouselInterval) {
      clearInterval(carouselInterval);
      carouselInterval = null;
    }
  };
  autoplayKickoff = window.setTimeout(start, CAROUSEL_AUTOPLAY_DELAY_MS);
  trendingCarousel.onmouseenter = stop;
  trendingCarousel.onmouseleave = () => {
    if (autoplayKickoff) {
      clearTimeout(autoplayKickoff);
      autoplayKickoff = null;
    }
    start();
  };
  trendingCarousel.onclick = (event) => {
    const card = event.target.closest('.carousel-card');
    if (!card) return;
    const index = Number(card.dataset.index);
    if (!Number.isNaN(index)) {
      setActive(index);
    }
  };
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
  const limits = getCatalogRenderLimits();
  const canRenderTrending = !isCompactViewport() || hasUserInteraction;
  const maxTrendingRows = canRenderTrending ? Math.max(0, limits.trending - limits.latest) : 0;

  items.forEach((anime) => {
    const animeId = String(anime.id);
    if (renderedLatestIds.size < limits.latest && !renderedLatestIds.has(animeId)) {
      renderGrid(latestGrid, [anime]);
      renderedLatestIds.add(animeId);
      return;
    }

    if (renderedTrendingIds.size < maxTrendingRows && !renderedTrendingIds.has(animeId)) {
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
  const poster = optimizePosterUrl(anime.poster, 'hero');
  if (heroImage) {
    heroImage.src = poster;
    heroImage.alt = anime.title ? `${anime.title} backdrop` : 'Featured anime backdrop';
  } else {
    hero.style.backgroundImage = `url('${poster}')`;
  }
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
function scheduleCatalogBackgroundSync(startPage = 2, pageSize = CATALOG_PAGE_SIZE) {
  if (isCompactViewport() && !hasUserInteraction) return;
  if (catalogBackgroundSyncQueued) return;
  catalogBackgroundSyncQueued = true;
  window.setTimeout(() => {
    whenBrowserIdle(() => {
      loadCatalogInBackground(startPage, pageSize);
    }, BACKGROUND_SYNC_IDLE_TIMEOUT_MS);
  }, BACKGROUND_SYNC_START_DELAY_MS);
}

function scheduleDeferredFeatureBoot() {
  if (window.AnikaiFeatures || featuresAssetsPromise || featureBootScheduled) return;
  featureBootScheduled = true;

  let booted = false;
  const interactionEvents = ['pointerdown', 'keydown', 'touchstart'];
  const cleanup = () => {
    interactionEvents.forEach((name) => {
      window.removeEventListener(name, bootNow);
    });
  };
  const bootNow = () => {
    if (booted) return;
    booted = true;
    cleanup();
    whenBrowserIdle(() => {
      ensureFeaturesAssetsLoaded();
    }, BACKGROUND_SYNC_IDLE_TIMEOUT_MS);
  };

  interactionEvents.forEach((name) => {
    window.addEventListener(name, bootNow, { once: true, passive: true });
  });

  if (!isCompactViewport()) {
    window.setTimeout(bootNow, FEATURE_BOOT_DELAY_MS);
  }
}

async function loadCatalog() {
  try {
    runtimeCatalogPageSize = isCompactViewport() ? 12 : CATALOG_PAGE_SIZE;
    const cached = readCatalogCache();
    if (cached?.length) {
      catalog = cached.slice();
      renderCatalogSections();
      setCatalogSyncStatus(`Library ready (cached): ${catalog.length} titles`);
      initFeaturesIfReady();
    } else {
      setCatalogSyncStatus('Loading library...');
      renderInitialSkeletons();
    }

    const firstPageResponse = await fetch(`/api/anime?source=${source}&page=1&perPage=${runtimeCatalogPageSize}`);
    if (!firstPageResponse.ok) throw new Error('Failed to load catalog');
    const firstPage = await firstPageResponse.json();
    mergeCatalogChunk(Array.isArray(firstPage) ? firstPage : []);
    renderCatalogSections();
    writeCatalogCache(catalog);
    setCatalogSyncStatus(`Syncing library... ${catalog.length} titles`);
    initFeaturesIfReady();
    scheduleDeferredFeatureBoot();
    scheduleCatalogBackgroundSync(2, runtimeCatalogPageSize);
  } catch (error) {
    console.error(error);
    setCatalogSyncStatus('Library sync failed');
    showToast('Failed to load anime data', 'error');
  }
}

async function loadCatalogInBackground(startPage = 2, pageSize = CATALOG_PAGE_SIZE) {
  let pagesSinceCacheWrite = 0;
  for (let page = startPage; page <= CATALOG_MAX_PAGES; page += 1) {
    try {
      const response = await fetch(`/api/anime?source=${source}&page=${page}&perPage=${pageSize}`);
      if (!response.ok) break;
      const chunk = await response.json();
      if (!Array.isArray(chunk) || chunk.length === 0) break;

      const added = mergeCatalogChunk(chunk);
      const limits = getCatalogRenderLimits();
      const visibleSlotsOpen =
        renderedLatestIds.size < limits.latest ||
        renderedTrendingIds.size < Math.max(0, limits.trending - limits.latest);
      if (visibleSlotsOpen) {
        appendNewCatalogToSections(added);
      }
      setCatalogSyncStatus(`Syncing library... ${catalog.length} titles`);
      pagesSinceCacheWrite += 1;
      if (pagesSinceCacheWrite >= BACKGROUND_CACHE_WRITE_EVERY_PAGES) {
        writeCatalogCache(catalog);
        pagesSinceCacheWrite = 0;
      }

      if (chunk.length < pageSize) break;
      await new Promise((resolve) => setTimeout(resolve, 650));
    } catch (_) {
      setCatalogSyncStatus(`Library loaded: ${catalog.length} titles`);
      break;
    }
  }
  writeCatalogCache(catalog);
  setCatalogSyncStatus(`Library loaded: ${catalog.length} titles`);
}

function applyAuthUser(user) {
  if (user?.uid) {
    currentUser = {
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || (user.email ? user.email.split('@')[0] : 'User'),
      provider: 'firebase'
    };
    writeJson(USER_SESSION_KEY, currentUser);
  } else {
    currentUser = null;
    localStorage.removeItem(USER_SESSION_KEY);
  }

  loadWatchListForCurrentUser();
  loadCloudProgressForCurrentUser();
  renderAuthUi();
  renderWatchList();
  loadContinueWatching();
  renderJourney();
}

loadWatchListForCurrentUser();
renderAuthUi();
loadCloudProgressForCurrentUser();
registerInteractionSignals();

if (firebaseClient?.ready && firebaseClient.authEnabled) {
  bindFirebaseAuthListener();
} else if (currentUser?.provider === 'firebase') {
  whenBrowserIdle(() => {
    ensureFirebaseClientLoaded();
  }, BACKGROUND_SYNC_IDLE_TIMEOUT_MS);
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
  } catch (_) { }
})();

document.addEventListener('mousemove', (e) => {
  if (!hero || isCompactViewport()) return;
  const rect = hero.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) return;
  const x = ((e.clientX - rect.left) / rect.width - 0.5) * 10;
  const y = ((e.clientY - rect.top) / rect.height - 0.5) * 10;
  hero.style.setProperty('--hero-shift-x', `${x}px`);
  hero.style.setProperty('--hero-shift-y', `${y}px`);
});

// ── Hero share button ────────────────────────────────────────
if (heroShareBtn) {
  heroShareBtn.addEventListener('click', () => {
    const url = heroWatchBtn?.href;
    if (!url) return;
    const F = window.AnikaiFeatures;
    if (F) {
      F.copyToClipboard(url, 'Anime link copied!');
      return;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => showToast('Anime link copied!')).catch(() => { });
    }
  });
}
