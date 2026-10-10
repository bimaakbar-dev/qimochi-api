import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import { getSession } from '../lib/session';
import { checkRateLimit, hashKey } from '../lib/ratelimit';

const ALLOWED_EMOJI = ['👍', '❤️', '🔥', '😂', '😮'] as const;

interface ReactionRow {
  emoji: string;
  c: number;
}

interface UserReactionRow {
  emoji: string;
}

async function getCounts(
  ctx: Ctx,
  animeId: string
): Promise<Record<string, number>> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT emoji, COUNT(*) as c FROM anime_reactions WHERE anime_id = ? GROUP BY emoji`
  )
    .bind(animeId)
    .all<ReactionRow>();

  const counts: Record<string, number> = {};
  for (const e of ALLOWED_EMOJI) counts[e] = 0;
  for (const r of results ?? []) {
    if (r.emoji in counts) counts[r.emoji] = r.c;
  }
  return counts;
}

async function getUserReactions(
  ctx: Ctx,
  animeId: string,
  userId: string
): Promise<string[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT emoji FROM anime_reactions WHERE anime_id = ? AND user_id = ?`
  )
    .bind(animeId, userId)
    .all<UserReactionRow>();

  return (results ?? []).map((r) => r.emoji);
}

async function getOne(ctx: Ctx): Promise<Response> {
  const animeId = ctx.params.id!;
  if (!animeId) {
    return error('MISSING_ID', 'ID anime wajib diisi', ctx.env, 400);
  }

  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  const counts = await getCounts(ctx, animeId);

  let userReactions: string[] = [];
  if (session) {
    userReactions = await getUserReactions(ctx, animeId, session.sub);
  }

  return json(
    {
      data: {
        animeId,
        counts,
        userReactions,
        canReact: session !== null,
        allowed: ALLOWED_EMOJI,
      },
    },
    ctx.env,
    200,
    { 'Cache-Control': 'no-store' }
  );
}

async function toggleReaction(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return error('UNAUTHORIZED', 'Login dulu untuk bereaksi', ctx.env, 401);
  }

  const animeId = ctx.params.id!;
  if (!animeId) {
    return error('MISSING_ID', 'ID anime wajib diisi', ctx.env, 400);
  }

  let body: { emoji?: string };
  try {
    body = (await ctx.request.json()) as { emoji?: string };
  } catch {
    return error('INVALID_JSON', 'Body bukan JSON valid', ctx.env, 400);
  }

  const emoji = typeof body.emoji === 'string' ? body.emoji : '';
  if (!ALLOWED_EMOJI.includes(emoji as (typeof ALLOWED_EMOJI)[number])) {
    return error('INVALID_EMOJI', 'Emoji tidak didukung', ctx.env, 400);
  }

  const key = await hashKey(`reaction:${session.sub}`);
  const limit = await checkRateLimit(ctx.env.DB, `${key}:m`, 30, 60);
  if (!limit.ok) {
    return error('RATE_LIMITED', 'Terlalu cepat', ctx.env, 429);
  }

  const existing = await ctx.env.DB.prepare(
    `SELECT 1 FROM anime_reactions
      WHERE anime_id = ? AND user_id = ? AND emoji = ?`
  )
    .bind(animeId, session.sub, emoji)
    .first<{ 1: number }>();

  const now = Math.floor(Date.now() / 1000);

  if (existing) {
    await ctx.env.DB.prepare(
      `DELETE FROM anime_reactions
        WHERE anime_id = ? AND user_id = ? AND emoji = ?`
    )
      .bind(animeId, session.sub, emoji)
      .run();
  } else {
    await ctx.env.DB.prepare(
      `INSERT INTO anime_reactions (anime_id, user_id, emoji, created_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(animeId, session.sub, emoji, now)
      .run();
  }

  const counts = await getCounts(ctx, animeId);
  const userReactions = await getUserReactions(ctx, animeId, session.sub);

  return json(
    {
      ok: true,
      data: {
        animeId,
        counts,
        userReactions,
        canReact: true,
        allowed: ALLOWED_EMOJI,
      },
    },
    ctx.env
  );
}

export function mountReactions(router: Router): void {
  router.get('/api/v1/reactions/:id', getOne);
  router.post('/api/v1/reactions/:id', toggleReaction);
}
