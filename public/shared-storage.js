;(function () {
  function readJsonInternal(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJsonInternal(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      // Ignore quota / private mode errors.
    }
  }

  function safeReadJsonStorageInternal(key, storage) {
    const target = storage || window.sessionStorage;
    try {
      const raw = target.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function safeWriteJsonStorageInternal(key, value, storage) {
    const target = storage || window.sessionStorage;
    try {
      target.setItem(key, JSON.stringify(value));
    } catch (_) {
      // Ignore storage quota/private-mode failures.
    }
  }

  if (!window.AnikaiShared) {
    window.AnikaiShared = {};
  }

  window.AnikaiShared.readJson = readJsonInternal;
  window.AnikaiShared.writeJson = writeJsonInternal;
  window.AnikaiShared.safeReadJsonStorage = safeReadJsonStorageInternal;
  window.AnikaiShared.safeWriteJsonStorage = safeWriteJsonStorageInternal;
}());

