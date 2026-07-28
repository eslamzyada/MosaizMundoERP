import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { classifyLoadFailure } from './loadFailure';

/**
 * Which of the four things went wrong.
 *
 * Every admin page used to answer this with one sentence covering all of them:
 * "check you are signed in and that the server is running". Two unrelated
 * instructions, at least one of which is always irrelevant, and no way for the
 * reader to tell which. The distinctions below are the entire point, and none
 * of them are visible from a screenshot — which is exactly the category of bug
 * that has been reaching a real device with CI green.
 */
describe('classifyLoadFailure', () => {
  /** An axios error shaped like a real HTTP response. */
  const httpError = (status: number) => {
    const headers = new AxiosHeaders();
    const config = { headers };
    return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, {
      status,
      statusText: '',
      data: {},
      headers,
      config,
    });
  };

  /** A request that never got an answer: server down, tunnel dead, no network. */
  const networkError = () => {
    const headers = new AxiosHeaders();
    return new AxiosError('Network Error', 'ERR_NETWORK', { headers }, {}, undefined);
  };

  it('an unreachable server is offline, and retryable', () => {
    // The tunnel dying and the backend stopping are indistinguishable from the
    // browser, and identical in what to do about them — hence one kind.
    const f = classifyLoadFailure(networkError());
    expect(f.kind).toBe('offline');
    expect(f.canRetry).toBe(true);
    expect(f.message).toContain('الاتصال');
  });

  it('401 is an expired session, and NOT retryable', () => {
    // Retrying a 401 fails every time. The honest instruction is to sign in.
    const f = classifyLoadFailure(httpError(401));
    expect(f.kind).toBe('unauthenticated');
    expect(f.canRetry).toBe(false);
    expect(f.message).toContain('الجلسة');
  });

  it('403 is a role limit, and says so instead of blaming the session', () => {
    // The old message told an accountant hitting a manager-only page to check
    // they were signed in. They were. Nothing they could do would help.
    const f = classifyLoadFailure(httpError(403));
    expect(f.kind).toBe('forbidden');
    expect(f.canRetry).toBe(false);
    expect(f.message).toContain('صلاحيات');
  });

  it('a 500 is the server breaking, not the reader doing something wrong', () => {
    const f = classifyLoadFailure(httpError(503));
    expect(f.kind).toBe('server');
    expect(f.canRetry).toBe(true);
    expect(f.status).toBe(503);
    // The code goes on screen: it is the one thing that makes a bug report useful.
    expect(f.message).toContain('503');
  });

  it('an unexpected 4xx is reported with its status rather than guessed at', () => {
    const f = classifyLoadFailure(httpError(418));
    expect(f.kind).toBe('unknown');
    expect(f.message).toContain('418');
    expect(f.canRetry).toBe(true);
  });

  it('a non-axios throw does not escape unclassified', () => {
    // A TypeError in a .then() lands here. It must still produce something
    // renderable rather than crashing the page that was reporting the error.
    const f = classifyLoadFailure(new TypeError('x is not a function'));
    expect(f.kind).toBe('unknown');
    expect(f.canRetry).toBe(true);
    expect(f.message.length).toBeGreaterThan(0);
  });

  it('every kind that cannot be retried says so, and vice versa', () => {
    // The rule the UI depends on: canRetry decides whether a button appears,
    // so a mismatch here puts a guaranteed-to-fail button on screen.
    expect(classifyLoadFailure(httpError(401)).canRetry).toBe(false);
    expect(classifyLoadFailure(httpError(403)).canRetry).toBe(false);
    expect(classifyLoadFailure(httpError(500)).canRetry).toBe(true);
    expect(classifyLoadFailure(networkError()).canRetry).toBe(true);
  });
});
