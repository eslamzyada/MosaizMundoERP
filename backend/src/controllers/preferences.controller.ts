import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Appearance settings (0032).
 *
 * Two endpoints with deliberately different shapes, because they answer to
 * different people: preferences are MINE and nobody needs permission to change
 * their own text size; branding is OURS and changing it is administrative.
 *
 * The user id is taken from the VERIFIED TOKEN and never from the request body.
 * RLS would refuse a forged one anyway, but an endpoint that accepts a user_id
 * is an endpoint somebody will eventually try, and the safest field is the one
 * that does not exist.
 */

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

/** Mirrors the CHECK in 0032. Below 80 is unreadable, above 200 does not fit. */
export const TEXT_SCALE_MIN = 80;
export const TEXT_SCALE_MAX = 200;

/** What a person gets before they have ever chosen anything. */
export const DEFAULT_PREFERENCES = { theme: 'system' as Theme, text_scale: 100 };

function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') return meta.code;
    return err.code;
  }
  return undefined;
}

async function resolveOrgId(req: Request): Promise<string | null> {
  const membership = await req.tx!.organization_memberships.findFirst({
    where: { user_id: req.userId!, is_active: true },
    orderBy: { created_at: 'asc' },
    select: { organization_id: true },
  });
  return membership?.organization_id ?? null;
}

/**
 * GET /api/preferences
 *
 * Always answers. A person who has never opened the settings page has no row,
 * and that is not an error — returning 404 would make every client implement
 * the defaults itself, and they would drift apart.
 */
export async function getPreferences(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  try {
    // RLS restricts this to the caller's own row, so findFirst cannot return
    // somebody else's even though it does not name a user.
    const row = await req.tx.user_preferences.findFirst({
      select: { theme: true, text_scale: true, updated_at: true },
    });

    res.status(200).json({
      theme: row?.theme ?? DEFAULT_PREFERENCES.theme,
      text_scale: row?.text_scale ?? DEFAULT_PREFERENCES.text_scale,
      /** False when these are the defaults rather than a stored choice. */
      is_stored: row !== null,
      updated_at: row?.updated_at ?? null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[preferences.get] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PUT /api/preferences  { theme?, text_scale? }
 *
 * Partial: sending only a theme leaves the text size alone, so the settings
 * page does not have to send back values the user did not touch.
 */
export async function updatePreferences(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: { theme?: Theme; text_scale?: number } = {};

  if (body.theme !== undefined) {
    if (typeof body.theme !== 'string' || !(THEMES as readonly string[]).includes(body.theme)) {
      res.status(400).json({ error: `theme must be one of: ${THEMES.join(', ')}` });
      return;
    }
    patch.theme = body.theme as Theme;
  }

  if (body.text_scale !== undefined) {
    const scale = Number(body.text_scale);
    if (!Number.isInteger(scale) || scale < TEXT_SCALE_MIN || scale > TEXT_SCALE_MAX) {
      res.status(400).json({
        error: `text_scale must be a whole number between ${TEXT_SCALE_MIN} and ${TEXT_SCALE_MAX}`,
      });
      return;
    }
    patch.text_scale = scale;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(403).json({ error: 'No active organization membership' });
      return;
    }

    // The composite key is (organization_id, user_id) and BOTH come from the
    // session — never from the body.
    const saved = await req.tx.user_preferences.upsert({
      where: {
        organization_id_user_id: { organization_id: orgId, user_id: req.userId! },
      },
      create: { organization_id: orgId, user_id: req.userId!, ...patch },
      update: patch,
      select: { theme: true, text_scale: true, updated_at: true },
    });

    res.status(200).json({ ...saved, is_stored: true });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '23514') {
      // The validation above should make this unreachable; if it fires, the API
      // and the CHECK have drifted apart and saying so beats a 500.
      res.status(400).json({ error: 'The preferences were rejected by the database' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[preferences.update] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/branding
 *
 * Open to every member: a till prints the logo, so a cashier who cannot read
 * this cannot produce a receipt that carries it.
 */
export async function getBranding(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  try {
    const row = await req.tx.organization_branding.findFirst({
      select: { logo_url: true, display_name: true, updated_at: true },
    });
    res.status(200).json({
      logo_url: row?.logo_url ?? null,
      display_name: row?.display_name ?? null,
      updated_at: row?.updated_at ?? null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[branding.get] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PUT /api/branding  { logo_url?, display_name? }
 *
 * Either field may be set to null explicitly, which is how a logo is removed —
 * distinct from omitting it, which leaves it alone.
 */
export async function updateBranding(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: { logo_url?: string | null; display_name?: string | null } = {};

  for (const field of ['logo_url', 'display_name'] as const) {
    if (body[field] === undefined) continue;
    if (body[field] === null) {
      patch[field] = null;
      continue;
    }
    if (typeof body[field] !== 'string' || (body[field] as string).trim() === '') {
      res.status(400).json({ error: `${field} must be a non-empty string, or null to clear it` });
      return;
    }
    patch[field] = (body[field] as string).trim();
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(403).json({ error: 'No active organization membership' });
      return;
    }

    const saved = await req.tx.organization_branding.upsert({
      where: { organization_id: orgId },
      create: { organization_id: orgId, ...patch },
      update: patch,
      select: { logo_url: true, display_name: true, updated_at: true },
    });

    res.status(200).json(saved);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '42501') {
      res.status(403).json({ error: 'Changing the branding is limited to managers' });
      return;
    }
    if (code === '23514') {
      res.status(400).json({ error: 'The branding was rejected by the database' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[branding.update] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
