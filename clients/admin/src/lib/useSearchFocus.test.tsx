import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSearchFocus } from './useSearchFocus';

/**
 * Landing on the record rather than on the page it is somewhere inside.
 *
 * The interesting cases are all about restraint: the highlight goes on exactly
 * one row, it goes nowhere at all when the page was opened normally, and it
 * fades. A permanent highlight is still there ten minutes later, reading as
 * "this row is selected" to somebody who has forgotten how they got here.
 */

function Table() {
  const { focusId, focusProps } = useSearchFocus();
  return (
    <div>
      {/* Prefixed so this probe cannot be mistaken for a row when querying by
          text — with a bare id it matches both, and every row lookup fails. */}
      <span data-testid="focus-id">focus:{focusId ?? 'none'}</span>
      <table>
        <tbody>
          {['a', 'b', 'c'].map((id) => (
            <tr key={id} {...focusProps(id, `row-${id} base-class`)}>
              <td>{id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Table />
    </MemoryRouter>,
  );

const row = (id: string) => screen.getByText(id).closest('tr') as HTMLTableRowElement;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('arriving from the search box', () => {
  it('marks the row that was chosen, and only that row', () => {
    renderAt('/inventory?focus=b');

    expect(row('b')).toHaveAttribute('data-search-focus', 'true');
    expect(row('a')).not.toHaveAttribute('data-search-focus');
    expect(row('c')).not.toHaveAttribute('data-search-focus');
  });

  it('KEEPS the row\'s own classes instead of replacing them', () => {
    // Spreading over `className` is the obvious way to write this and it
    // silently drops the hover styles of exactly one row — the highlighted one,
    // which is the row somebody is about to interact with.
    renderAt('/inventory?focus=b');

    expect(row('b')).toHaveClass('row-b');
    expect(row('b')).toHaveClass('base-class');
    expect(row('b').className).toMatch(/bg-sunset-500/);
  });

  it('scrolls the chosen row into view exactly once, INCLUDING when the highlight fades', () => {
    const scrollIntoView = vi.fn();
    // jsdom has no scrollIntoView at all, so it has to be installed before
    // asserting on it.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    vi.useFakeTimers();

    renderAt('/inventory?focus=b');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // The fade re-creates the ref callback, so React detaches and re-attaches
    // it. Without the guard that remembers where it already scrolled, the page
    // jumps a SECOND time — seconds after arriving, by which point the reader
    // has scrolled somewhere else. Checking only the first render misses it
    // entirely, which is exactly what an earlier version of this test did.
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('lets the highlight go after a few seconds', () => {
    vi.useFakeTimers();
    renderAt('/inventory?focus=b');

    expect(row('b').className).toMatch(/bg-sunset-500/);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(row('b').className).not.toMatch(/bg-sunset-500/);
    // The marker outlives the colour, so the row is still identifiable
    // afterwards — by a test, or by anything else that needs to find it.
    expect(row('b')).toHaveAttribute('data-search-focus', 'true');
  });
});

describe('arriving normally', () => {
  it('marks nothing when there is no ?focus', () => {
    renderAt('/inventory');

    expect(screen.getByTestId('focus-id')).toHaveTextContent('none');
    for (const id of ['a', 'b', 'c']) {
      expect(row(id)).not.toHaveAttribute('data-search-focus');
      expect(row(id).className).toBe(`row-${id} base-class`);
    }
  });

  it('marks nothing when the focused id is not on the page', () => {
    // A record that has since been deleted, or a link shared from another
    // account. The page must simply render.
    renderAt('/inventory?focus=does-not-exist');

    for (const id of ['a', 'b', 'c']) {
      expect(row(id)).not.toHaveAttribute('data-search-focus');
    }
  });

  it('does not confuse a different query parameter for a focus', () => {
    renderAt('/inventory?filter=b');
    expect(screen.getByTestId('focus-id')).toHaveTextContent('none');
  });
});
