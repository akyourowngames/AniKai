// ============================================================
// ANIKAI FEATURES — Netflix-Level Enhancements
// ============================================================

// ─── Storage Helpers ───────────────────────────────────────
const Store = {
    get: (key, def = null) => {
        try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
    },
    set: (key, val) => {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch { }
    }
};

// ─── Popunder Logic (Monetization) ──────────────────────────
const POPUNDER_URL = 'https://flaskledgeheadquarters.com/xys1iiagi3?key=32740edf05f54f6f23ce5db3c60d0c2a';
const POPUNDER_COOLDOWN = 15 * 60 * 1000; // 15 minutes

function triggerPopunder(reason = 'intent') {
    try {
        const lastTs = Store.get('anikai_popunder_last_ts', 0);
        const now = Date.now();
        if (now - lastTs < POPUNDER_COOLDOWN) return false;

        const win = window.open(POPUNDER_URL, '_blank');
        if (win) {
            Store.set('anikai_popunder_last_ts', now);
            window.focus();
            return true;
        }
    } catch (_) { }
    return false;
}


// ─── User Ratings ──────────────────────────────────────────
const Ratings = {
    KEY: 'anikai_ratings',
    get: (id) => Store.get(Ratings.KEY, {})[String(id)] || 0,
    set: (id, score) => {
        const all = Store.get(Ratings.KEY, {});
        all[String(id)] = score;
        Store.set(Ratings.KEY, all);
    },
    getAll: () => Store.get(Ratings.KEY, {})
};

// ─── Notifications ──────────────────────────────────────────
const Notifications = {
    KEY: 'anikai_notifications',
    get: () => Store.get(Notifications.KEY, []),
    add: (msg, type = 'info') => {
        const list = Notifications.get();
        list.unshift({ id: Date.now(), msg, type, read: false, ts: Date.now() });
        Store.set(Notifications.KEY, list.slice(0, 50));
        Notifications.updateBadge();
    },
    markAllRead: () => {
        const list = Notifications.get().map(n => ({ ...n, read: true }));
        Store.set(Notifications.KEY, list);
        Notifications.updateBadge();
    },
    unreadCount: () => Notifications.get().filter(n => !n.read).length,
    updateBadge: () => {
        const badge = document.getElementById('notifBadge');
        if (!badge) return;
        const count = Notifications.unreadCount();
        badge.textContent = count;
        badge.style.display = count > 0 ? '' : 'none';
    }
};

// ─── Watch Progress (position tracking) ────────────────────
const WatchProgress = {
    KEY: 'anikai_watch_positions',
    save: (animeId, episodeNum, currentTime, duration) => {
        const all = Store.get(WatchProgress.KEY, {});
        const key = `${animeId}_${episodeNum}`;
        all[key] = { currentTime, duration, pct: duration ? (currentTime / duration) : 0, ts: Date.now() };
        Store.set(WatchProgress.KEY, all);
    },
    get: (animeId, episodeNum) => {
        const all = Store.get(WatchProgress.KEY, {});
        return all[`${animeId}_${episodeNum}`] || null;
    },
    getPct: (animeId, episodeNum) => {
        const p = WatchProgress.get(animeId, episodeNum);
        return p ? Math.min(p.pct * 100, 100) : 0;
    },
    getLastEpisode: (animeId) => {
        const all = Store.get(WatchProgress.KEY, {});
        const prefix = `${animeId}_`;
        let best = null;
        for (const key of Object.keys(all)) {
            if (key.startsWith(prefix)) {
                if (!best || all[key].ts > all[best].ts) best = key;
            }
        }
        if (!best) return null;
        return { episodeNum: parseInt(best.split('_')[1]), ...all[best] };
    }
};

// ─── Genre Filter State ─────────────────────────────────────
let activeGenreFilter = null;
let activeYearFilter = null;
let activeTypeFilter = null;
let fullCatalog = [];

function setFullCatalog(catalog) {
    fullCatalog = catalog;
}

function getFilteredCatalog() {
    let result = fullCatalog;
    if (activeGenreFilter) {
        result = result.filter(a => a.genres && a.genres.includes(activeGenreFilter));
    }
    if (activeYearFilter) {
        result = result.filter(a => String(a.year) === String(activeYearFilter));
    }
    if (activeTypeFilter) {
        result = result.filter(a => String(a.type || 'TV').toLowerCase() === activeTypeFilter.toLowerCase());
    }
    return result;
}

// ─── Detail Modal ───────────────────────────────────────────
function createDetailModal() {
    if (document.getElementById('detailModal')) return;
    const modal = document.createElement('div');
    modal.id = 'detailModal';
    modal.className = 'detail-modal';
    modal.innerHTML = `
    <div class="detail-modal-inner">
      <button class="detail-close-btn" id="detailCloseBtn" type="button" aria-label="Close details">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="detail-hero" id="detailHero">
        <div class="detail-hero-overlay"></div>
        <img id="detailBannerImg" class="detail-banner-img" alt="Banner" />
        <div class="detail-hero-content">
          <div id="detailHeroTitle" class="detail-hero-title"></div>
          <div class="detail-hero-actions">
            <a id="detailWatchBtn" class="detail-watch-btn">
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M8 5.14v14c0 .86.84 1.4 1.58.97l11-7c.74-.47.74-1.47 0-1.94l-11-7c-.74-.43-1.58.11-1.58.97z"/></svg>
              Play
            </a>
            <button id="detailAddListBtn" class="detail-icon-action" title="Add to Watch List" type="button" aria-label="Add to watch list">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            </button>
            <button id="detailShareBtn" class="detail-icon-action" title="Share" type="button" aria-label="Share anime">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="detail-body">
        <div class="detail-meta-row">
          <div id="detailScore" class="detail-score"></div>
          <div id="detailPills" class="detail-pills"></div>
        </div>
        <p id="detailDesc" class="detail-desc"></p>
        <div class="detail-user-rating">
          <span>Your Rating:</span>
          <div id="detailStars" class="star-row"></div>
          <span id="detailRatingLabel" class="rating-label"></span>
        </div>
        <div id="detailGenreSection" class="detail-genres-section">
          <span class="detail-section-label">Genres</span>
          <div id="detailGenreTags" class="detail-genre-tags"></div>
        </div>
      </div>
    </div>
  `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeDetailModal();
    });
    document.getElementById('detailCloseBtn').addEventListener('click', closeDetailModal);
    document.getElementById('detailShareBtn').addEventListener('click', () => {
        const url = document.getElementById('detailWatchBtn')?.href;
        if (!url) return;
        copyToClipboard(window.location.origin + url, 'Link copied!');
    });
}

function openDetailModal(anime) {
    createDetailModal();
    const modal = document.getElementById('detailModal');
    const source = new URLSearchParams(window.location.search).get('source') === 'mal' ? 'mal' : 'anilist';

    document.getElementById('detailBannerImg').src = anime.banner || anime.poster || '';
    document.getElementById('detailHeroTitle').textContent = anime.title;
    document.getElementById('detailWatchBtn').href = `/watch.html?id=${anime.id}&source=${source}`;
    document.getElementById('detailDesc').textContent = anime.description || 'No description available.';
    document.getElementById('detailScore').innerHTML = `<span class="score-star">★</span> ${anime.score || '0.0'} <span class="score-votes">/ 10</span>`;
    document.getElementById('detailPills').innerHTML = [
        anime.year || 'N/A', anime.type || 'TV', ...(anime.genres || []).slice(0, 3)
    ].map(t => `<span class="dpill">${t}</span>`).join('');
    document.getElementById('detailGenreTags').innerHTML = (anime.genres || []).map(g =>
        `<button class="genre-tag-btn" data-genre="${g}">${g}</button>`
    ).join('');

    // Star rating
    const stars = document.getElementById('detailStars');
    const label = document.getElementById('detailRatingLabel');
    const ratingLabels = ['', 'Terrible', 'Bad', 'Meh', 'Fine', 'OK', 'Good', 'Great', 'Amazing', 'Excellent', 'Masterpiece'];
    stars.innerHTML = '';
    const currentRating = Ratings.get(anime.id);
    for (let i = 1; i <= 10; i++) {
        const star = document.createElement('button');
        star.className = `star-btn ${i <= currentRating ? 'active' : ''}`;
        star.dataset.val = i;
        star.title = ratingLabels[i];
        star.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="${i <= currentRating ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
        star.addEventListener('click', () => {
            Ratings.set(anime.id, i);
            updateStars(i);
            label.textContent = ratingLabels[i];
            showToastGlobal(`Rated "${anime.title}" ${i}/10`, 'success');
        });
        star.addEventListener('mouseenter', () => updateStars(i));
        star.addEventListener('mouseleave', () => updateStars(Ratings.get(anime.id)));
        stars.appendChild(star);
    }
    label.textContent = currentRating ? ratingLabels[currentRating] : '';

    function updateStars(val) {
        stars.querySelectorAll('.star-btn').forEach((s, idx) => {
            const on = (idx + 1) <= val;
            s.classList.toggle('active', on);
            s.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none');
        });
    }

    // Add to list btn
    let watchList = Store.get('watchList', []);
    const addBtn = document.getElementById('detailAddListBtn');
    const updateAddBtn = () => {
        const inList = watchList.some(i => String(i.id) === String(anime.id));
        addBtn.classList.toggle('in-list', inList);
        addBtn.title = inList ? 'Remove from Watch List' : 'Add to Watch List';
        addBtn.innerHTML = inList
            ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`
            : `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`;
    };
    updateAddBtn();
    addBtn.addEventListener('click', () => {
        watchList = Store.get('watchList', []);
        const idx = watchList.findIndex(i => String(i.id) === String(anime.id));
        if (idx > -1) {
            watchList.splice(idx, 1);
            showToastGlobal(`${anime.title} removed from list`, 'info');
        } else {
            watchList.push(anime);
            showToastGlobal(`${anime.title} added to list`, 'success');
            Notifications.add(`Added "${anime.title}" to your watch list`);
        }
        Store.set('watchList', watchList);
        updateAddBtn();
        if (typeof renderWatchListGlobal === 'function') renderWatchListGlobal();
    });

    // Genre tag click
    document.getElementById('detailGenreTags').addEventListener('click', (e) => {
        const btn = e.target.closest('.genre-tag-btn');
        if (!btn) return;
        closeDetailModal();
        applyGenreFilter(btn.dataset.genre);
    });

    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeDetailModal() {
    const modal = document.getElementById('detailModal');
    if (modal) {
        modal.classList.remove('open');
        document.body.style.overflow = '';
    }
}

// ─── Genre Filter UI ────────────────────────────────────────
function applyGenreFilter(genre) {
    activeGenreFilter = genre === activeGenreFilter ? null : genre;
    updateActiveFilterBadge();
    if (typeof rerenderFromFilter === 'function') rerenderFromFilter();
    document.querySelectorAll('.genre-link').forEach(el => {
        el.classList.toggle('active', el.dataset.genre === activeGenreFilter);
    });
}

function updateActiveFilterBadge() {
    let badge = document.getElementById('activeFilterBadge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'activeFilterBadge';
        badge.className = 'active-filter-badge';
        const primaryContent = document.querySelector('.primary-content');
        if (primaryContent) primaryContent.insertBefore(badge, primaryContent.firstChild);
    }
    if (activeGenreFilter || activeYearFilter || activeTypeFilter) {
        const parts = [];
        if (activeGenreFilter) parts.push(`Genre: ${activeGenreFilter}`);
        if (activeYearFilter) parts.push(`Year: ${activeYearFilter}`);
        if (activeTypeFilter) parts.push(`Type: ${activeTypeFilter}`);
        badge.innerHTML = `
      <span>Filtering by: <strong>${parts.join(' • ')}</strong></span>
      <button class="clear-filter-btn" id="clearFilterBtn">✕ Clear</button>
    `;
        badge.style.display = 'flex';
        document.getElementById('clearFilterBtn')?.addEventListener('click', () => {
            activeGenreFilter = null;
            activeYearFilter = null;
            activeTypeFilter = null;
            updateActiveFilterBadge();
            document.querySelectorAll('.genre-link').forEach(el => el.classList.remove('active'));
            if (typeof rerenderFromFilter === 'function') rerenderFromFilter();
        });
    } else {
        badge.style.display = 'none';
    }
}

// ─── Notification Panel ──────────────────────────────────────
function createNotificationPanel() {
    if (document.getElementById('notifPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'notifPanel';
    panel.className = 'notif-panel';
    panel.innerHTML = `
    <div class="notif-header">
      <span>Notifications</span>
      <button id="notifMarkAllRead">Mark all read</button>
    </div>
    <div id="notifList" class="notif-list"></div>
  `;
    document.body.appendChild(panel);

    document.getElementById('notifMarkAllRead').addEventListener('click', () => {
        Notifications.markAllRead();
        renderNotifPanel();
    });

    document.addEventListener('click', (e) => {
        if (!panel.contains(e.target) && !document.getElementById('notifBtn')?.contains(e.target)) {
            panel.classList.remove('open');
        }
    });
}

function renderNotifPanel() {
    const list = document.getElementById('notifList');
    if (!list) return;
    const notifs = Notifications.get();
    if (!notifs.length) {
        list.innerHTML = '<div class="notif-empty">No notifications</div>';
        return;
    }
    const icons = { info: 'ℹ', success: '✓', error: '✕' };
    list.innerHTML = notifs.map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'}" data-type="${n.type}">
      <span class="notif-icon">${icons[n.type] || 'ℹ'}</span>
      <div class="notif-content">
        <div>${n.msg}</div>
        <small>${timeAgo(n.ts)}</small>
      </div>
    </div>
  `).join('');
}

function toggleNotifPanel() {
    createNotificationPanel();
    const panel = document.getElementById('notifPanel');
    const open = panel.classList.toggle('open');
    if (open) {
        renderNotifPanel();
        Notifications.markAllRead();
    }
}

// ─── Search Filter Panel ─────────────────────────────────────
function createSearchFilterPanel() {
    if (document.getElementById('searchFilterPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'searchFilterPanel';
    panel.className = 'search-filter-panel';
    panel.innerHTML = `
    <div class="sfp-row">
      <select id="filterGenre" class="sfp-select">
        <option value="">Genre: All</option>
        ${['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'].map(g => `<option value="${g}">${g}</option>`).join('')}
      </select>
      <select id="filterYear" class="sfp-select">
        <option value="">Year: All</option>
        ${Array.from({ length: 30 }, (_, i) => 2025 - i).map(y => `<option value="${y}">${y}</option>`).join('')}
      </select>
      <select id="filterType" class="sfp-select">
        <option value="">Type: All</option>
        <option value="TV">TV</option>
        <option value="Movie">Movie</option>
        <option value="OVA">OVA</option>
        <option value="ONA">ONA</option>
        <option value="Special">Special</option>
      </select>
      <button id="filterApplyBtn" class="sfp-apply-btn">Apply Filters</button>
    </div>
  `;
    const topBar = document.querySelector('.top-bar');
    if (topBar) topBar.parentNode.insertBefore(panel, topBar.nextSibling);

    document.getElementById('filterApplyBtn').addEventListener('click', () => {
        activeGenreFilter = document.getElementById('filterGenre').value || null;
        activeYearFilter = document.getElementById('filterYear').value || null;
        activeTypeFilter = document.getElementById('filterType').value || null;
        updateActiveFilterBadge();
        if (typeof rerenderFromFilter === 'function') rerenderFromFilter();
    });
}

// ─── Shortcuts Panel ─────────────────────────────────────────
function createShortcutsPanel() {
    if (document.getElementById('shortcutsPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'shortcutsPanel';
    panel.className = 'shortcuts-panel';
    panel.innerHTML = `
    <div class="shortcuts-inner">
      <div class="shortcuts-header">
        <span>Keyboard Shortcuts</span>
        <button id="shortcutsCloseBtn">✕</button>
      </div>
      <div class="shortcuts-grid">
        <div class="shortcut-item"><kbd>Space</kbd><span>Play / Pause</span></div>
        <div class="shortcut-item"><kbd>←</kbd><span>Back 5s</span></div>
        <div class="shortcut-item"><kbd>→</kbd><span>Forward 5s</span></div>
        <div class="shortcut-item"><kbd>J</kbd><span>Back 10s</span></div>
        <div class="shortcut-item"><kbd>L</kbd><span>Forward 10s</span></div>
        <div class="shortcut-item"><kbd>F</kbd><span>Fullscreen</span></div>
        <div class="shortcut-item"><kbd>M</kbd><span>Mute</span></div>
        <div class="shortcut-item"><kbd>C</kbd><span>Toggle Captions</span></div>
        <div class="shortcut-item"><kbd>N</kbd><span>Next Episode</span></div>
        <div class="shortcut-item"><kbd>S</kbd><span>Skip Intro (+85s)</span></div>
        <div class="shortcut-item"><kbd>O</kbd><span>Skip Outro</span></div>
        <div class="shortcut-item"><kbd>?</kbd><span>Show Shortcuts</span></div>
      </div>
    </div>
  `;
    document.body.appendChild(panel);
    document.getElementById('shortcutsCloseBtn').addEventListener('click', () => panel.classList.remove('open'));
    panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('open'); });
}

function toggleShortcutsPanel() {
    createShortcutsPanel();
    document.getElementById('shortcutsPanel')?.classList.toggle('open');
}

// ─── Top Bar Extras ──────────────────────────────────────────
function injectTopBarExtras() {
    const topBar = document.querySelector('.top-bar');
    if (!topBar || document.getElementById('notifBtn')) return;

    // Filter toggle button + notification button + shortcuts button
    const extras = document.createElement('div');
    extras.className = 'topbar-extras';
    extras.innerHTML = `
    <button id="filterToggleBtn" class="icon-btn topbar-extra-btn" title="Search Filters" type="button" aria-label="Open search filters">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
    </button>
    <button id="notifBtn" class="icon-btn topbar-extra-btn notif-btn" title="Notifications" type="button" aria-label="Open notifications">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <span id="notifBadge" class="notif-badge" style="display:none">0</span>
    </button>
    <button id="shortcutsBtn" class="icon-btn topbar-extra-btn" title="Keyboard Shortcuts (?)" type="button" aria-label="Open keyboard shortcuts">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>
    </button>
  `;
    topBar.appendChild(extras);

    document.getElementById('notifBtn').addEventListener('click', toggleNotifPanel);
    document.getElementById('shortcutsBtn').addEventListener('click', toggleShortcutsPanel);
    document.getElementById('filterToggleBtn').addEventListener('click', () => {
        const sfp = document.getElementById('searchFilterPanel');
        if (sfp) sfp.classList.toggle('open');
    });

    Notifications.updateBadge();
}

// ─── Card Hover Detail Button ─────────────────────────────────
function addMoreInfoBtn(card, anime) {
    const poster = card.querySelector('.card-poster');
    if (!poster || poster.querySelector('.more-info-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'more-info-btn';
    btn.title = 'More Info';
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> More`;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openDetailModal(anime);
    });
    poster.appendChild(btn);
}

// ─── Progress Bar on Cards ───────────────────────────────────
function addProgressBar(card, animeId) {
    const poster = card.querySelector('.card-poster');
    if (!poster || poster.querySelector('.card-progress-bar')) return;
    const lastEp = WatchProgress.getLastEpisode(animeId);
    if (!lastEp || lastEp.pct < 0.01) return;
    const bar = document.createElement('div');
    bar.className = 'card-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'card-progress-fill';
    fill.style.width = `${Math.min(lastEp.pct * 100, 100)}%`;
    bar.appendChild(fill);
    poster.appendChild(bar);
}

// ─── Share / Copy Clipboard ──────────────────────────────────
function copyToClipboard(text, msg = 'Copied!') {
    navigator.clipboard?.writeText(text).then(() => showToastGlobal(msg, 'success'))
        .catch(() => {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            showToastGlobal(msg, 'success');
        });
}

// ─── Toast (global, idempotent) ──────────────────────────────
function showToastGlobal(msg, type = 'success') {
    if (typeof showToast === 'function') { showToast(msg, type); return; }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

// ─── Time Ago Helper ─────────────────────────────────────────
function timeAgo(ts) {
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Keyboard shortcut: '?' ───────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.target?.tagName?.toLowerCase() === 'input') return;
    if (e.key === '?') { e.preventDefault(); toggleShortcutsPanel(); }
});

// ─── Init on Home Page ─────────────────────────────────────
function initHomeFeatures() {
    injectTopBarExtras();
    createSearchFilterPanel();
    // Upgrade genre links with data attributes and filter functionality
    document.querySelectorAll('.genre-link').forEach(link => {
        const genre = link.textContent.trim();
        link.dataset.genre = genre;
        link.addEventListener('click', (e) => {
            e.preventDefault();
            applyGenreFilter(genre);
        });
    });

    // Add "More Info" to all future & current cards
    const gridObserver = new MutationObserver((mutations) => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.nodeType !== 1) return;
                const cards = node.classList?.contains('card') ? [node] : node.querySelectorAll?.('.card') || [];
                cards.forEach(card => {
                    const anime = card._animeData;
                    if (anime) {
                        addMoreInfoBtn(card, anime);
                        addProgressBar(card, anime.id);
                    }
                });
            });
        });
    });
    const primaryContent = document.querySelector('.primary-content');
    if (primaryContent) gridObserver.observe(primaryContent, { childList: true, subtree: true });
}

// ─── Expose globals ───────────────────────────────────────────
window.AnikaiFeatures = {
    Store, Ratings, Notifications, WatchProgress,
    openDetailModal, closeDetailModal,
    applyGenreFilter, setFullCatalog, getFilteredCatalog,
    addMoreInfoBtn, addProgressBar,
    copyToClipboard, showToastGlobal, timeAgo,
    toggleNotifPanel, toggleShortcutsPanel,
    initHomeFeatures, triggerPopunder,
    get activeGenreFilter() { return activeGenreFilter; },
    get activeYearFilter() { return activeYearFilter; },
    get activeTypeFilter() { return activeTypeFilter; }
};
