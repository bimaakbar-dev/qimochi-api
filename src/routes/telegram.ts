import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  buildCommentMessage,
  buildModeratedMessage,
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
      [
        { text: '🔗 Buka halaman', callback_data: `open:${comment.slug}` },
      ],
    ],
  });
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
    data?: string;
  };
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

  const cq = update.callback_query;
  if (!cq || !cq.data || !cq.message) {
    return json({ ok: true }, ctx.env);
  }

  const allowedChatId = ctx.env.TELEGRAM_CHAT_ID;
  if (String(cq.message.chat.id) !== String(allowedChatId)) {
    await answerCallbackQuery(
      ctx.env.TELEGRAM_BOT_TOKEN,
      cq.id,
      'Anda tidak berwenang'
    );
    return json({ ok: true }, ctx.env);
  }

  const [action, target] = cq.data.split(':');
  const moderator =
    cq.from.username ? `@${cq.from.username}` : cq.from.first_name ?? 'admin';

  if (action === 'open' && target) {
    await answerCallbackQuery(
      ctx.env.TELEGRAM_BOT_TOKEN,
      cq.id,
      'Halaman dibuka di browser Telegram'
    );
    return json({ ok: true }, ctx.env);
  }

  if (action !== 'approve' && action !== 'reject') {
    await answerCallbackQuery(ctx.env.TELEGRAM_BOT_TOKEN, cq.id, 'Aksi tidak dikenal');
    return json({ ok: true }, ctx.env);
  }

  if (!target) {
    await answerCallbackQuery(ctx.env.TELEGRAM_BOT_TOKEN, cq.id, 'ID kosong');
    return json({ ok: true }, ctx.env);
  }

  const row = await ctx.env.DB.prepare(
    `SELECT id, slug, status FROM comments WHERE id = ?`
  )
    .bind(target)
    .first<{ id: string; slug: string; status: string }>();

  if (!row) {
    await answerCallbackQuery(ctx.env.TELEGRAM_BOT_TOKEN, cq.id, 'Komentar tidak ditemukan');
    return json({ ok: true }, ctx.env);
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
    await answerCallbackQuery(ctx.env.TELEGRAM_BOT_TOKEN, cq.id, 'Disetujui ✅');
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
    await answerCallbackQuery(ctx.env.TELEGRAM_BOT_TOKEN, cq.id, 'Ditolak ❌');
  }

  const originalText = cq.message.text ?? '';
  const newText = buildModeratedMessage(
    originalText,
    action === 'approve' ? 'approved' : 'rejected',
    moderator
  );

  await editMessageText(
    ctx.env.TELEGRAM_BOT_TOKEN,
    String(cq.message.chat.id),
    cq.message.message_id,
    newText
  );

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
    allowed_updates: ['callback_query'],
    drop_pending_updates: false,
  };

  const res = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

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
      sanitizedSecretLength: secret.length,
      originalSecretLength: rawSecret.length,
      result: data.result ?? null,
    },
    ctx.env
  );
}

export function mountTelegram(router: Router): void {
  router.post('/api/v1/telegram/webhook', handleWebhook);
  router.get('/api/v1/telegram/setup', setupWebhook);
}