import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiClient } from '../api/client';

/**
 * Appearance, applied.
 *
 * Two rules shape this:
 *
 *   THE PREFERENCE IS APPLIED BEFORE IT IS SAVED. Waiting for a round trip to
 *   see whether dark mode looks right makes the setting feel broken on a slow
 *   connection, and the user is choosing something about their own screen —
 *   there is nothing to validate. If the save then fails, it reverts and says
 *   so, which is the only honest way to use the fast path.
 *
 *   'system' IS LIVE, NOT A ONE-OFF READ. Somebody whose laptop switches to
 *   dark at sunset expects this to follow. That means listening to the media
 *   query for as long as the preference is 'system', and stopping when it is not.
 */

export type Theme = 'light' | 'dark' | 'system';

export const TEXT_SCALE_MIN = 80;
export const TEXT_SCALE_MAX = 200;

interface Preferences {
  theme: Theme;
  text_scale: number;
}

interface PreferencesContextValue extends Preferences {
  /** What is actually on screen once 'system' has been resolved. */
  resolvedTheme: 'light' | 'dark';
  /** Null until the stored preferences have been read. */
  loaded: boolean;
  /** Set when a save failed and the change was rolled back. */
  error: string | null;
  setTheme: (theme: Theme) => Promise<void>;
  setTextScale: (scale: number) => Promise<void>;
}

const DEFAULTS: Preferences = { theme: 'system', text_scale: 100 };

const PreferencesContext = createContext<PreferencesContextValue>({
  ...DEFAULTS,
  resolvedTheme: 'light',
  loaded: false,
  error: null,
  setTheme: async () => {},
  setTextScale: async () => {},
});

// eslint-disable-next-line react-refresh/only-export-components
export function usePreferences() {
  return useContext(PreferencesContext);
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export default function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // Follow the operating system for as long as 'system' is the choice. Not a
  // read at startup: a laptop that switches at sunset should carry the app
  // with it, and a stale snapshot would leave the interface fighting the OS.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    let active = true;
    apiClient
      .get<Preferences>('/api/preferences')
      .then(({ data }) => {
        if (!active) return;
        setPrefs({ theme: data.theme, text_scale: data.text_scale });
      })
      // Silent on purpose: an unreadable preference is not worth an error
      // banner over. The defaults are a working interface, and every other
      // request on the page will report the real problem anyway.
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    prefs.theme === 'system' ? (systemDark ? 'dark' : 'light') : prefs.theme;

  // Applied to <html> rather than a wrapper div so it also covers anything
  // portalled outside the React tree — modals, and the page background itself.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.style.setProperty('--app-text-scale', String(prefs.text_scale));
  }, [resolvedTheme, prefs.text_scale]);

  const save = useCallback(
    async (patch: Partial<Preferences>) => {
      const previous = prefs;
      setPrefs((current) => ({ ...current, ...patch }));
      setError(null);
      try {
        await apiClient.put('/api/preferences', patch);
      } catch {
        // Put it back. Leaving the screen showing a choice that was not saved
        // means it silently reverts on the next reload, which is worse than
        // reverting now and saying why.
        setPrefs(previous);
        setError('تعذّر حفظ التفضيل. أعيد ما كان.');
      }
    },
    [prefs],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({
      ...prefs,
      resolvedTheme,
      loaded,
      error,
      setTheme: (theme: Theme) => save({ theme }),
      setTextScale: (text_scale: number) => save({ text_scale }),
    }),
    [prefs, resolvedTheme, loaded, error, save],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}
