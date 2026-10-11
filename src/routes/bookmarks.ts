import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import { getSession } from '../lib/session';

interface BookmarkRow {
  anime_id: string;
  created_at: number;
}

async function listAll(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return error('UNAUTHORIZED', 'Login dulu', ctx.env, 401);
  }

  const { results } = await ctx.env.DB.prepare(
    `SELECT anime_id, created_at
       FROM bookmarks
      WHERE user_id = ?
      ORDER BY created_at DESC`
  )
    .bind(session.sub)
    .all<BookmarkRow>();

  const data = (results ?? []).map((r) => ({
    animeId: r.anime_id,
    createdAt: r.created_at,
  }));

  return json({ data, total: data.length }, ctx.env, 200, {
    'Cache-Control': 'no-store',
  });
}

async function getOne(ctx: Ctx): Promise<Response> {
  const animeId = ctx.params.id!;
  if (!animeId) {
    return error('MISSING_ID', 'ID anime wajib diisi', ctx.env, 400);
  }

  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);

  if (!session) {
    return json(
      { data: { animeId, bookmarked: false } },
      ctx.env,
      200,
      { 'Cache-Control': 'no-store' }
    );
  }

  const row = await ctx.env.DB.prepare(
    `SELECT 1 FROM bookmarks WHERE user_id = ? AND anime_id = ?`
  )
    .bind(session.sub, animeId)
    .first<{ 1: number }>();

  return json(
    { data: { animeId, bookmarked: row !== null } },
    ctx.env,
    200,
    { 'Cache-Control': 'no-store' }
  );
}

async function addOne(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return error('UNAUTHORIZED', 'Login dulu untuk menyimpan', ctx.env, 401);
  }

  const animeId = ctx.params.id!;
  if (!animeId) {
    return error('MISSING_ID', 'ID anime wajib diisi', ctx.env, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  await ctx.env.DB.prepare(
    `INSERT INTO bookmarks (user_id, anime_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT (user_id, anime_id) DO NOTHING`
  )
    .bind(session.sub, animeId, now)
    .run();

  return json(
    { ok: true, data: { animeId, bookmarked: true } },
    ctx.env
  );
}

async function removeOne(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return error('UNAUTHORIZED', 'Login dulu', ctx.env, 401);
  }

  const animeId = ctx.params.id!;
  if (!animeId) {
    return error('MISSING_ID', 'ID anime wajib diisi', ctx.env, 400);
  }

  await ctx.env.DB.prepare(
    `DELETE FROM bookmarks WHERE user_id = ? AND anime_id = ?`
  )
    .bind(session.sub, animeId)
    .run();

  return json(
    { ok: true, data: { animeId, bookmarked: false } },
    ctx.env
  );
}

export function mountBookmarks(router: Router): void {
  router.get('/api/v1/bookmarks', listAll);
  router.get('/api/v1/bookmarks/:id', getOne);
  router.post('/api/v1/bookmarks/:id', addOne);
  router.delete('/api/v1/bookmarks/:id', removeOne);
}