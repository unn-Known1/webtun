  // Safe localStorage wrapper — degrades gracefully when Tracking Prevention blocks storage
  const safeStorage = {
    getItem(k) { try { return localStorage.getItem(k); } catch(e) { return null; } },
    setItem(k, v) { try { localStorage.setItem(k, v); } catch(e) {} },
    removeItem(k) { try { localStorage.removeItem(k); } catch(e) {} }
  };
  (function() {
    try {
      const settings = JSON.parse(safeStorage.getItem('wt-settings')) || {};
      let theme = settings.theme || 'light';
      if (theme === 'system') {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dracula' : 'light';
      }
      // This runs synchronously at body start, first paint still pending:
      // set the theme on documentElement (where the CSS variables live) so
      // no unthemed flash occurs, and on body too (present at this point —
      // guarded anyway). applyTheme() in app.js re-asserts both at init.
      document.documentElement.dataset.theme = theme;
      if (document.body) document.body.dataset.theme = theme;
    } catch(e){ console.warn('Settings init error:', e); }
  })();
