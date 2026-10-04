import { Bot, webhookCallback } from "grammy";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GH_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  ADMIN_CHAT_ID: string;
  DISCORD_WEBHOOK_GISCUS: string;
}

const ADMIN_USER_ID = 1605070949;

const ANILIST_URL = "https://graphql.anilist.co";

const ANILIST_QUERY = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      title { romaji english native }
      coverImage { extraLarge large }
      format
      status
      seasonYear
      episodes
      genres
      averageScore
      studios(isMain: true) { nodes { name } }
      startDate { year month day }
    }
  }
`;

const FORMAT_MAP: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "TV",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Special",
};

const STATUS_MAP: Record<string, string> = {
  FINISHED: "Completed",
  RELEASING: "Ongoing",
  NOT_YET_RELEASED: "Ongoing",
  CANCELLED: "Hiatus",
  HIATUS: "Hiatus",
};

interface AniListMedia {
  id: number;
  title: { romaji: string; english: string | null; native: string | null };
  coverImage: { extraLarge: string; large: string };
  format: string;
  status: string;
  seasonYear: number | null;
  episodes: number | null;
  genres: string[];
  averageScore: number | null;
  studios: { nodes: { name: string }[] };
  startDate: { year: number | null; month: number | null; day: number | null };
}

async function searchAniList(title: string): Promise<AniListMedia | null> {
  const res = await fetch(ANILIST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      query: ANILIST_QUERY,
      variables: { search: title },
    }),
  });

  if (!res.ok) throw new Error(`AniList: HTTP ${res.status}`);

  const json = (await res.json()) as {
    data?: { Media: AniListMedia | null };
    errors?: any[];
  };

  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "AniList error");

  return json.data?.Media ?? null;
}

function pickTitle(media: AniListMedia): string {
  return media.title.romaji || media.title.english || media.title.native || "Unknown";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildYaml(media: AniListMedia): string {
  const title = pickTitle(media);
  const cover = media.coverImage.extraLarge || media.coverImage.large;
  const type = FORMAT_MAP[media.format] ?? "TV";
  const status = STATUS_MAP[media.status] ?? "Ongoing";
  const studio = media.studios?.nodes?.[0]?.name ?? "Unknown";
  const genres = (media.genres ?? []).slice(0, 3).join(", ");
  const rating = media.averageScore ? (media.averageScore / 10).toFixed(1) : "0";

  const y = media.startDate?.year ?? media.seasonYear ?? 2020;
  const m = String(media.startDate?.month ?? 1).padStart(2, "0");
  const d = String(media.startDate?.day ?? 1).padStart(2, "0");
  const releaseDate = `${y}-${m}-${d}`;
  const addedAt = new Date().toISOString().split("T")[0];

  const safeTitle = /[:#&*!|>'"%@`]/.test(title) ? `"${title.replace(/"/g, '\\"')}"` : title;

  return `---
title: ${safeTitle}
cover: ${cover}
type: ${type}
status: ${status}
genre: [${genres}]
studio: ${studio}
releaseDate: ${releaseDate}
addedAt: ${addedAt}
rating: ${rating}
episodes: []
---`;
}

function buildInfoMessage(media: AniListMedia): string {
  const title = pickTitle(media);
  const year = media.startDate?.year ?? media.seasonYear ?? "-";
  const studio = media.studios?.nodes?.[0]?.name ?? "Unknown";
  const genres = (media.genres ?? []).slice(0, 3).join(", ") || "-";
  const rating = media.averageScore ? (media.averageScore / 10).toFixed(1) : "-";
  const status = STATUS_MAP[media.status] ?? media.status;
  const type = FORMAT_MAP[media.format] ?? media.format;

  return (
    `<b>${escapeHtml(title)}</b>\n\n` +
    `📅 Tahun: ${year}\n` +
    `🎬 Tipe: ${type}\n` +
    `📌 Status: ${status}\n` +
    `📼 Episode: ${media.episodes ?? "-"}\n` +
    `🏢 Studio: ${escapeHtml(studio)}\n` +
    `🏷️ Genre: ${escapeHtml(genres)}\n` +
    `⭐ Rating: ${rating}`
  );
}

async function handleAnimeCommand(ctx: any, query: string): Promise<void> {
  const q = query.trim();
  if (!q) {
    await ctx.reply(
      "Kasih judul anime-nya.\n\n" +
        "Contoh:\n" +
        "<code>/anime jujutsu kaisen</code>\n\n" +
        "Atau reply ke pesan yang berisi judul, lalu kirim <code>/anime</code>.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const loading = await ctx.reply("🔍 Mencari...");

  try {
    const media = await searchAniList(q);

    if (!media) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        loading.message_id,
        `❌ Anime "${escapeHtml(q)}" tidak ditemukan di AniList.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      loading.message_id,
      buildInfoMessage(media),
      { parse_mode: "HTML" }
    );

    const yaml = buildYaml(media);
    await ctx.reply(
      `<b>YAML Frontmatter</b>\n\n<pre><code class="language-yaml">${escapeHtml(yaml)}</code></pre>`,
      { parse_mode: "HTML" }
    );

    const cover = media.coverImage.extraLarge || media.coverImage.large;
    await ctx.replyWithPhoto(cover);
  } catch (err: any) {
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        loading.message_id,
        `❌ Error: ${escapeHtml(err?.message ?? "unknown")}`
      )
      .catch(() => {});
  }
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64url(input: string | ArrayBuffer): string {
  let str: string;
  if (typeof input === "string") {
    str = btoa(input);
  } else {
    const bytes = new Uint8Array(input);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    str = btoa(binary);
  }
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generateJWT(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: appId };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const unsigned = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${base64url(signature)}`;
}

async function getInstallationToken(
  appId: string,
  privateKey: string,
  installationId: number
): Promise<string> {
  const jwt = await generateJWT(appId, privateKey);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "c0desk1-bot",
      },
    }
  );
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function replyToComment(
  token: string,
  discussionId: string,
  replyToId: string,
  body: string
): Promise<void> {
  await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "c0desk1-bot",
    },
    body: JSON.stringify({
      query: `mutation($discussionId: ID!, $body: String!, $replyToId: ID!) {
        addDiscussionComment(input: {discussionId: $discussionId, body: $body, replyToId: $replyToId}) {
          comment { id }
        }
      }`,
      variables: { discussionId, body, replyToId },
    }),
  });
}

async function verifySignature(
  secret: string,
  body: string,
  signature: string | null
): Promise<boolean> {
  if (!signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hashArray = Array.from(new Uint8Array(sig));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return signature === `sha256=${hashHex}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/github") {
      return handleGithub(request, env);
    }

    const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

    bot.command("start", (ctx) =>
      ctx.reply(
        "Selamat datang di c0desk1[bot]!\n\n" +
          "/start - Mulai bot\n" +
          "/help - Bantuan\n" +
          "/blog - Artikel blog terbaru\n\n" +
          "Channel: t.me/c0desk1\n" +
          "Discord: discord.gg/zzaUTzWbm"
      )
    );

    bot.command("help", (ctx) =>
      ctx.reply(
        "Bantuan\n\n" +
          "/start - Mulai bot\n" +
          "/help - Bantuan\n" +
          "/blog - Artikel blog terbaru"
      )
    );

    bot.command("blog", async (ctx) => {
      try {
        const res = await fetch("https://bimaakbar-dev.github.io/rss.xml");
        const xml = await res.text();
        const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        const top5 = items.slice(0, 5);
        let message = "<b>Artikel Blog Terbaru</b>\n\n";
        for (const item of top5) {
          const title = item.match(/<title>(.*?)<\/title>/)?.[1] ?? "Tanpa judul";
          const link = item.match(/<link>(.*?)<\/link>/)?.[1] ?? "";
          message += `• <a href="${link}">${title}</a>\n\n`;
        }
        message += '<a href="https://bimaakbar-dev.github.io/blog/">Lihat semua →</a>';
        await ctx.reply(message, { parse_mode: "HTML" });
      } catch (err) {
        await ctx.reply("Gagal ambil artikel. Coba lagi nanti.");
      }
    });

    bot.command("anime", async (ctx) => {
      if (ctx.from?.id !== ADMIN_USER_ID) {
        await ctx.reply("⛔ Command ini hanya untuk admin.");
        return;
      }

      const argQuery = ctx.match?.trim() ?? "";
      const repliedText = ctx.message?.reply_to_message?.text;
      const query = argQuery || repliedText || "";

      await handleAnimeCommand(ctx, query);
    });

    bot
      .filter((ctx) => {
        const msg = ctx.message;
        return !!(msg && "new_chat_members" in msg && msg.new_chat_members);
      })
      .use(async (ctx) => {
        const msg = ctx.message;
        if (!msg || !("new_chat_members" in msg)) return;
        for (const member of msg.new_chat_members || []) {
          if (member.is_bot) continue;
          const name = member.first_name || member.username || "Pengguna";
          const mention = `[${name}](tg://user?id=${member.id})`;
          await ctx.reply(
            `Selamat datang ${mention} di c0desk1!\n\n` +
              `Aturan singkat:\n` +
              `• Saling menghormati\n` +
              `• No spam, no SARA\n` +
              `• Bahasa Indonesia/English OK`,
            { parse_mode: "Markdown" }
          );
        }
      });

    const handler = webhookCallback(bot, "cloudflare-mod");
    return handler(request);
  },
};

async function handleGithub(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  const valid = await verifySignature(env.GH_WEBHOOK_SECRET, body, signature);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(body) as any;

  if (event === "discussion" && payload.action === "created") {
    const disc = payload.discussion;
    await notifyGiscus(env, {
      title: "💬 Diskusi Baru",
      body: `**${disc.title}**\n\nOleh: @${disc.user.login}`,
      url: disc.html_url,
      color: 3447003,
    });
  }

  if (event === "discussion_comment" && payload.action === "created") {
    const comment = payload.comment;
    const disc = payload.discussion;
    const commentBody = comment.body || "";

    if (comment.user.login.endsWith("[bot]")) {
      return new Response("OK", { status: 200 });
    }

    const mentioned = /@bimaakbar(-dev)?|@admin|@c0desk1/i.test(commentBody);

    await notifyGiscus(env, {
      title: mentioned ? "📩 Mention di Giscus" : "💬 Komentar Baru",
      body: `**${disc.title}**\n\nDari: @${comment.user.login}\n\n${commentBody.slice(0, 200)}`,
      url: disc.html_url,
      color: mentioned ? 16738314 : 5763719,
    });

    if (mentioned) {
      try {
        const token = await getInstallationToken(
          env.GITHUB_APP_ID,
          env.GITHUB_APP_PRIVATE_KEY,
          payload.installation.id
        );
        await replyToComment(
          token,
          disc.node_id,
          comment.node_id,
          "Halo! 👋\n\nAda yang bisa dibantu? Kalau perlu respon cepat, DM saya:\n• Telegram: @Bimaakbar\n• Discord: discord.gg/zzaUTzWbm\n\n— c0desk1[bot]"
        );
      } catch (err) {
        console.error("Reply failed:", err);
      }
    }
  }

  return new Response("OK", { status: 200 });
}

async function notifyGiscus(
  env: Env,
  data: { title: string; body: string; url: string; color: number }
): Promise<void> {
  const tgMessage = `<b>${data.title}</b>\n\n${data.body}\n\n🔗 ${data.url}`;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.ADMIN_CHAT_ID,
      text: tgMessage,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  await fetch(env.DISCORD_WEBHOOK_GISCUS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: data.title,
          description: data.body,
          url: data.url,
          color: data.color,
          footer: { text: "c0desk1[bot] · giscus" },
        },
      ],
    }),
  });
}