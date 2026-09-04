/*
 * Standalone replacement for the Claude.ai-artifact-only `window.storage` API.
 * Backed by browser localStorage so the app works as a normal static site.
 *
 * Note: the app calls this with a `shared` flag for feedback data (meant to be
 * visible across all users of the artifact). There is no backend here, so
 * "shared" data is still only local to this browser — it's kept in a separate
 * namespace purely to match the original app's key layout.
 */
(function () {
  const PREFIX = 'airway-tracker:';

  function ns(shared) {
    return PREFIX + (shared ? 'shared:' : 'local:');
  }

  window.storage = {
    async get(key, shared = false) {
      const raw = localStorage.getItem(ns(shared) + key);
      return raw === null ? null : { value: raw };
    },
    async set(key, value, shared = false) {
      try {
        localStorage.setItem(ns(shared) + key, value);
      } catch (e) {
        throw new Error('Storage quota exceeded — try a smaller file.');
      }
      return true;
    },
    async delete(key, shared = false) {
      localStorage.removeItem(ns(shared) + key);
      return true;
    },
    async list(prefix, shared = false) {
      const fullPrefix = ns(shared) + prefix;
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(fullPrefix)) {
          keys.push(k.slice(ns(shared).length));
        }
      }
      return { keys };
    },
  };
})();
