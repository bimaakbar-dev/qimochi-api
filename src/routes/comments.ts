import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import { getSession } from '../lib/session';
import { verifyTurnstile } from '../lib/turnstile';
import { checkRateLimit, getClientIp, hashKey } from '../lib/ratelimit';
import { notifyTelegram, notifyAutoRejected } from './telegram';
import { moderate } from '../lib/moderation';
import { sendMessage, escapeHtml } from '../lib/telegram';

const MAX_BODY_LEN = 2000;
const MIN_BODY_LEN = 2;
const EDIT_WINDOW_SEC = 900;

interface CommentRow {
  id: string;
  slug: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  status: string;
  created_at: number;
  edited_at: number | null;
  name: string;
  email: string;
  picture: string | null;
  likes: number;
  is_liked: number;
}

interface PublicComment {
  id: string;
  slug: string;
  parentId: string | null;
  body: string;
  status: string;
  createdAt: number;
  editedAt: number | null;
  likes: number;
  isLiked: boolean;
  isOwn: boolean;
  isAdmin: boolean;
  canEdit: boolean;
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

function adminSet(env: Ctx['env']): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function toPublic(
  row: CommentRow,
  viewerSub: string | null,
  admins: Set<string>
): PublicComment {
  const now = Math.floor(Date.now() / 1000);
  const isOwn = viewerSub !== null && viewerSub === row.user_id;
  const withinEdit =
    row.status !== 'rejected' && now - row.created_at < EDIT_WINDOW_SEC;

  return {
    id: row.id,
    slug: row.slug,
    parentId: row.parent_id,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    likes: row.likes,
    isLiked: row.is_liked === 1,
    isOwn,
    isAdmin: admins.has((row.email ?? '').toLowerCase()),
    canEdit: isOwn && withinEdit,
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
  const admins = adminSet(ctx.env);

  const baseSelect = `
    SELECT c.id, c.slug, c.user_id, c.parent_id, c.body, c.status,
           c.created_at, c.edited_at, u.name, u.email, u.picture,
           COALESCE(l.cnt, 0) as likes,
           CASE WHEN ul.user_id IS NULL THEN 0 ELSE 1 END as is_liked
      FROM comments c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN (
        SELECT comment_id, COUNT(*) as cnt
          FROM comment_likes
         GROUP BY comment_id
      ) l ON l.comment_id = c.id
      LEFT JOIN comment_likes ul
        ON ul.comment_id = c.id AND ul.user_id = ?
  `;

  let rows: CommentRow[] = [];

  if (viewerSub) {
    const res = await ctx.env.DB.prepare(
      `${baseSelect}
        WHERE c.slug = ? AND (
          c.status = 'approved'
          OR (c.user_id = ? AND c.status IN ('pending', 'rejected'))
        )
        ORDER BY c.created_at ASC
        LIMIT 500`
    )
      .bind(viewerSub, slug, viewerSub)
      .all<CommentRow>();
    rows = res.results ?? [];
  } else {
    const res = await ctx.env.DB.prepare(
      `${baseSelect}
        WHERE c.slug = ? AND c.status = 'approved'
        ORDER BY c.created_at ASC
        LIMIT 500`
    )
      .bind('', slug)
      .all<CommentRow>();
    rows = res.results ?? [];
  }

  const data = rows.map((r) => toPublic(r, viewerSub, admins));

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
  if (!slug) return error('MISSING_SLUG', 'Slug wajib diisi', ctx.env, 400);

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

  const moderation = moderate(text, ctx.env);
  const status = moderation.decision;
  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';

  const id = newId();
  const now = Math.floor(Date.now() / 1000);
  const admins = adminSet(ctx.env);

  const moderatedBy = isApproved
    ? 'bot:auto'
    : isRejected
    ? 'bot:badword'
    : null;

  await ctx.env.DB.prepare(
    `INSERT INTO comments
       (id, slug, user_id, parent_id, body, status, created_at,
        approved_at, moderated_by, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      slug,
      session.sub,
      parentId,
      text,
      status,
      now,
      isApproved ? now : null,
      moderatedBy,
      moderation.reason || null
    )
    .run();

  if (status === 'pending') {
    ctx.exec.waitUntil(
      notifyTelegram(ctx.env, {
        id,
        slug,
        body: text,
        userName: session.name,
        userEmail: session.email,
      }).catch((err) => console.error('[telegram] notify failed', err))
    );
  } else if (isRejected) {
    ctx.exec.waitUntil(
      notifyAutoRejected(ctx.env, {
        id,
        slug,
        body: text,
        userName: session.name,
        reason: moderation.reason,
        matched: moderation.matched,
      }).catch((err) =>
        console.error('[telegram] auto-rejected notify failed', err)
      )
    );
  }

  return json(
    {
      ok: true,
      status,
      reason: moderation.reason || null,
      data: {
        id,
        slug,
        parentId,
        body: text,
        status,
        createdAt: now,
        editedAt: null,
        likes: 0,
        isLiked: false,
        isOwn: true,
        isAdmin: admins.has(session.email.toLowerCase()),
        canEdit: status !== 'rejected',
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
  if (!session) return error('UNAUTHORIZED', 'Login dulu', ctx.env, 401);

  const id = ctx.params.id!;
  if (!id) return error('MISSING_ID', 'ID komentar wajib diisi', ctx.env, 400);

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

  if (!row) return error('NOT_FOUND', 'Komentar tidak ditemukan', ctx.env, 404);

  const admins = adminSet(ctx.env);
  const isAdmin = admins.has(session.email.toLowerCase());
  if (row.user_id !== session.sub && !isAdmin) {
    return error('FORBIDDEN', 'Bukan komentar kamu', ctx.env, 403);
  }

  await ctx.env.DB.prepare(`DELETE FROM comments WHERE id = ?`).bind(id).run();
  await ctx.env.DB.prepare(`DELETE FROM comment_likes WHERE comment_id = ?`)
    .bind(id)
    .run();

  if (row.parent_id === null) {
    const childIds = await ctx.env.DB.prepare(
      `SELECT id FROM comments WHERE parent_id = ?`
    )
      .bind(id)
      .all<{ id: string }>();

    for (const c of childIds.results ?? []) {
      await ctx.env.DB.prepare(`DELETE FROM comment_likes WHERE comment_id = ?`)
        .bind(c.id)
        .run();
    }

    await ctx.env.DB.prepare(`DELETE FROM comments WHERE parent_id = ?`)
      .bind(id)
      .run();
  }

  return json({ ok: true, id }, ctx.env);
}

async function editComment(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) return error('UNAUTHORIZED', 'Login dulu', ctx.env, 401);

  const id = ctx.params.id!;
  if (!id) return error('MISSING_ID', 'ID komentar wajib diisi', ctx.env, 400);

  let body: { body?: string };
  try {
    body = (await ctx.request.json()) as { body?: string };
  } catch {
    return error('INVALID_JSON', 'Body bukan JSON valid', ctx.env, 400);
  }

  const text = sanitizeBody(typeof body.body === 'string' ? body.body : '');
  if (text.length < MIN_BODY_LEN) {
    return error('BODY_TOO_SHORT', 'Komentar terlalu pendek', ctx.env, 400);
  }
  if (text.length > MAX_BODY_LEN) {
    return error('BODY_TOO_LONG', `Maksimal ${MAX_BODY_LEN} karakter`, ctx.env, 400);
  }

  const row = await ctx.env.DB.prepare(
    `SELECT id, user_id, created_at, status FROM comments WHERE id = ?`
  )
    .bind(id)
    .first<{
      id: string;
      user_id: string;
      created_at: number;
      status: string;
    }>();

  if (!row) return error('NOT_FOUND', 'Komentar tidak ditemukan', ctx.env, 404);

  const admins = adminSet(ctx.env);
  const isAdmin = admins.has(session.email.toLowerCase());
  if (row.user_id !== session.sub && !isAdmin) {
    return error('FORBIDDEN', 'Bukan komentar kamu', ctx.env, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - row.created_at > EDIT_WINDOW_SEC && !isAdmin) {
    return error('EDIT_EXPIRED', 'Batas waktu edit sudah lewat', ctx.env, 400);
  }

  const moderation = moderate(text, ctx.env);
  const status = moderation.decision;
  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';

  const moderatedBy = isApproved
    ? 'bot:auto'
    : isRejected
    ? 'bot:badword'
    : null;

  await ctx.env.DB.prepare(
    `UPDATE comments
        SET body = ?,
            edited_at = ?,
            status = ?,
            approved_at = ?,
            moderated_by = ?,
            reason = ?
      WHERE id = ?`
  )
    .bind(
      text,
      now,
      status,
      isApproved ? now : null,
      moderatedBy,
      moderation.reason || null,
      id
    )
    .run();

  return json(
    { ok: true, id, editedAt: now, status, reason: moderation.reason || null },
    ctx.env
  );
}

async function toggleLike(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) return error('UNAUTHORIZED', 'Login dulu', ctx.env, 401);

  const id = ctx.params.id!;
  if (!id) return error('MISSING_ID', 'ID komentar wajib diisi', ctx.env, 400);

  const row = await ctx.env.DB.prepare(
    `SELECT id, status FROM comments WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; status: string }>();

  if (!row || row.status !== 'approved') {
    return error('NOT_FOUND', 'Komentar tidak ditemukan', ctx.env, 404);
  }

  const key = await hashKey(`like:${session.sub}`);
  const limit = await checkRateLimit(ctx.env.DB, `${key}:m`, 30, 60);
  if (!limit.ok) return error('RATE_LIMITED', 'Terlalu cepat', ctx.env, 429);

  const existing = await ctx.env.DB.prepare(
    `SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?`
  )
    .bind(id, session.sub)
    .first<{ 1: number }>();

  let liked: boolean;
  const now = Math.floor(Date.now() / 1000);

  if (existing) {
    await ctx.env.DB.prepare(
      `DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?`
    )
      .bind(id, session.sub)
      .run();
    liked = false;
  } else {
    await ctx.env.DB.prepare(
      `INSERT INTO comment_likes (comment_id, user_id, created_at)
       VALUES (?, ?, ?)`
    )
      .bind(id, session.sub, now)
      .run();
    liked = true;
  }

  const total = await ctx.env.DB.prepare(
    `SELECT COUNT(*) as c FROM comment_likes WHERE comment_id = ?`
  )
    .bind(id)
    .first<{ c: number }>();

  return json({ ok: true, id, liked, likes: total?.c ?? 0 }, ctx.env);
}

async function reportComment(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) return error('UNAUTHORIZED', 'Login dulu', ctx.env, 401);

  const id = ctx.params.id!;
  if (!id) return error('MISSING_ID', 'ID komentar wajib diisi', ctx.env, 400);

  let body: { reason?: string };
  try {
    body = (await ctx.request.json()) as { reason?: string };
  } catch {
    body = {};
  }

  const reason = (body.reason ?? '').trim().slice(0, 500);

  const row = await ctx.env.DB.prepare(
    `SELECT c.id, c.slug, c.body, c.user_id, u.name
       FROM comments c
       JOIN users u ON u.id = c.user_id
      WHERE c.id = ?`
  )
    .bind(id)
    .first<{
      id: string;
      slug: string;
      body: string;
      user_id: string;
      name: string;
    }>();

  if (!row) return error('NOT_FOUND', 'Komentar tidak ditemukan', ctx.env, 404);

  const key = await hashKey(`report:${session.sub}`);
  const limit = await checkRateLimit(ctx.env.DB, `${key}:h`, 10, 3600);
  if (!limit.ok) return error('RATE_LIMITED', 'Batas report tercapai', ctx.env, 429);

  const now = Math.floor(Date.now() / 1000);
  const reportId = newId();

  await ctx.env.DB.prepare(
    `INSERT INTO comment_reports (id, comment_id, user_id, reason, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'open')`
  )
    .bind(reportId, id, session.sub, reason || null, now)
    .run();

  const token = ctx.env.TELEGRAM_BOT_TOKEN;
  const chatId = ctx.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    const preview =
      row.body.length > 300 ? row.body.slice(0, 300) + '…' : row.body;
    const text = [
      `<b>🚨 Komentar dilaporkan</b>`,
      ``,
      `<b>Slug:</b> <code>${escapeHtml(row.slug)}</code>`,
      `<b>Penulis:</b> ${escapeHtml(row.name)}`,
      `<b>Pelapor:</b> ${escapeHtml(session.name)}`,
      `<b>Alasan:</b> ${escapeHtml(reason || '(tidak disebutkan)')}`,
      ``,
      `<b>Isi:</b>`,
      escapeHtml(preview),
      ``,
      `<i>ID: ${id}</i>`,
    ].join('\n');

    ctx.exec.waitUntil(
      sendMessage(token, {
        chatId,
        text,
        inlineKeyboard: [
          [{ text: '❌ Reject', callback_data: `reject:${id}` }],
          [
            {
              text: '🔗 Buka halaman',
              url: `https://qimochi.web.id/anime/${encodeURIComponent(row.slug)}/`,
            },
          ],
        ],
      }).catch((err) => console.error('[telegram] report notify failed', err))
    );
  }

  return json({ ok: true, id: reportId }, ctx.env);
}

export function mountComments(router: Router): void {
  router.get('/api/v1/comments', listComments);
  router.post('/api/v1/comments', createComment);
  router.patch('/api/v1/comments/:id', editComment);
  router.delete('/api/v1/comments/:id', deleteComment);
  router.post('/api/v1/comments/:id/like', toggleLike);
  router.post('/api/v1/comments/:id/report', reportComment);
}
