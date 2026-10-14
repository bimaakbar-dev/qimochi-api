import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import { getSession } from '../lib/session';
import { checkRateLimit, hashKey } from '../lib/ratelimit';

const ALLOWED_TARGETS = ['episode'] as const;
type Target = (typeof ALLOWED_TARGETS)[number];

interface CountRow {
  value: number;
  c: number;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  if (!slug || !SLUG_RE.test(slug)) return null;
  return slug;
}

function parseEpisode(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 9999) return null;
  return n;
}

function parseValue(value: unknown): 1 | 0 | -1 | null {
  const n = Number(value);
  if (n === 1 || n === 0 || n === -1) return n as 1 | 0 | -1;
  return null;
}

async function getCounts(
  ctx: Ctx,
  slug: string,
  episode: number
): Promise<{ likes: number; dislikes: number }> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT value, COUNT(*) as c
       FROM episode_votes
      WHERE slug = ? AND episode = ?
      GROUP BY value`
  )
    .bind(slug, episode)
    .all<CountRow>();

  let likes = 0;
  let dislikes = 0;
  for (const r of results ?? []) {
    if (r.value === 1) likes = r.c;
    else if (r.value === -1) dislikes = r.c;
  }
  return { likes, dislikes };
}

async function getUserVote(
  ctx: Ctx,
  slug: string,
  episode: number,
  userId: string | null
): Promise<1 | 0 | -1> {
  if (!userId) return 0;

  const row = await ctx.env.DB.prepare(
    `SELECT value FROM episode_votes
      WHERE user_id = ? AND slug = ? AND episode = ?`
  )
    .bind(userId, slug, episode)
    .first<{ value: number }>();

  if (!row) return 0;
  if (row.value === 1 || row.value === -1) return row.value;
  return 0;
}

async function getVotes(ctx: Ctx): Promise<Response> {
  const target = ctx.url.searchParams.get('target') ?? 'episode';
  if (!ALLOWED_TARGETS.includes(target as Target)) {
    return error('INVALID_TARGET', 'Target tidak didukung', ctx.env, 400);
  }

  const slug = parseSlug(ctx.url.searchParams.get('slug'));
  if (!slug) {
    return error('INVALID_SLUG', 'Slug tidak valid', ctx.env, 400);
  }

  const episode = parseEpisode(ctx.url.searchParams.get('ep'));
  if (episode === null) {
    return error('INVALID_EPISODE', 'Nomor episode tidak valid', ctx.env, 400);
  }

  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);

  const [counts, userVote] = await Promise.all([
    getCounts(ctx, slug, episode),
    getUserVote(ctx, slug, episode, session?.sub ?? null),
  ]);

  return json(
    {
      data: {
        slug,
        episode,
        likes: counts.likes,
        dislikes: counts.dislikes,
        userVote,
        canVote: session !== null,
      },
    },
    ctx.env,
    200,
    { 'Cache-Control': 'no-store' }
  );
}

async function postVote(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return error('UNAUTHORIZED', 'Login dulu untuk vote', ctx.env, 401);
  }

  let body: {
    target?: string;
    slug?: string;
    ep?: number | string;
    value?: number | string;
  };
  try {
    body = (await ctx.request.json()) as typeof body;
  } catch {
    return error('INVALID_JSON', 'Body bukan JSON valid', ctx.env, 400);
  }

  const target = body.target ?? 'episode';
  if (!ALLOWED_TARGETS.includes(target as Target)) {
    return error('INVALID_TARGET', 'Target tidak didukung', ctx.env, 400);
  }

  const slug = parseSlug(body.slug);
  if (!slug) {
    return error('INVALID_SLUG', 'Slug tidak valid', ctx.env, 400);
  }

  const episode = parseEpisode(body.ep);
  if (episode === null) {
    return error('INVALID_EPISODE', 'Nomor episode tidak valid', ctx.env, 400);
  }

  const value = parseValue(body.value);
  if (value === null) {
    return error('INVALID_VALUE', 'Value harus 1, -1, atau 0', ctx.env, 400);
  }

  const key = await hashKey(`vote:${session.sub}`);
  const limit = await checkRateLimit(ctx.env.DB, `${key}:m`, 60, 60);
  if (!limit.ok) {
    return json(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Terlalu cepat, tunggu sebentar',
          status: 429,
        },
      },
      ctx.env,
      429,
      { 'Retry-After': String(limit.retryAfter) }
    );
  }

  const now = Math.floor(Date.now() / 1000);

  if (value === 0) {
    await ctx.env.DB.prepare(
      `DELETE FROM episode_votes
        WHERE user_id = ? AND slug = ? AND episode = ?`
    )
      .bind(session.sub, slug, episode)
      .run();
  } else {
    await ctx.env.DB.prepare(
      `INSERT INTO episode_votes
         (user_id, slug, episode, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, slug, episode) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
      .bind(session.sub, slug, episode, value, now, now)
      .run();
  }

  const [counts, userVote] = await Promise.all([
    getCounts(ctx, slug, episode),
    getUserVote(ctx, slug, episode, session.sub),
  ]);

  return json(
    {
      ok: true,
      data: {
        slug,
        episode,
        likes: counts.likes,
        dislikes: counts.dislikes,
        userVote,
        canVote: true,
      },
    },
    ctx.env
  );
}

export function mountVotes(router: Router): void {
  router.get('/api/v1/votes', getVotes);
  router.post('/api/v1/votes', postVote);
}
