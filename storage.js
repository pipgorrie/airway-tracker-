/*
 * Standalone replacement for the Claude.ai-artifact-only `window.storage` API.
 * Backed by browser localStorage so the app works as a normal static site.
 */
(function () {
  const PREFIX = 'airway-tracker:local:';

  window.storage = {
    async get(key) {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? null : { value: raw };
    },
    async set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, value);
      } catch (e) {
        throw new Error('Storage quota exceeded — try a smaller file.');
      }
      return true;
    },
    async delete(key) {
      localStorage.removeItem(PREFIX + key);
      return true;
    },
    async list(prefix) {
      const fullPrefix = PREFIX + prefix;
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(fullPrefix)) {
          keys.push(k.slice(PREFIX.length));
        }
      }
      return { keys };
    },
  };
})();
