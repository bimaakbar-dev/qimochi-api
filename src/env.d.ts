export interface Env {
  DB: D1Database;
  ALLOWED_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  SESSION_SECRET: string;
  TURNSTILE_SECRET: string;
  BOT_SECRET: string;
  BOT_WEBHOOK?: string;
}