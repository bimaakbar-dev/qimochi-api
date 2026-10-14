import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import { checkRateLimit, getClientIp, hashKey } from '../lib/ratelimit';

const FETCH_TIMEOUT_MS = 6000;
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

function isValidUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!ALLOWED_PROTOCOLS.includes(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function probe(ctx: Ctx): Promise<Response> {
  const target = isValidUrl(ctx.url.searchParams.get('url'));
  if (!target) {
    return error('INVALID_URL', 'URL tidak valid', ctx.env, 400);
  }

  const ip = getClientIp(ctx.request);
  const key = await hashKey(`probe:${ip}`);
  const limit = await checkRateLimit(ctx.env.DB, `${key}:m`, 60, 60);
  if (!limit.ok) {
    return json(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Terlalu banyak permintaan',
          status: 429,
        },
      },
      ctx.env,
      429,
      { 'Retry-After': String(limit.retryAfter) }
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const t0 = Date.now();

  try {
    const res = await fetch(target, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: '*/*',
      },
    });
    clearTimeout(timeoutId);

    return json(
      {
        ok: res.status >= 200 && res.status < 400,
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get('content-type') ?? '',
        finalUrl: res.url || target,
        elapsed: Date.now() - t0,
      },
      ctx.env,
      200,
      { 'Cache-Control': 'no-store' }
    );
  } catch (err) {
    clearTimeout(timeoutId);

    const isAbort = err instanceof Error && err.name === 'AbortError';
    return json(
      {
        ok: false,
        status: 0,
        statusText: isAbort ? 'timeout' : 'network-error',
        contentType: '',
        finalUrl: target,
        elapsed: Date.now() - t0,
      },
      ctx.env,
      200,
      { 'Cache-Control': 'no-store' }
    );
  }
}

export function mountProbe(router: Router): void {
  router.get('/api/v1/probe', probe);
}