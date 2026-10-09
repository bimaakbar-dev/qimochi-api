import type { Env } from '../env';
import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';

interface RatingRow {
  anime_id: string;
  average: number;
  votes: number;
}

async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + 'qimochi-salt-v1');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

function getUserId(request: Request): string | null {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  return ip;
}

async function listAll(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare(
    'SELECT anime_id, average, votes FROM rating_summary WHERE votes > 0 ORDER BY anime_id'
  ).all<RatingRow>();

  const data: Record<string, { average: number; votes: number }> = {};
  for (const row of results ?? []) {
    data[row.anime_id] = { average: row.average, votes: row.votes };
  }

  return json({ data, total: Object.keys(data).length }, ctx.env);
}

async function getOne(ctx: Ctx): Promise<Response> {
  const animeId = ctx.params.id!;
  const row = await ctx.env.DB.prepare(
    'SELECT anime_id, average, votes FROM rating_summary WHERE anime_id = ?'
  )
    .bind(animeId)
    .first<RatingRow>();

  if (!row) return json({ data: { animeId, average: 0, votes: 0 } }, ctx.env);

  return json(
    { data: { animeId: row.anime_id, average: row.average, votes: row.votes } },
    ctx.env
  );
}

async function postOne(ctx: Ctx): Promise<Response> {
  const animeId = ctx.params.id!;

  let body: { score?: number };
  try {
    body = (await ctx.request.json()) as { score?: number };
  } catch {
    return error('INVALID_JSON', 'Body bukan JSON valid', ctx.env, 400);
  }

  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return error('INVALID_SCORE', 'Score harus integer 1-5', ctx.env, 400);
  }

  const userId = getUserId(ctx.request);
  if (!userId) return error('NO_USER_ID', 'Tidak bisa identifikasi user', ctx.env, 400);
  const userHash = await hashIP(userId);

  await ctx.env.DB.prepare(
    `INSERT INTO ratings (anime_id, user_id, score)
     VALUES (?, ?, ?)
     ON CONFLICT (anime_id, user_id)
     DO UPDATE SET score = excluded.score, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(animeId, userHash, score)
    .run();

  await ctx.env.DB.prepare(
    `INSERT INTO rating_summary (anime_id, average, votes, updated_at)
     SELECT ?, COALESCE(AVG(score) * 2, 0), COUNT(*), CURRENT_TIMESTAMP
     FROM ratings WHERE anime_id = ?
     ON CONFLICT (anime_id)
     DO UPDATE SET
       average = excluded.average,
       votes = excluded.votes,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(animeId, animeId)
    .run();

  const summary = await ctx.env.DB.prepare(
    'SELECT average, votes FROM rating_summary WHERE anime_id = ?'
  )
    .bind(animeId)
    .first<{ average: number; votes: number }>();

  return json(
    {
      ok: true,
      message: 'Rating tersimpan',
      data: {
        animeId,
        yourScore: score,
        average: summary?.average ?? 0,
        votes: summary?.votes ?? 0,
      },
    },
    ctx.env
  );
}

async function deleteOne(ctx: Ctx): Promise<Response> {
  const animeId = ctx.params.id!;

  const userId = getUserId(ctx.request);
  if (!userId) return error('NO_USER_ID', 'Tidak bisa identifikasi user', ctx.env, 400);
  const userHash = await hashIP(userId);

  const result = await ctx.env.DB.prepare(
    'DELETE FROM ratings WHERE anime_id = ? AND user_id = ?'
  )
    .bind(animeId, userHash)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    return error('NOT_FOUND', 'Rating tidak ditemukan', ctx.env, 404);
  }

  await ctx.env.DB.prepare(
    `INSERT INTO rating_summary (anime_id, average, votes, updated_at)
     SELECT ?, COALESCE(AVG(score) * 2, 0), COUNT(*), CURRENT_TIMESTAMP
     FROM ratings WHERE anime_id = ?
     ON CONFLICT (anime_id)
     DO UPDATE SET
       average = excluded.average,
       votes = excluded.votes,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(animeId, animeId)
    .run();

  return json({ ok: true, message: 'Rating dihapus' }, ctx.env);
}

export function mountRatings(router: Router): void {
  router.get('/api/v1/ratings', listAll);
  router.get('/api/v1/ratings/:id', getOne);
  router.post('/api/v1/ratings/:id', postOne);
  router.delete('/api/v1/ratings/:id', deleteOne);
}