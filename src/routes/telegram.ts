import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  buildCommentMessage,
  buildModeratedMessage,
  escapeHtml,
} from '../lib/telegram';

export interface PendingComment {
  id: string;
  slug: string;
  body: string;
  userName: string;
  userEmail: string;
}

function sanitizeSecret(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 256);
}

function siteUrl(slug: string): string {
  return `https://qimochi.web.id/anime/${encodeURIComponent(slug)}/`;
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

export async function notifyTelegram(
  env: Ctx['env'],
  comment: PendingComment
): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const text = buildCommentMessage(comment);
  await sendMessage(token, {
    chatId,
    text,
    inlineKeyboard: [
      [
        { text: '✅ Approve', callback_data: `approve:${comment.id}` },
        { text: '❌ Reject', callback_data: `reject:${comment.id}` },
      ],
      [{ text: '🔗 Buka halaman', url: siteUrl(comment.slug) }],
    ],
  });
}

/* ---------------- COMMAND HELPERS ---------------- */

const HELP_TEXT = [
  '<b>🤖 Qimochi Moderator Bot</b>',
  '',
  'Daftar perintah:',
  '',
  '/pending — 5 komentar pending terbaru',
  '/stats — statistik komentar',
  '/find &lt;kata&gt; — cari komentar',
  '/get &lt;id&gt; — detail komentar',
  '/approve &lt;id&gt; — setujui komentar',
  '/reject &lt;id&gt; [alasan] — tolak komentar',
  '/help — tampilkan menu ini',
].join('\n');

async function sendHelp(token: string, chatId: string): Promise<void> {
  await sendMessage(token, { chatId, text: HELP_TEXT });
}

interface StatsRow {
  status: string;
  c: number;
}

async function sendStats(
  ctx: Ctx,
  token: string,
  chatId: string
): Promise<void> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT status, COUNT(*) as c FROM comments GROUP BY status`
  ).all<StatsRow>();

  const counts: Record<string, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
  };
  for (const r of results ?? []) counts[r.status] = r.c;

  const total = counts.pending + counts.approved + counts.rejected;

  const text = [
    '<b>📊 Statistik Komentar</b>',
    '',
    `Total: <b>${total}</b>`,
    `🕐 Pending: <b>${counts.pending}</b>`,
    `✅ Approved: <b>${counts.approved}</b>`,
    `❌ Rejected: <b>${counts.rejected}</b>`,
  ].join('\n');

  await sendMessage(token, { chatId, text });
}

interface PendingRow {
  id: string;
  slug: string;
  body: string;
  created_at: number;
  name: string;
  email: string;
}

async function sendPendingList(
  ctx: Ctx,
  token: string,
  chatId: string,
  limit = 5
): Promise<void> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT c.id, c.slug, c.body, c.created_at, u.name, u.email
       FROM comments c
       JOIN users u ON u.id = c.user_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at ASC
      LIMIT ?`
  )
    .bind(limit)
    .all<PendingRow>();

  const rows = results ?? [];
  if (rows.length === 0) {
    await sendMessage(token, {
      chatId,
      text: '✅ Tidak ada komentar pending.',
    });
    return;
  }

  const totalRow = await ctx.env.DB.prepare(
    `SELECT COUNT(*) as c FROM comments WHERE status = 'pending'`
  ).first<{ c: number }>();
  const totalPending = totalRow?.c ?? rows.length;

  await sendMessage(token, {
    chatId,
    text: `<b>🕐 ${totalPending} komentar pending</b> (menampilkan ${rows.length} terlama)`,
  });

  for (const row of rows) {
    const preview =
      row.body.length > 400 ? row.body.slice(0, 400) + '…' : row.body;
    const text = [
      `<b>📩 ${escapeHtml(row.name)}</b> — <code>${escapeHtml(row.slug)}</code>`,
      '',
      escapeHtml(preview),
      '',
      `<i>ID: ${row.id}</i>`,
    ].join('\n');

    await sendMessage(token, {
      chatId,
      text,
      inlineKeyboard: [
        [
          { text: '✅ Approve', callback_data: `approve:${row.id}` },
          { text: '❌ Reject', callback_data: `reject:${row.id}` },
        ],
        [{ text: '🔗 Buka halaman', url: siteUrl(row.slug) }],
      ],
    });
  }
}

interface SearchRow {
  id: string;
  slug: string;
  body: string;
  status: string;
  name: string;
}

async function sendFindResults(
  ctx: Ctx,
  token: string,
  chatId: string,
  query: string
): Promise<void> {
  if (!query || query.length < 2) {
    await sendMessage(token, {
      chatId,
      text: '❌ Query minimal 2 karakter. Contoh: /find frieren',
    });
    return;
  }

  const like = `%${query}%`;
  const { results } = await ctx.env.DB.prepare(
    `SELECT c.id, c.slug, c.body, c.status, u.name
       FROM comments c
       JOIN users u ON u.id = c.user_id
      WHERE c.body LIKE ? OR c.slug LIKE ? OR u.name LIKE ?
      ORDER BY c.created_at DESC
      LIMIT 10`
  )
    .bind(like, like, like)
    .all<SearchRow>();

  const rows = results ?? [];
  if (rows.length === 0) {
    await sendMessage(token, {
      chatId,
      text: `Tidak ada hasil untuk "${escapeHtml(query)}".`,
    });
    return;
  }

  const lines = [`<b>🔎 ${rows.length} hasil untuk "${escapeHtml(query)}"</b>`, ''];
  for (const r of rows) {
    const icon =
      r.status === 'approved' ? '✅' : r.status === 'rejected' ? '❌' : '🕐';
    const preview =
      r.body.length > 60 ? r.body.slice(0, 60) + '…' : r.body;
    lines.push(
      `${icon} <code>${r.id}</code> — ${escapeHtml(r.name)}`,
      `    <i>${escapeHtml(r.slug)}</i>`,
      `    ${escapeHtml(preview)}`,
      ''
    );
  }

  await sendMessage(token, { chatId, text: lines.join('\n') });
}

interface CommentDetail {
  id: string;
  slug: string;
  body: string;
  status: string;
  created_at: number;
  approved_at: number | null;
  moderated_by: string | null;
  name: string;
  email: string;
}

async function sendGetById(
  ctx: Ctx,
  token: string,
  chatId: string,
  id: string
): Promise<void> {
  const row = await ctx.env.DB.prepare(
    `SELECT c.id, c.slug, c.body, c.status, c.created_at, c.approved_at,
            c.moderated_by, u.name, u.email
       FROM comments c
       JOIN users u ON u.id = c.user_id
      WHERE c.id = ?`
  )
    .bind(id)
    .first<CommentDetail>();

  if (!row) {
    await sendMessage(token, {
      chatId,
      text: `❌ Komentar <code>${escapeHtml(id)}</code> tidak ditemukan.`,
    });
    return;
  }

  const icon =
    row.status === 'approved' ? '✅' : row.status === 'rejected' ? '❌' : '🕐';

  const text = [
    `<b>${icon} Komentar ${escapeHtml(row.id)}</b>`,
    '',
    `<b>Slug:</b> <code>${escapeHtml(row.slug)}</code>`,
    `<b>Dari:</b> ${escapeHtml(row.name)} &lt;${escapeHtml(row.email)}&gt;`,
    `<b>Status:</b> ${row.status}`,
    row.moderated_by ? `<b>Dimoderasi oleh:</b> ${escapeHtml(row.moderated_by)}` : '',
    '',
    `<b>Isi:</b>`,
    escapeHtml(row.body),
  ]
    .filter(Boolean)
    .join('\n');

  const keyboard: any[][] = [];
  if (row.status === 'pending') {
    keyboard.push([
      { text: '✅ Approve', callback_data: `approve:${row.id}` },
      { text: '❌ Reject', callback_data: `reject:${row.id}` },
    ]);
  }
  keyboard.push([{ text: '🔗 Buka halaman', url: siteUrl(row.slug) }]);

  await sendMessage(token, { chatId, text, inlineKeyboard: keyboard });
}

async function moderateById(
  ctx: Ctx,
  token: string,
  chatId: string,
  id: string,
  action: 'approve' | 'reject',
  moderator: string,
  reason: string | null
): Promise<void> {
  const row = await ctx.env.DB.prepare(
    `SELECT id, slug, status FROM comments WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; slug: string; status: string }>();

  if (!row) {
    await sendMessage(token, {
      chatId,
      text: `❌ Komentar <code>${escapeHtml(id)}</code> tidak ditemukan.`,
    });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const targetStatus = action === 'approve' ? 'approved' : 'rejected';

  if (row.status === targetStatus) {
    await sendMessage(token, {
      chatId,
      text: `ℹ️ Komentar <code>${id}</code> sudah ${targetStatus}.`,
    });
    return;
  }

  if (action === 'approve') {
    await ctx.env.DB.prepare(
      `UPDATE comments
          SET status = 'approved',
              approved_at = ?,
              moderated_by = ?,
              reason = ?
        WHERE id = ?`
    )
      .bind(now, moderator, reason ?? 'telegram', id)
      .run();
    ctx.exec.waitUntil(purgeCacheForSlug(row.slug));
  } else {
    await ctx.env.DB.prepare(
      `UPDATE comments
          SET status = 'rejected',
              moderated_by = ?,
              reason = ?
        WHERE id = ?`
    )
      .bind(moderator, reason ?? 'telegram', id)
      .run();
  }

  const icon = action === 'approve' ? '✅' : '❌';
  const label = action === 'approve' ? 'Disetujui' : 'Ditolak';
  await sendMessage(token, {
    chatId,
    text: `${icon} <b>${label}</b> — <code>${id}</code>\nSlug: <code>${escapeHtml(row.slug)}</code>`,
  });
}

/* ---------------- WEBHOOK ---------------- */

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

function moderatorName(from?: {
  username?: string;
  first_name?: string;
}): string {
  if (!from) return 'admin';
  if (from.username) return `@${from.username}`;
  return from.first_name ?? 'admin';
}

async function handleMessage(
  ctx: Ctx,
  msg: TelegramMessage
): Promise<void> {
  const token = ctx.env.TELEGRAM_BOT_TOKEN;
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? '').trim();
  if (!text.startsWith('/')) return;

  const moderator = moderatorName(msg.from);

  const parts = text.split(/\s+/);
  const cmdRaw = parts[0] ?? '';
  const cmd = cmdRaw.replace(/@\w+$/, '').toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case '/start':
    case '/help':
      await sendHelp(token, chatId);
      return;
    case '/stats':
      await sendStats(ctx, token, chatId);
      return;
    case '/pending':
      await sendPendingList(ctx, token, chatId);
      return;
    case '/find':
      await sendFindResults(ctx, token, chatId, args.join(' '));
      return;
    case '/get':
      if (!args[0]) {
        await sendMessage(token, {
          chatId,
          text: '❌ Format: /get &lt;id&gt;',
        });
        return;
      }
      await sendGetById(ctx, token, chatId, args[0]);
      return;
    case '/approve':
      if (!args[0]) {
        await sendMessage(token, {
          chatId,
          text: '❌ Format: /approve &lt;id&gt;',
        });
        return;
      }
      await moderateById(ctx, token, chatId, args[0], 'approve', moderator, args.slice(1).join(' ') || null);
      return;
    case '/reject':
      if (!args[0]) {
        await sendMessage(token, {
          chatId,
          text: '❌ Format: /reject &lt;id&gt; [alasan]',
        });
        return;
      }
      await moderateById(ctx, token, chatId, args[0], 'reject', moderator, args.slice(1).join(' ') || null);
      return;
    default:
      await sendMessage(token, {
        chatId,
        text: `❓ Perintah tidak dikenal: <code>${escapeHtml(cmd)}</code>\n\nKetik /help untuk daftar perintah.`,
      });
  }
}

async function handleCallback(
  ctx: Ctx,
  cq: TelegramCallbackQuery
): Promise<void> {
  const token = ctx.env.TELEGRAM_BOT_TOKEN;

  if (!cq.data || !cq.message) {
    await answerCallbackQuery(token, cq.id);
    return;
  }

  const allowedChatId = ctx.env.TELEGRAM_CHAT_ID;
  if (String(cq.message.chat.id) !== String(allowedChatId)) {
    await answerCallbackQuery(token, cq.id, 'Anda tidak berwenang');
    return;
  }

  const [action, target] = cq.data.split(':');
  const moderator = moderatorName(cq.from);

  if (action !== 'approve' && action !== 'reject') {
    await answerCallbackQuery(token, cq.id, 'Aksi tidak dikenal');
    return;
  }

  if (!target) {
    await answerCallbackQuery(token, cq.id, 'ID kosong');
    return;
  }

  const row = await ctx.env.DB.prepare(
    `SELECT id, slug, status FROM comments WHERE id = ?`
  )
    .bind(target)
    .first<{ id: string; slug: string; status: string }>();

  if (!row) {
    await answerCallbackQuery(token, cq.id, 'Komentar tidak ditemukan');
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  if (action === 'approve') {
    if (row.status !== 'approved') {
      await ctx.env.DB.prepare(
        `UPDATE comments
            SET status = 'approved',
                approved_at = ?,
                moderated_by = ?,
                reason = ?
          WHERE id = ?`
      )
        .bind(now, moderator, 'telegram', target)
        .run();
      ctx.exec.waitUntil(purgeCacheForSlug(row.slug));
    }
    await answerCallbackQuery(token, cq.id, 'Disetujui ✅');
  } else {
    if (row.status !== 'rejected') {
      await ctx.env.DB.prepare(
        `UPDATE comments
            SET status = 'rejected',
                moderated_by = ?,
                reason = ?
          WHERE id = ?`
      )
        .bind(moderator, 'telegram', target)
        .run();
    }
    await answerCallbackQuery(token, cq.id, 'Ditolak ❌');
  }

  const originalText = cq.message.text ?? '';
  const newText = buildModeratedMessage(
    originalText,
    action === 'approve' ? 'approved' : 'rejected',
    moderator
  );

  await editMessageText(
    token,
    String(cq.message.chat.id),
    cq.message.message_id,
    newText
  );
}

async function handleWebhook(ctx: Ctx): Promise<Response> {
  const secretHeader = ctx.request.headers.get(
    'X-Telegram-Bot-Api-Secret-Token'
  );
  const expected = sanitizeSecret(ctx.env.TELEGRAM_WEBHOOK_SECRET ?? '');
  if (!expected || secretHeader !== expected) {
    return error('UNAUTHORIZED', 'Secret tidak valid', ctx.env, 401);
  }

  let update: TelegramUpdate;
  try {
    update = (await ctx.request.json()) as TelegramUpdate;
  } catch {
    return json({ ok: true }, ctx.env);
  }

  const allowedChatId = String(ctx.env.TELEGRAM_CHAT_ID);

  if (update.message && String(update.message.chat.id) === allowedChatId) {
    ctx.exec.waitUntil(
      handleMessage(ctx, update.message).catch((err) =>
        console.error('[telegram] handleMessage failed', err)
      )
    );
    return json({ ok: true }, ctx.env);
  }

  if (update.callback_query) {
    ctx.exec.waitUntil(
      handleCallback(ctx, update.callback_query).catch((err) =>
        console.error('[telegram] handleCallback failed', err)
      )
    );
    return json({ ok: true }, ctx.env);
  }

  return json({ ok: true }, ctx.env);
}

async function setupWebhook(ctx: Ctx): Promise<Response> {
  const token = ctx.env.TELEGRAM_BOT_TOKEN;
  const rawSecret = ctx.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  const secret = sanitizeSecret(rawSecret);

  if (!token || !secret) {
    return error(
      'SERVER_MISCONFIGURED',
      'TELEGRAM_BOT_TOKEN atau TELEGRAM_WEBHOOK_SECRET belum diset',
      ctx.env,
      500
    );
  }

  const webhookUrl =
    ctx.url.searchParams.get('url') ??
    'https://api.qimochi.web.id/api/v1/telegram/webhook';

  const body = {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
  };

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: unknown;
  };

  return json(
    {
      ok: data.ok,
      description: data.description ?? null,
      webhookUrl,
      allowedUpdates: body.allowed_updates,
      result: data.result ?? null,
    },
    ctx.env
  );
}

export function mountTelegram(router: Router): void {
  router.post('/api/v1/telegram/webhook', handleWebhook);
  router.get('/api/v1/telegram/setup', setupWebhook);
}