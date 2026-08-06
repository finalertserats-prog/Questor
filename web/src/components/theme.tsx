import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'questor-theme';

/**
 * Light is the product default, full stop.
 *
 * A stored choice always wins — once someone picks dark, they keep it. Beyond
 * that the OS preference is deliberately NOT consulted: it was, and the result
 * was that anyone running Windows in dark mode saw a dark console despite light
 * being the specified default. "Default to light unless the operating system
 * disagrees" is not a light default, it is an OS default.
 */
export function resolveInitialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Private mode / blocked storage: fall through to the light default.
  }
  return 'light';
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // The pre-paint script in index.html has already stamped the element; read
    // it back so the first render agrees with what is on screen.
    const stamped = document.documentElement.getAttribute('data-theme');
    return stamped === 'dark' || stamped === 'light' ? stamped : resolveInitialTheme();
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // A theme we cannot persist is still a theme we can apply.
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggleTheme = useCallback(() => setThemeState((t) => (t === 'dark' ? 'light' : 'dark')), []);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}

/**
 * A two-position switch rather than a single button that flips meaning: the
 * current mode stays readable at rest, which matters more here than saving
 * the few pixels a single icon would.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      <button
        type="button"
        className={theme === 'light' ? 'is-on' : undefined}
        aria-pressed={theme === 'light'}
        onClick={() => setTheme('light')}
      >
        Light
      </button>
      <button
        type="button"
        className={theme === 'dark' ? 'is-on' : undefined}
        aria-pressed={theme === 'dark'}
        onClick={() => setTheme('dark')}
      >
        Dark
      </button>
    </div>
  );
}
