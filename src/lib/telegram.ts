export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SendMessageOptions {
  chatId: string;
  text: string;
  inlineKeyboard?: InlineButton[][];
  parseMode?: 'HTML' | 'MarkdownV2';
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function callApi(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; result?: any; description?: string }> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    return await res.json();
  } catch {
    return { ok: false, description: `HTTP ${res.status}` };
  }
}

export async function sendMessage(
  token: string,
  opts: SendMessageOptions
): Promise<{ ok: boolean; messageId?: number; description?: string }> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text,
    parse_mode: opts.parseMode ?? 'HTML',
    disable_web_page_preview: true,
  };
  if (opts.inlineKeyboard) {
    body.reply_markup = { inline_keyboard: opts.inlineKeyboard };
  }
  const result = await callApi(token, 'sendMessage', body);
  if (!result.ok) {
    return { ok: false, description: result.description ?? 'unknown' };
  }
  return { ok: true, messageId: result.result?.message_id };
}

export async function deleteMessage(
  token: string,
  chatId: string,
  messageId: number
): Promise<{ ok: boolean }> {
  const result = await callApi(token, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
  return { ok: result.ok };
}

export async function editMessageText(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  parseMode: 'HTML' | 'MarkdownV2' = 'HTML'
): Promise<{ ok: boolean }> {
  const result = await callApi(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] },
  });
  return { ok: result.ok };
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string
): Promise<{ ok: boolean }> {
  const result = await callApi(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text ?? '',
    show_alert: false,
  });
  return { ok: result.ok };
}

export function buildCommentMessage(input: {
  id: string;
  slug: string;
  body: string;
  userName: string;
  userEmail: string;
}): string {
  const bodyPreview =
    input.body.length > 500 ? input.body.slice(0, 500) + '…' : input.body;
  return [
    `<b>📩 Komentar baru</b>`,
    ``,
    `<b>Slug:</b> <code>${escapeHtml(input.slug)}</code>`,
    `<b>Dari:</b> ${escapeHtml(input.userName)} &lt;${escapeHtml(input.userEmail)}&gt;`,
    ``,
    `<b>Isi:</b>`,
    escapeHtml(bodyPreview),
    ``,
    `<i>ID: ${input.id}</i>`,
  ].join('\n');
}

export function buildModeratedMessage(
  originalText: string,
  action: 'approved' | 'rejected',
  moderator: string
): string {
  const icon = action === 'approved' ? '✅' : '❌';
  const label = action === 'approved' ? 'Disetujui' : 'Ditolak';
  return `${originalText}\n\n${icon} <b>${label}</b> oleh ${escapeHtml(moderator)}`;
}
