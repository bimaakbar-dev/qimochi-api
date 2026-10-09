export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number;
}

export function getClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

export async function hashKey(input: string): Promise<string> {
  const data = new TextEncoder().encode(input + '|qimochi-rl-v1');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export async function checkRateLimit(
  db: D1Database,
  key: string,
  max: number,
  windowSec: number
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSec;

  const row = await db
    .prepare('SELECT count, window_start FROM rate_limits WHERE key = ?')
    .bind(key)
    .first<{ count: number; window_start: number }>();

  if (!row || row.window_start < windowStart) {
    await db
      .prepare(
        `INSERT INTO rate_limits (key, count, window_start)
         VALUES (?, 1, ?)
         ON CONFLICT (key) DO UPDATE SET
           count = 1,
           window_start = excluded.window_start`
      )
      .bind(key, now)
      .run();
    return { ok: true, remaining: max - 1, retryAfter: 0 };
  }

  if (row.count >= max) {
    return {
      ok: false,
      remaining: 0,
      retryAfter: row.window_start + windowSec - now,
    };
  }

  await db
    .prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?')
    .bind(key)
    .run();

  return { ok: true, remaining: max - row.count - 1, retryAfter: 0 };
}

export async function cleanupRateLimits(
  db: D1Database,
  olderThanSec: number
): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSec;
  await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(cutoff)
    .run();
}