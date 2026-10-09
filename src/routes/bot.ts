import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import { requireBot } from '../lib/botauth';

interface PendingRow {
  id: string;
  slug: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  created_at: number;
  name: string;
  email: string;
}

async function purgeCacheForSlug(slug: string): Promise<void> {
  try {
    const url = new URL('https://api.qimochi.web.id/api/v1/comments');
    url.searchParams.set('slug', slug);
    await caches.default.delete(url.toString());
  } catch {
    // ignore
  }
}

async function guard(ctx: Ctx): Promise<Response | null> {
  const ok = await requireBot(ctx.request, ctx.env.BOT_SECRET);
  if (!ok) {
    return error('UNAUTHORIZED', 'Bot secret tidak valid', ctx.env, 401);
  }
  return null;
}

async function pending(ctx: Ctx): Promise<Response> {
  const blocked = await guard(ctx);
  if (blocked) return blocked;

  const limit = Math.min(
    Math.max(parseInt(ctx.url.searchParams.get('limit') ?? '50', 10) || 50, 1),
    200
  );

  const { results } = await ctx.env.DB.prepare(
    `SELECT c.id, c.slug, c.user_id, c.parent_id, c.body, c.created_at,
            u.name, u.email
       FROM comments c
       JOIN users u ON u.id = c.user_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at ASC
      LIMIT ?`
  )
    .bind(limit)
    .all<PendingRow>();

  const data = (results ?? []).map((row) => ({
    id: row.id,
    slug: row.slug,
    parentId: row.parent_id,
    body: row.body,
    createdAt: row.created_at,
    user: { sub: row.user_id, name: row.name, email: row.email },
  }));

  return json({ data, total: data.length }, ctx.env);
}

interface ModerateBody {
  reason?: string;
  score?: number;
  moderator?: string;
}

async function parseModerateBody(ctx: Ctx): Promise<ModerateBody> {
  try {
    return (await ctx.request.json()) as ModerateBody;
  } catch {
    return {};
  }
}

async function approve(ctx: Ctx): Promise<Response> {
  const blocked = await guard(ctx);
  if (blocked) return blocked;

  const id = ctx.params.id!;
  const body = await parseModerateBody(ctx);
  const now = Math.floor(Date.now() / 1000);

  const row = await ctx.env.DB.prepare(
    `SELECT id, slug, status FROM comments WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; slug: string; status: string }>();

  if (!row) return error('NOT_FOUND', 'Komentar tidak ditemukan', ctx.env, 404);
  if (row.status === 'approved') {
    return json({ ok: true, already: true }, ctx.env);
  }

  await ctx.env.DB.prepare(
    `UPDATE comments
        SET status = 'approved',
            approved_at = ?,
            moderated_by = ?,
            score = ?,
            reason = ?
      WHERE id = ?`
  )
    .bind(
      now,
      body.moderator ?? 'bot',
      typeof body.score === 'number' ? body.score : null,
      body.reason ?? null,
      id
    )
    .run();

  ctx.exec.waitUntil(purgeCacheForSlug(row.slug));

  return json({ ok: true, id, slug: row.slug, status: 'approved' }, ctx.env);
}

async function reject(ctx: Ctx): Promise<Response> {
  const blocked = await guard(ctx);
  if (blocked) return blocked;

  const id = ctx.params.id!;
  const body = await parseModerateBody(ctx);

  const row = await ctx.env.DB.prepare(
    `SELECT id, slug, status FROM comments WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; slug: string; status: string }>();

  if (!row) return error('NOT_FOUND', 'Komentar tidak ditemukan', ctx.env, 404);
  if (row.status === 'rejected') {
    return json({ ok: true, already: true }, ctx.env);
  }

  await ctx.env.DB.prepare(
    `UPDATE comments
        SET status = 'rejected',
            moderated_by = ?,
            score = ?,
            reason = ?
      WHERE id = ?`
  )
    .bind(
      body.moderator ?? 'bot',
      typeof body.score === 'number' ? body.score : null,
      body.reason ?? null,
      id
    )
    .run();

  return json(
    { ok: true, id, slug: row.slug, status: 'rejected' },
    ctx.env
  );
}

export function mountBot(router: Router): void {
  router.get('/api/v1/bot/pending', pending);
  router.post('/api/v1/bot/comments/:id/approve', approve);
  router.post('/api/v1/bot/comments/:id/reject', reject);
}