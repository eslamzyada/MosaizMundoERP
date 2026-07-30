import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PreferencesProvider, { usePreferences } from './PreferencesProvider';
import { apiClient } from '../api/client';

/**
 * Appearance, applied.
 *
 * None of this is visible in a screenshot of a passing state — it is all about
 * what happens when the operating system changes, when a save fails, or when
 * the stored preference cannot be read. Those are the moments the interface
 * either follows the person or quietly fights them.
 */

let systemDark = false;
const listeners = new Set<(e: MediaQueryListEvent) => void>();

/** A matchMedia the test can move, the way an OS switching at sunset would. */
function installMatchMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') && systemDark,
    media: query,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

function moveSystemTo(dark: boolean) {
  systemDark = dark;
  listeners.forEach((cb) => cb({ matches: dark } as MediaQueryListEvent));
}

function Probe() {
  const { theme, text_scale, resolvedTheme, error, loaded } = usePreferences();
  return (
    <div>
      <span data-testid="loaded">{loaded ? 'yes' : 'no'}</span>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <span data-testid="scale">{text_scale}</span>
      <span data-testid="error">{error ?? ''}</span>
    </div>
  );
}

const renderWith = () =>
  render(
    <PreferencesProvider>
      <Probe />
    </PreferencesProvider>,
  );

describe('PreferencesProvider', () => {
  beforeEach(() => {
    systemDark = false;
    listeners.clear();
    installMatchMedia();
    document.documentElement.classList.remove('dark');
    document.documentElement.style.removeProperty('--app-text-scale');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('applies a stored dark preference to the document', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { theme: 'dark', text_scale: 130 } });

    renderWith();

    // The class goes on <html>, not a wrapper, so it also covers modals that
    // portal outside the React tree.
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
    expect(document.documentElement.style.getPropertyValue('--app-text-scale')).toBe('130');
  });

  it("'system' resolves to whatever the device says", async () => {
    systemDark = true;
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { theme: 'system', text_scale: 100 } });

    renderWith();

    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('dark'));
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
  });

  it("'system' KEEPS following the device, rather than reading it once", async () => {
    // Somebody whose laptop switches to dark at sunset expects the app to come
    // with it. A snapshot taken at startup would leave the interface fighting
    // the operating system for the rest of the evening.
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { theme: 'system', text_scale: 100 } });

    renderWith();
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('light'));

    moveSystemTo(true);

    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('an explicit choice does NOT follow the device', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { theme: 'light', text_scale: 100 } });

    renderWith();
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('light'));

    moveSystemTo(true);

    // Still light: choosing 'light' means light, whatever the laptop is doing.
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('light'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('falls back to working defaults when preferences cannot be read', async () => {
    // An unreadable preference is not worth an error banner: the defaults are
    // a working interface, and every other request on the page will report the
    // real problem anyway.
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('offline'));

    renderWith();

    // Wait for the fetch to SETTLE before asserting. Checking the theme
    // straight away passes on the initial default, before the rejection has
    // even been handled — which is exactly what an earlier version of this
    // test did, and it stayed green with the fallback replaced by 'light'.
    await waitFor(() => expect(screen.getByTestId('loaded')).toHaveTextContent('yes'));

    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(screen.getByTestId('scale')).toHaveTextContent('100');
    expect(screen.getByTestId('error')).toHaveTextContent('');
  });

  it('reverts and explains when a save fails', async () => {
    // Applying before saving is what makes the setting feel instant. The cost
    // is that a failed save must put it back — otherwise the screen shows a
    // choice that silently disappears on the next reload.
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { theme: 'light', text_scale: 100 } });
    vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('nope'));

    function Changer() {
      const { setTheme, theme, error } = usePreferences();
      return (
        <div>
          <span data-testid="theme">{theme}</span>
          <span data-testid="error">{error ?? ''}</span>
          <button type="button" onClick={() => void setTheme('dark')}>
            go dark
          </button>
        </div>
      );
    }

    render(
      <PreferencesProvider>
        <Changer />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('light'));

    screen.getByRole('button', { name: 'go dark' }).click();

    await waitFor(() => expect(screen.getByTestId('error')).not.toHaveTextContent(''));
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
