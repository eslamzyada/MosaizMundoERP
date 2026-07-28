import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from './ErrorBoundary';

/**
 * The boundary that stops one broken page blanking the whole admin.
 *
 * It exists because that happened: an order status the UI did not recognise
 * made a lookup return undefined, reading a property off it threw, and React
 * unmounted the entire tree — an empty <div id="root"> with no message, no
 * navigation, and nothing to distinguish it from the server being down.
 *
 * Verified once by hand by making a page throw on purpose. This is that check,
 * kept, so nobody has to do it by hand again.
 */
describe('ErrorBoundary', () => {
  // React logs caught errors to console.error. Silenced so a passing run is
  // not full of red that looks like a failure.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function Boom(): JSX.Element {
    throw new Error('لا يمكن قراءة الحالة');
  }

  it('renders its children when nothing is wrong', () => {
    render(
      <ErrorBoundary>
        <p>محتوى الصفحة</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('محتوى الصفحة')).toBeInTheDocument();
  });

  it('shows a message instead of a blank screen when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    // The failure this exists to prevent is rendering NOTHING. Anything on
    // screen beats an empty root.
    expect(screen.getByText('تعذّر عرض هذه الصفحة')).toBeInTheDocument();
  });

  it("names the error, so a bug report is not 'it went black'", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('لا يمكن قراءة الحالة')).toBeInTheDocument();
  });

  it('offers both a retry and a reload', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إعادة تحميل الصفحة' })).toBeInTheDocument();
  });

  it('logs the error for whoever has to fix it', () => {
    // The on-screen message is for the person standing there; the console is
    // for the person debugging. Both, not either.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(console.error).toHaveBeenCalled();
  });
});
