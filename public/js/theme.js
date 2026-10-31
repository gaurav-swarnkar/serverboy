// Light / dark / auto (follow the computer). Remembered per browser.
const KEY = 'sb-theme';

export function getTheme() {
  try {
    return localStorage.getItem(KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(theme = getTheme()) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

export function setTheme(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode: still applies for this page */
  }
  applyTheme(theme);
}

// What is showing right now (auto resolves to the computer's setting).
export function shownTheme() {
  const t = getTheme();
  if (t !== 'auto') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

applyTheme();
