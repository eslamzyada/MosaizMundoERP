import { randomUUID } from 'crypto';

/**
 * Putting a logo in Supabase Storage.
 *
 * WHY THE BACKEND DOES THIS AND NOT THE BROWSER.
 *
 * A Supabase Storage policy can see who is signed in and what path they are
 * writing to — and nothing else. It cannot see organization_memberships,
 * because that table lives in this project's OWN Postgres, not in Supabase.
 * Supabase is only the identity provider here.
 *
 * So a browser uploading directly could be restricted to "any signed-in user",
 * which would let a cashier overwrite the restaurant's logo. The rule that
 * matters — only an administrator changes the branding — can only be enforced
 * where the roles are, which is here.
 *
 * The bucket therefore has RLS on with NO policies (nothing a client can do)
 * and public read (a logo is printed on customer receipts). The service role
 * bypasses RLS, and its key never leaves the server.
 */

export class LogoStorageNotConfigured extends Error {
  constructor(missing: string) {
    super(
      `${missing} is not set. Add it to backend/.env — the service role key is ` +
        'in the Supabase dashboard under Project Settings → API. It must never ' +
        'be sent to a browser.',
    );
  }
}

export class LogoUploadFailed extends Error {}

/** Mirrors the bucket's own allowed_mime_types, so a refusal happens here first. */
export const ALLOWED_LOGO_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
] as const;

/** 2 MB, the same ceiling the bucket enforces. A logo needs nothing near it. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * Uploads [file] and returns its public URL.
 *
 * The path carries the organization AND a fresh uuid per upload. The uuid is
 * not for secrecy — the bucket is public — but so a replacement gets a NEW url:
 * overwriting one path would leave every browser and every already-printed
 * cache showing the old image until it happened to expire.
 */
export async function uploadLogo(
  organizationId: string,
  file: { buffer: Buffer; mimetype: string; size: number },
): Promise<string> {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!baseUrl) throw new LogoStorageNotConfigured('SUPABASE_URL');
  if (!serviceKey) throw new LogoStorageNotConfigured('SUPABASE_SERVICE_ROLE_KEY');

  if (!(ALLOWED_LOGO_TYPES as readonly string[]).includes(file.mimetype)) {
    throw new LogoUploadFailed(
      `Unsupported image type ${file.mimetype}. Allowed: ${ALLOWED_LOGO_TYPES.join(', ')}`,
    );
  }
  if (file.size > MAX_LOGO_BYTES) {
    throw new LogoUploadFailed(`The image is larger than ${MAX_LOGO_BYTES / 1024 / 1024} MB`);
  }

  const root = baseUrl.replace(/\/+$/, '');
  const path = `${organizationId}/${randomUUID()}.${EXTENSIONS[file.mimetype]}`;

  const response = await fetch(`${root}/storage/v1/object/branding/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': file.mimetype,
      // Never overwrite: a new upload is a new object, so the URL changes and
      // caches cannot serve a stale logo.
      'x-upsert': 'false',
    },
    body: new Uint8Array(file.buffer),
  });

  if (!response.ok) {
    // Supabase's own message is more specific than anything invented here —
    // "mime type not supported", "exceeded maximum size", "bucket not found".
    const detail = await response.text().catch(() => '');
    throw new LogoUploadFailed(
      `Supabase Storage refused the upload (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    );
  }

  return `${root}/storage/v1/object/public/branding/${path}`;
}
