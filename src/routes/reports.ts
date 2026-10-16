import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import { getSession } from '../lib/session';
import { checkRateLimit, hashKey } from '../lib/ratelimit';
import { sendMessage, escapeHtml } from '../lib/telegram';

const ALLOWED_REASONS = [
  'embed_dead',
  'embed_slow',
  'wrong_episode',
  'subtitle_wrong',
  'audio_issue',
  'other',
] as const;

type Reason = (typeof ALLOWED_REASONS)[number];

const REASON_LABEL: Record<Reason, string> = {
  embed_dead: 'Embed mati',
  embed_slow: 'Embed lambat / lag',
  wrong_episode: 'Episode salah',
  subtitle_wrong: 'Subtitle salah / tidak ada',
  audio_issue: 'Audio bermasalah',
  other: 'Lainnya',
};

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NOTE_LEN = 500;
const RATE_LIMIT_PER_HOUR = 10;

async function createReport(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return error('UNAUTHORIZED', 'Login dulu untuk melapor', ctx.env, 401);
  }

  let body: {
    slug?: string;
    episode?: number;
    server?: string;
    quality?: string;
    reason?: string;
    note?: string;
  };

  try {
    body = (await ctx.request.json()) as typeof body;
  } catch {
    return error('INVALID_JSON', 'Body bukan JSON valid', ctx.env, 400);
  }

  const slug = (body.slug ?? '').trim().toLowerCase();
  if (!slug || !SLUG_RE.test(slug)) {
    return error('INVALID_SLUG', 'Slug tidak valid', ctx.env, 400);
  }

  const episode = Number(body.episode);
  if (!Number.isInteger(episode) || episode < 1 || episode > 9999) {
    return error('INVALID_EPISODE', 'Episode tidak valid', ctx.env, 400);
  }

  const reason = String(body.reason ?? '').trim();
  if (!ALLOWED_REASONS.includes(reason as Reason)) {
    return error('INVALID_REASON', 'Alasan tidak valid', ctx.env, 400);
  }

  const server = String(body.server ?? '').trim().slice(0, 100);
  const quality = String(body.quality ?? '').trim().slice(0, 50);
  const note = String(body.note ?? '').trim().slice(0, MAX_NOTE_LEN);

  // Rate limit — per user
  const key = await hashKey(`report:user:${session.sub}`);
  const limit = await checkRateLimit(
    ctx.env.DB,
    `${key}:h`,
    RATE_LIMIT_PER_HOUR,
    3600
  );
  if (!limit.ok) {
    return error(
      'RATE_LIMITED',
      'Terlalu banyak laporan. Coba lagi dalam beberapa saat.',
      ctx.env,
      429
    );
  }

  // Kirim notifikasi ke Telegram
  const token = ctx.env.TELEGRAM_BOT_TOKEN;
  const chatId = ctx.env.TELEGRAM_CHAT_ID;

  if (token && chatId) {
    const userName = session.name;
    const userEmail = session.email;

    const lines: string[] = [
      `<b>🚨 Laporan embed bermasalah</b>`,
      ``,
      `<b>Anime:</b> <code>${escapeHtml(slug)}</code>`,
      `<b>Episode:</b> ${episode}`,
    ];
    if (quality) lines.push(`<b>Kualitas:</b> ${escapeHtml(quality)}`);
    if (server) lines.push(`<b>Server:</b> ${escapeHtml(server)}`);
    lines.push(`<b>Alasan:</b> ${escapeHtml(REASON_LABEL[reason as Reason])}`);
    if (note) lines.push(`<b>Catatan:</b> ${escapeHtml(note)}`);
    lines.push(``);
    lines.push(
      `<b>Pelapor:</b> ${escapeHtml(userName)} &lt;${escapeHtml(userEmail)}&gt;`
    );

    const watchUrl = `https://qimochi.web.id/anime/watch/${encodeURIComponent(slug)}/episodes/${episode}/`;

    ctx.exec.waitUntil(
      sendMessage(token, {
        chatId,
        text: lines.join('\n'),
        inlineKeyboard: [
          [{ text: '🔗 Buka watch page', url: watchUrl }],
        ],
      }).catch((err) =>
        console.error('[telegram] report notify failed', err)
      )
    );
  }

  return json(
    { ok: true, message: 'Laporan terkirim. Terima kasih!' },
    ctx.env
  );
}

export function mountReports(router: Router): void {
  router.post('/api/v1/reports', createReport);
}