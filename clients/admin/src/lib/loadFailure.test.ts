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

/**
 * The reference.
 *
 * The API gives every request a correlation id and returns it. It is the one
 * string that leads from "it broke around 8:40" to the exact line in the log,
 * so the classifier has to carry it as far as the screen.
 */
describe('the correlation id', () => {
  const withReference = (
    status: number,
    opts: { header?: string; body?: Record<string, unknown> } = {},
  ) => {
    const headers = new AxiosHeaders();
    if (opts.header) headers.set('x-request-id', opts.header);
    const config = { headers };
    return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, {
      status,
      statusText: '',
      data: opts.body ?? {},
      headers,
      config,
    });
  };

  it('is taken from the response header', () => {
    const f = classifyLoadFailure(withReference(500, { header: 'abc-123' }));
    expect(f.reference).toBe('abc-123');
  });

  it('prefers the header over the body, because the header is on EVERY response', () => {
    // Only the centralized handler puts request_id in the body. The many 500s
    // that controllers answer themselves have the header and nothing else, so
    // the header is the one that always works.
    const f = classifyLoadFailure(
      withReference(500, { header: 'from-header', body: { request_id: 'from-body' } }),
    );
    expect(f.reference).toBe('from-header');
  });

  it('falls back to the body when the header did not survive', () => {
    // A proxy that strips unknown headers, or a CORS configuration that forgot
    // to expose it — the body is the second chance.
    const f = classifyLoadFailure(withReference(500, { body: { request_id: 'from-body' } }));
    expect(f.reference).toBe('from-body');
  });

  it('is absent when the request never reached the server', () => {
    // Nothing answered, so there is nothing to correlate with. Claiming a
    // reference here would send somebody looking for a line that does not exist.
    const noResponse = new AxiosError(
      'Network Error',
      'ERR_NETWORK',
      { headers: new AxiosHeaders() },
      {},
      undefined,
    );
    expect(classifyLoadFailure(noResponse).reference).toBeUndefined();
  });

  it('is absent when the response carried none', () => {
    const f = classifyLoadFailure(withReference(500));
    expect(f.reference).toBeUndefined();
  });
});
