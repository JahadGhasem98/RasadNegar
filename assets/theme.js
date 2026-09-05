/* Day / night theme controller */
(() => {
  'use strict';
  const KEY = 'atlas_f70_theme_v1';

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function currentTheme() {
    const saved = localStorage.getItem(KEY);
    return saved === 'dark' || saved === 'light' ? saved : systemTheme();
  }

  function applyTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(KEY, next);
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      btn.textContent = next === 'dark' ? '☀️' : '🌙';
      btn.setAttribute('aria-label', next === 'dark' ? 'فعال کردن تم روز' : 'فعال کردن تم شب');
      btn.title = next === 'dark' ? 'تم روز' : 'تم شب';
    });
  }

  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }

  function bind() {
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', toggleTheme);
    });
  }

  applyTheme(currentTheme());
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(currentTheme());
    bind();
  });

  window.AtlasTheme = { applyTheme, toggleTheme, currentTheme };
})();
