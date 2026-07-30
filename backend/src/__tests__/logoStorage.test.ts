import {
  ALLOWED_LOGO_TYPES,
  LogoStorageNotConfigured,
  LogoUploadFailed,
  MAX_LOGO_BYTES,
  uploadLogo,
} from '../lib/logoStorage';

/**
 * Putting a logo in Supabase Storage.
 *
 * No network here — `fetch` is replaced, so what is asserted is the REQUEST
 * this builds: which bucket, which path, which headers. Those are the details
 * that fail silently. An upload that quietly overwrites the previous logo, or
 * one that sends the service key to the wrong host, both look like success.
 */

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = { ...process.env };

function png(bytes = 64) {
  return { buffer: Buffer.alloc(bytes, 1), mimetype: 'image/png', size: bytes };
}

/** Captures the request instead of making it. */
function captureFetch(response: Partial<Response> = { ok: true, status: 200 }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      ...response,
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-not-a-real-credential';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
});

describe('uploadLogo', () => {
  it('says exactly which credential is missing, rather than failing vaguely', async () => {
    // This is the first thing anyone setting the feature up will hit, and a
    // generic "upload failed" would send them looking at the image.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    captureFetch();

    await expect(uploadLogo('org-1', png())).rejects.toBeInstanceOf(LogoStorageNotConfigured);
    await expect(uploadLogo('org-1', png())).rejects.toThrow('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('does not attempt the upload at all when unconfigured', async () => {
    delete process.env.SUPABASE_URL;
    const calls = captureFetch();

    await expect(uploadLogo('org-1', png())).rejects.toBeInstanceOf(LogoStorageNotConfigured);
    expect(calls).toHaveLength(0);
  });

  it('sends the service key to the configured project, in the branding bucket', async () => {
    const calls = captureFetch();

    await uploadLogo('org-abc', png());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /^https:\/\/project\.supabase\.co\/storage\/v1\/object\/branding\/org-abc\//,
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer service-key-not-a-real-credential');
    expect(headers['Content-Type']).toBe('image/png');
  });

  it('NEVER overwrites: x-upsert is false and every upload gets a new path', async () => {
    // Overwriting one path would leave browsers and caches showing the old
    // image until it happened to expire — the logo would look unchanged.
    const calls = captureFetch();

    await uploadLogo('org-abc', png());
    await uploadLogo('org-abc', png());

    const headers = calls.map((c) => c.init.headers as Record<string, string>);
    expect(headers[0]['x-upsert']).toBe('false');
    expect(calls[0].url).not.toBe(calls[1].url);
  });

  it('returns a PUBLIC url, which is what gets printed on a receipt', async () => {
    captureFetch();
    const url = await uploadLogo('org-abc', png());
    expect(url).toContain('/storage/v1/object/public/branding/org-abc/');
  });

  it('keeps each organization in its own folder', async () => {
    const calls = captureFetch();
    await uploadLogo('org-one', png());
    await uploadLogo('org-two', png());
    expect(calls[0].url).toContain('/branding/org-one/');
    expect(calls[1].url).toContain('/branding/org-two/');
  });

  it('refuses a type the bucket would refuse anyway, without a round trip', async () => {
    const calls = captureFetch();
    await expect(
      uploadLogo('org-1', { buffer: Buffer.alloc(8), mimetype: 'application/pdf', size: 8 }),
    ).rejects.toBeInstanceOf(LogoUploadFailed);
    expect(calls).toHaveLength(0);
  });

  it('refuses an oversized image before sending it', async () => {
    const calls = captureFetch();
    const huge = { buffer: Buffer.alloc(16), mimetype: 'image/png', size: MAX_LOGO_BYTES + 1 };
    await expect(uploadLogo('org-1', huge)).rejects.toBeInstanceOf(LogoUploadFailed);
    expect(calls).toHaveLength(0);
  });

  it("passes Supabase's own refusal through rather than inventing one", async () => {
    // "mime type not supported" from the bucket is more useful than anything
    // this layer could guess at.
    captureFetch({ ok: false, status: 413, text: async () => 'Payload too large' } as Partial<Response>);
    await expect(uploadLogo('org-1', png())).rejects.toThrow(/413.*Payload too large/);
  });

  it('accepts every type the bucket allows', async () => {
    const calls = captureFetch();
    for (const mimetype of ALLOWED_LOGO_TYPES) {
      await uploadLogo('org-1', { buffer: Buffer.alloc(8), mimetype, size: 8 });
    }
    expect(calls).toHaveLength(ALLOWED_LOGO_TYPES.length);
  });
});
