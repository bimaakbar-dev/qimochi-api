import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import { getSession } from '../lib/session';
import { verifyTurnstile } from '../lib/turnstile';
import { checkRateLimit, getClientIp, hashKey } from '../lib/ratelimit';
import { notifyTelegram } from './telegram';

const MAX_BODY_LEN = 2000;
const MIN_BODY_LEN = 2;

interface CommentRow {
  id: string;
  slug: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  status: string;
  created_at: number;
  name: string;
  picture: string | null;
}

interface PublicComment {
  id: string;
  slug: string;
  parentId: string | null;
  body: string;
  status: string;
  createdAt: number;
  isOwn: boolean;
  user: {
    sub: string;
    name: string;
    picture: string | null;
  };
}

function slugify(input: string): string {
  return input.trim().toLowerCase();
}

function sanitizeBody(input: string): string {
  return input.replace(/\r\n/g, '\n').trim();
}

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toPublic(row: CommentRow, viewerSub: string | null): PublicComment {
  return {
    id: row.id,
    slug: row.slug,
    parentId: row.parent_id,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    isOwn: viewerSub !== null && viewerSub === row.user_id,
    user: {
      sub: row.user_id,
      name: row.name,
      picture: row.picture,
    },
  };
}

async function listComments(ctx: Ctx): Promise<Response> {
  const slug = slugify(ctx.url.searchParams.get('slug') ?? '');
  if (!slug) {
    return error('MISSING_SLUG', 'Query slug wajib diisi', ctx.env, 400);
  }

  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  const viewerSub = session?.sub ?? null;

  let rows: CommentRow[] = [];

  if (viewerSub) {
    const res = await ctx.env.DB.prepare(
      `SELECT c.id, c.slug, c.user_id, c.parent_id, c.body, c.status,
              c.created_at, u.name, u.picture
         FROM comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.slug = ? AND (
          c.status = 'approved'
          OR (c.user_id = ? AND c.status IN ('pending', 'rejected'))
        )
        ORDER BY c.created_at ASC
        LIMIT 300`
    )
      .bind(slug, viewerSub)
      .all<CommentRow>();
    rows = res.results ?? [];
  } else {
    const res = await ctx.env.DB.prepare(
      `SELECT c.id, c.slug, c.user_id, c.parent_id, c.body, c.status,
              c.created_at, u.name, u.picture
         FROM comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.slug = ? AND c.status = 'approved'
        ORDER BY c.created_at ASC
        LIMIT 300`
    )
      .bind(slug)
      .all<CommentRow>();
    rows = res.results ?? [];
  }

  const data = rows.map((r) => toPublic(r, viewerSub));

  return json({ data, total: data.length }, ctx.env, 200, {
    'Cache-Control': 'no-store',
  });
}

async function createComment(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return error('UNAUTHORIZED', 'Login dulu untuk berkomentar', ctx.env, 401);
  }

  let body: {
    slug?: string;
    body?: string;
    parentId?: string | null;
    turnstileToken?: string;
  };
  try {
    body = (await ctx.request.json()) as typeof body;
  } catch {
    return error('INVALID_JSON', 'Body bukan JSON valid', ctx.env, 400);
  }

  const slug = slugify(body.slug ?? '');
  if (!slug) {
    return error('MISSING_SLUG', 'Slug wajib diisi', ctx.env, 400);
  }

  const rawText = typeof body.body === 'string' ? body.body : '';
  const text = sanitizeBody(rawText);
  if (text.length < MIN_BODY_LEN) {
    return error('BODY_TOO_SHORT', 'Komentar terlalu pendek', ctx.env, 400);
  }
  if (text.length > MAX_BODY_LEN) {
    return error('BODY_TOO_LONG', `Maksimal ${MAX_BODY_LEN} karakter`, ctx.env, 400);
  }

  const turnstileToken =
    typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  const ip = getClientIp(ctx.request);
  const okTurnstile = await verifyTurnstile(
    turnstileToken,
    ctx.env.TURNSTILE_SECRET,
    ip
  );
  if (!okTurnstile) {
    return error('TURNSTILE_FAILED', 'Verifikasi captcha gagal', ctx.env, 403);
  }

  const userKey = await hashKey(`comment:user:${session.sub}`);
  const minuteLimit = await checkRateLimit(ctx.env.DB, `${userKey}:m`, 5, 60);
  if (!minuteLimit.ok) {
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
      { 'Retry-After': String(minuteLimit.retryAfter) }
    );
  }
  const hourLimit = await checkRateLimit(ctx.env.DB, `${userKey}:h`, 20, 3600);
  if (!hourLimit.ok) {
    return json(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Batas per jam tercapai',
          status: 429,
        },
      },
      ctx.env,
      429,
      { 'Retry-After': String(hourLimit.retryAfter) }
    );
  }

  let parentId: string | null = null;
  if (body.parentId && typeof body.parentId === 'string') {
    const parent = await ctx.env.DB.prepare(
      `SELECT id, parent_id FROM comments WHERE id = ? AND slug = ? AND status = 'approved'`
    )
      .bind(body.parentId, slug)
      .first<{ id: string; parent_id: string | null }>();

    if (!parent) {
      return error('PARENT_NOT_FOUND', 'Komentar induk tidak ditemukan', ctx.env, 400);
    }
    if (parent.parent_id !== null) {
      return error('NESTING_TOO_DEEP', 'Balasan hanya boleh 1 level', ctx.env, 400);
    }
    parentId = parent.id;
  }

  const id = newId();
  const now = Math.floor(Date.now() / 1000);

  await ctx.env.DB.prepare(
    `INSERT INTO comments (id, slug, user_id, parent_id, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(id, slug, session.sub, parentId, text, now)
    .run();

  ctx.exec.waitUntil(
    notifyTelegram(ctx.env, {
      id,
      slug,
      body: text,
      userName: session.name,
      userEmail: session.email,
    }).catch((err) => console.error('[telegram] notify failed', err))
  );

  return json(
    {
      ok: true,
      status: 'pending',
      data: {
        id,
        slug,
        parentId,
        body: text,
        status: 'pending',
        createdAt: now,
        isOwn: true,
        user: {
          sub: session.sub,
          name: session.name,
          picture: session.picture ?? null,
        },
      },
    },
    ctx.env,
    201
  );
}

async function deleteComment(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return error('UNAUTHORIZED', 'Login dulu', ctx.env, 401);
  }

  const id = ctx.params.id!;
  if (!id) {
    return error('MISSING_ID', 'ID komentar wajib diisi', ctx.env, 400);
  }

  const row = await ctx.env.DB.prepare(
    `SELECT id, slug, user_id, parent_id FROM comments WHERE id = ?`
  )
    .bind(id)
    .first<{
      id: string;
      slug: string;
      user_id: string;
      parent_id: string | null;
    }>();

  if (!row) {
    return error('NOT_FOUND', 'Komentar tidak ditemukan', ctx.env, 404);
  }

  if (row.user_id !== session.sub) {
    return error('FORBIDDEN', 'Bukan komentar kamu', ctx.env, 403);
  }

  await ctx.env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(id).run();

  if (row.parent_id === null) {
    await ctx.env.DB.prepare(`DELETE FROM comments WHERE parent_id = ?`)
      .bind(id)
      .run();
  }

  return json({ ok: true, id }, ctx.env);
}

export function mountComments(router: Router): void {
  router.get('/api/v1/comments', listComments);
  router.post('/api/v1/comments', createComment);
  router.delete('/api/v1/comments/:id', deleteComment);
}
