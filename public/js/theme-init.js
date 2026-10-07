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
      if (theme === 'tokyo-night') theme = 'tokyonight';
      if (theme === 'system') {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dracula' : 'light';
      }
      document.documentElement.dataset.theme = theme;
      if (document.body) {
        document.body.dataset.theme = theme;
      } else {
        document.addEventListener('DOMContentLoaded', function() {
          document.documentElement.dataset.theme = theme;
          if (document.body) document.body.dataset.theme = theme;
        });
      }

      // Read --bg2 from the stylesheet instead of keeping a duplicate map here.
      // The old map had two dead keys (nord, catppuccin — not real theme names)
      // and omitted solarized, monokai and oled, so those three showed light
      // browser chrome until the user re-picked the theme (S-12).
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        try {
          const bg2 = getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim();
          if (bg2) meta.content = bg2;
        } catch (e) {}
      }
    } catch(e){ console.warn('Settings init error:', e); }
  })();
