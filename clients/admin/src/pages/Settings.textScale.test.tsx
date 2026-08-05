import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Settings from './Settings';
import * as prefs from '../session/PreferencesProvider';
import * as session from '../session/SessionProvider';
import { apiClient } from '../api/client';

/**
 * Choosing a text size is not the same act as applying one.
 *
 * Every stop used to resize the whole interface the instant it was clicked,
 * which has two problems: comparing two sizes moves the very buttons you are
 * comparing them with, and at 200% the page reflows under the cursor while you
 * are still deciding. So the picker stages a candidate, the sample shows it at
 * its real size, and nothing else moves until تطبيق.
 */

const setTextScale = vi.fn().mockResolvedValue(undefined);

function stub(scale = 100) {
  vi.spyOn(prefs, 'usePreferences').mockReturnValue({
    theme: 'light',
    text_scale: scale,
    resolvedTheme: 'light',
    loaded: true,
    error: null,
    setTheme: vi.fn(),
    setTextScale,
  } as unknown as ReturnType<typeof prefs.usePreferences>);

  vi.spyOn(session, 'useSession').mockReturnValue({
    me: { user_id: 'u1', organization_id: 'o1', role: 'owner', modules: [] },
    loading: false,
    error: false,
    reload: vi.fn(),
    can: () => true,
  } as unknown as ReturnType<typeof session.useSession>);

  // Branding and modules both fetch on mount; neither is under test here.
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: [] });
}

afterEach(() => {
  vi.restoreAllMocks();
  setTextScale.mockClear();
});

describe('picking a text size', () => {
  it('changes nothing until it is applied', async () => {
    stub(100);
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole('button', { name: 'كبير' }));

    // The candidate is selected, and the interface has NOT been resized.
    expect(setTextScale).not.toHaveBeenCalled();
    expect(screen.getByText(/الحجم الحالي:/)).toHaveTextContent('100%');
  });

  it('offers Apply only once something has actually changed', async () => {
    stub(100);
    const user = userEvent.setup();
    render(<Settings />);

    // A button that is always there, usually doing nothing, teaches people to
    // ignore it.
    expect(screen.queryByTestId('text-scale-apply')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'كبير' }));
    expect(screen.getByTestId('text-scale-apply')).toBeInTheDocument();
  });

  it('applies the candidate, not whatever was clicked last time', async () => {
    stub(100);
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole('button', { name: 'كبير جدًا' }));
    await user.click(screen.getByRole('button', { name: 'أكبر' }));
    await user.click(screen.getByRole('button', { name: 'تطبيق' }));

    await waitFor(() => expect(setTextScale).toHaveBeenCalledTimes(1));
    const applied = setTextScale.mock.calls[0][0];
    expect(applied).toBeGreaterThan(100);
    expect(applied).toBeLessThan(200);
  });

  it('تراجع puts the picker back and withdraws the offer', async () => {
    stub(100);
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole('button', { name: 'كبير' }));
    await user.click(screen.getByRole('button', { name: 'تراجع' }));

    expect(screen.queryByTestId('text-scale-apply')).not.toBeInTheDocument();
    expect(setTextScale).not.toHaveBeenCalled();
  });

  it('re-selecting the size already in force withdraws the offer too', async () => {
    stub(100);
    const user = userEvent.setup();
    render(<Settings />);

    await user.click(screen.getByRole('button', { name: 'كبير' }));
    await user.click(screen.getByRole('button', { name: 'افتراضي' }));

    expect(screen.queryByTestId('text-scale-apply')).not.toBeInTheDocument();
  });
});

describe('the sample box', () => {
  /**
   * This is the test that was missing, and its absence is why the bug shipped:
   * the previous suite checked that picking a size did not change the PAGE, and
   * never checked that it changed the SAMPLE. So a preview that could not
   * possibly work — font-size on a box whose children are all rem-based — passed.
   */
  it('shows the candidate size, not the one in force', async () => {
    stub(100);
    const user = userEvent.setup();
    render(<Settings />);

    const sample = screen.getByTestId('text-scale-sample');
    expect(sample.style.zoom).toBe('1');

    await user.click(screen.getByRole('button', { name: 'كبير' })); // 130
    expect(sample.style.zoom).toBe('1.3');
  });

  it('follows every stop, including back down', async () => {
    stub(100);
    const user = userEvent.setup();
    render(<Settings />);

    const sample = screen.getByTestId('text-scale-sample');
    await user.click(screen.getByRole('button', { name: 'كبير جدًا' }));
    expect(sample.style.zoom).toBe('1.5');

    await user.click(screen.getByRole('button', { name: 'أصغر' }));
    expect(sample.style.zoom).toBe('0.9');
  });

  it('starts from the size already applied', async () => {
    stub(115);
    render(<Settings />);
    expect(screen.getByTestId('text-scale-sample').style.zoom).toBe('1.15');
  });
});
