/* global firebase */
(function initAnikaiFirebase() {
  const firebaseConfig = {
    apiKey: "AIzaSyC7Q3sSBSgNmtC9g33Nm-INJzq--gB7AbY",
    authDomain: "anikai-9151e.firebaseapp.com",
    projectId: "anikai-9151e",
    storageBucket: "anikai-9151e.firebasestorage.app",
    messagingSenderId: "946130511160",
    appId: "1:946130511160:web:8bdcac84eeadc24daa0dcd",
    measurementId: "G-6VKCPQH7QX"
  };

  function noop() { }

  const fallback = {
    ready: false,
    authEnabled: false,
    firestoreEnabled: false,
    onAuthStateChanged(cb) { cb(null); return noop; },
    getCurrentUser() { return null; },
    async signInWithGoogle() { throw new Error('Firebase unavailable'); },
    async signInWithEmail() { throw new Error('Firebase unavailable'); },
    async signOut() { },
    async loadPlaylist() { return []; },
    async savePlaylist() { },
    async loadWatchProgress() { return []; },
    async saveWatchProgress() { }
  };

  if (!window.firebase || typeof window.firebase.initializeApp !== 'function') {
    window.AnikaiFirebase = fallback;
    return;
  }

  let app;
  let auth = null;
  let db = null;
  let persistenceReady = false;
  try {
    app = window.firebase.apps?.length ? window.firebase.app() : window.firebase.initializeApp(firebaseConfig);
    if (window.firebase.auth) auth = window.firebase.auth();
    if (window.firebase.firestore) db = window.firebase.firestore();
    if (window.firebase.analytics) {
      try { window.firebase.analytics(app); } catch (_) { }
    }
  } catch (_) {
    window.AnikaiFirebase = fallback;
    return;
  }

  async function signInWithGoogle() {
    if (!auth) throw new Error('Firebase Auth not available');
    if (!persistenceReady) {
      await auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);
      persistenceReady = true;
    }
    const provider = new window.firebase.auth.GoogleAuthProvider();
    const result = await auth.signInWithPopup(provider);
    return result.user;
  }

  async function signInWithEmail(email, password) {
    if (!auth) throw new Error('Firebase Auth not available');
    if (!email || !password) throw new Error('Email and password are required');
    if (!persistenceReady) {
      await auth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);
      persistenceReady = true;
    }
    try {
      const result = await auth.signInWithEmailAndPassword(email, password);
      return result.user;
    } catch (error) {
      const code = String(error?.code || '');
      const shouldTryCreate =
        code === 'auth/user-not-found' ||
        code === 'auth/invalid-credential' ||
        code === 'auth/invalid-login-credentials';

      if (shouldTryCreate) {
        try {
          const created = await auth.createUserWithEmailAndPassword(email, password);
          return created.user;
        } catch (createError) {
          const createCode = String(createError?.code || '');
          if (createCode === 'auth/email-already-in-use') {
            throw new Error('Email exists. Use the correct password or reset password.');
          }
          throw createError;
        }
      }
      throw error;
    }
  }

  async function signOut() {
    if (!auth) return;
    await auth.signOut();
  }

  function onAuthStateChanged(cb) {
    if (!auth) {
      cb(null);
      return noop;
    }
    return auth.onAuthStateChanged(cb);
  }

  function getCurrentUser() {
    return auth?.currentUser || null;
  }

  function playlistDoc(uid) {
    return db.collection('userPlaylists').doc(String(uid));
  }

  function progressCollection(uid) {
    return db.collection('userProgress').doc(String(uid)).collection('entries');
  }

  const COMMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  function commentsCollection(animeId, episode) {
    if (!db) return null;
    return db
      .collection('episodeComments')
      .doc(String(animeId))
      .collection('episodes')
      .doc(String(episode))
      .collection('items');
  }

  async function pruneOldComments(animeId, episode, maxAgeMs) {
    if (!db || !animeId || !episode) return;
    const col = commentsCollection(animeId, episode);
    if (!col) return;
    const cutoff = Date.now() - (maxAgeMs || COMMENT_MAX_AGE_MS);
    try {
      const snap = await col
        .where('createdAtMs', '<', cutoff)
        .orderBy('createdAtMs', 'asc')
        .limit(80)
        .get();
      if (snap.empty) return;
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    } catch (_) {
      // Best-effort cleanup; ignore failures so comments still work.
    }
  }

  async function loadPlaylist(uid) {
    if (!db || !uid) return [];
    const snap = await playlistDoc(uid).get();
    if (!snap.exists) return [];
    const data = snap.data() || {};
    return Array.isArray(data.items) ? data.items : [];
  }

  async function savePlaylist(uid, items) {
    if (!db || !uid) return;
    await playlistDoc(uid).set({
      items: Array.isArray(items) ? items : [],
      updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  async function loadWatchProgress(uid, limit = 50) {
    if (!db || !uid) return [];
    const query = await progressCollection(uid)
      .orderBy('ts', 'desc')
      .limit(limit)
      .get();
    return query.docs.map((doc) => ({ animeId: doc.id, ...(doc.data() || {}) }));
  }

  async function saveWatchProgress(uid, animeId, progress) {
    if (!db || !uid || !animeId) return;
    await progressCollection(uid).doc(String(animeId)).set({
      episode: Number(progress?.episode || 1),
      currentTime: Number(progress?.currentTime || 0),
      duration: Number(progress?.duration || 0),
      pct: Number(progress?.pct || 0),
      ts: Number(progress?.ts || Date.now()),
      updatedAt: window.firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  async function clearWatchProgress(uid) {
    if (!db || !uid) return;
    const snap = await progressCollection(uid).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  async function deleteWatchProgressEntry(uid, animeId) {
    if (!db || !uid || !animeId) return;
    await progressCollection(uid).doc(String(animeId)).delete();
  }

  async function addComment(animeId, episode, payload) {
    if (!db || !animeId || !episode) {
      throw new Error('Comments are unavailable right now.');
    }
    const col = commentsCollection(animeId, episode);
    if (!col) {
      throw new Error('Comments are unavailable right now.');
    }
    const now = Date.now();
    // Prune comments older than 24 hours for this episode.
    pruneOldComments(animeId, episode, COMMENT_MAX_AGE_MS);
    const docRef = await col.add({
      uid: payload?.uid || null,
      displayName: String(payload?.displayName || 'User'),
      text: String(payload?.text || '').slice(0, 1000),
      createdAt: window.firebase.firestore.FieldValue.serverTimestamp(),
      createdAtMs: now
    });
    const snap = await docRef.get();
    return { id: docRef.id, ...(snap.data() || {}) };
  }

  function subscribeComments(animeId, episode, cb, limit = 80) {
    if (!db || !animeId || !episode) {
      cb([]);
      return noop;
    }
    const col = commentsCollection(animeId, episode);
    if (!col) {
      cb([]);
      return noop;
    }
    const cutoff = Date.now() - COMMENT_MAX_AGE_MS;
    return col
      .where('createdAtMs', '>=', cutoff)
      .orderBy('createdAtMs', 'desc')
      .limit(limit)
      .onSnapshot(
        (querySnapshot) => {
          const items = [];
          querySnapshot.forEach((doc) => {
            items.push({ id: doc.id, ...(doc.data() || {}) });
          });
          items.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
          cb(items);
        },
        () => {
          cb([]);
        }
      );
  }

  window.AnikaiFirebase = {
    ready: true,
    authEnabled: Boolean(auth),
    firestoreEnabled: Boolean(db),
    onAuthStateChanged,
    getCurrentUser,
    signInWithGoogle,
    signInWithEmail,
    signOut,
    loadPlaylist,
    savePlaylist,
    loadWatchProgress,
    saveWatchProgress,
    clearWatchProgress,
    deleteWatchProgressEntry,
    addComment,
    subscribeComments
  };
})();
