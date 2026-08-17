import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LoadError from './LoadError';
import type { LoadFailure } from '../lib/loadFailure';

/**
 * The reference is only worth showing where it means something.
 *
 * The API gives every request a correlation id. Put in front of the person
 * looking at a broken screen, it turns "it failed around 8:40" into one line
 * in the log. But it is not appropriate on every failure: an expired session
 * and a permission the account does not have are not FAULTS, the reader
 * already knows what to do, and offering an id there implies there is
 * something to report and somebody who will look at it.
 *
 * These tests are about that judgement, not about the markup.
 */

const failure = (over: Partial<LoadFailure> = {}): LoadFailure => ({
  kind: 'server',
  message: 'حدث خطأ في الخادم (500). حاول مرة أخرى بعد قليل.',
  canRetry: true,
  status: 500,
  reference: '6b1f2c7e-0d3a-4a71-9f52-0f3f5b6a1c22',
  ...over,
});

describe('LoadError and the reference', () => {
  it('shows it for a server fault, where "(500)" identifies nothing', () => {
    render(<LoadError failure={failure()} />);
    expect(screen.getByText('6b1f2c7e-0d3a-4a71-9f52-0f3f5b6a1c22')).toBeInTheDocument();
  });

  it('shows it for an unclassified failure, which is the case most worth reporting', () => {
    render(<LoadError failure={failure({ kind: 'unknown', status: 418 })} />);
    expect(screen.getByText('6b1f2c7e-0d3a-4a71-9f52-0f3f5b6a1c22')).toBeInTheDocument();
  });

  it('withholds it for an expired session', () => {
    // Not a fault. The app is already returning to the login screen, and an id
    // would invite somebody to report a working system.
    render(<LoadError failure={failure({ kind: 'unauthenticated', canRetry: false })} />);
    expect(screen.queryByText('6b1f2c7e-0d3a-4a71-9f52-0f3f5b6a1c22')).not.toBeInTheDocument();
    expect(screen.queryByText(/رقم المرجع/)).not.toBeInTheDocument();
  });

  it('withholds it for a permission the account does not have', () => {
    // The accountant on a manager-only page is not experiencing a bug.
    render(<LoadError failure={failure({ kind: 'forbidden', canRetry: false })} />);
    expect(screen.queryByText(/رقم المرجع/)).not.toBeInTheDocument();
  });

  it('says nothing about a reference when there is none', () => {
    // Offline: nothing answered, so there is no line to find.
    render(
      <LoadError failure={failure({ kind: 'offline', reference: undefined, status: undefined })} />,
    );
    expect(screen.queryByText(/رقم المرجع/)).not.toBeInTheDocument();
  });

  it('renders the id left-to-right, so it can be read back correctly', () => {
    // The page is RTL. A bare uuid inside Arabic text reorders on screen, and
    // somebody reading it aloud or retyping it gets a different string.
    render(<LoadError failure={failure()} />);
    expect(screen.getByText('6b1f2c7e-0d3a-4a71-9f52-0f3f5b6a1c22')).toHaveAttribute('dir', 'ltr');
  });

  it('still offers retry, and still shows the message', () => {
    const onRetry = vi.fn();
    render(<LoadError failure={failure()} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('حدث خطأ في الخادم');
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeInTheDocument();
  });
});
