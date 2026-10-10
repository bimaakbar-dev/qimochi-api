import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import { getSession } from '../lib/session';

interface RatingRow {
  anime_id: string;
  average: number;
  votes: number;
}

async function getUserRating(
  ctx: Ctx,
  animeId: string,
  userId: string
): Promise<number | null> {
  const row = await ctx.env.DB.prepare(
    `SELECT score FROM ratings WHERE anime_id = ? AND user_id = ?`
  )
    .bind(animeId, userId)
    .first<{ score: number }>();
  return row?.score ?? null;
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
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);

  const row = await ctx.env.DB.prepare(
    'SELECT anime_id, average, votes FROM rating_summary WHERE anime_id = ?'
  )
    .bind(animeId)
    .first<RatingRow>();

  let userScore: number | null = null;
  if (session) {
    userScore = await getUserRating(ctx, animeId, session.sub);
  }

  return json(
    {
      data: {
        animeId,
        average: row?.average ?? 0,
        votes: row?.votes ?? 0,
        userScore,
        canRate: session !== null,
      },
    },
    ctx.env
  );
}

async function recomputeSummary(ctx: Ctx, animeId: string): Promise<void> {
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
}

async function postOne(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return error('UNAUTHORIZED', 'Login dulu untuk memberi rating', ctx.env, 401);
  }

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

  await ctx.env.DB.prepare(
    `INSERT INTO ratings (anime_id, user_id, score)
     VALUES (?, ?, ?)
     ON CONFLICT (anime_id, user_id)
     DO UPDATE SET score = excluded.score, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(animeId, session.sub, score)
    .run();

  await recomputeSummary(ctx, animeId);

  const summary = await ctx.env.DB.prepare(
    'SELECT average, votes FROM rating_summary WHERE anime_id = ?'
  )
    .bind(animeId)
    .first<{ average: number; votes: number }>();

  return json(
    {
      ok: true,
      data: {
        animeId,
        userScore: score,
        average: summary?.average ?? 0,
        votes: summary?.votes ?? 0,
      },
    },
    ctx.env
  );
}

async function deleteOne(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return error('UNAUTHORIZED', 'Login dulu', ctx.env, 401);
  }

  const animeId = ctx.params.id!;

  const result = await ctx.env.DB.prepare(
    'DELETE FROM ratings WHERE anime_id = ? AND user_id = ?'
  )
    .bind(animeId, session.sub)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    return error('NOT_FOUND', 'Rating tidak ditemukan', ctx.env, 404);
  }

  await recomputeSummary(ctx, animeId);

  const summary = await ctx.env.DB.prepare(
    'SELECT average, votes FROM rating_summary WHERE anime_id = ?'
  )
    .bind(animeId)
    .first<{ average: number; votes: number }>();

  return json(
    {
      ok: true,
      data: {
        animeId,
        userScore: null,
        average: summary?.average ?? 0,
        votes: summary?.votes ?? 0,
      },
    },
    ctx.env
  );
}

export function mountRatings(router: Router): void {
  router.get('/api/v1/ratings', listAll);
  router.get('/api/v1/ratings/:id', getOne);
  router.post('/api/v1/ratings/:id', postOne);
  router.delete('/api/v1/ratings/:id', deleteOne);
}
