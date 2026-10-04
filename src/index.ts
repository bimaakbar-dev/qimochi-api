// src/index.ts
// Qimochi API — Rating Endpoint
// Cloudflare Worker + D1

interface Env {
  DB: D1Database;
}

// ============================================================
// TYPES
// ============================================================
interface RatingRow {
  anime_id: string;
  average: number;
  votes: number;
}

// ============================================================
// CONSTANTS
// ============================================================
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  ...CORS_HEADERS,
};

// ============================================================
// HELPERS
// ============================================================
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}

function error(code: string, message: string, status = 400): Response {
  return json({ error: { code, message, status } }, status);
}

async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + 'qimochi-salt-v1');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

function getUserId(request: Request): string | null {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  // Nanti bisa pakai cookie untuk identity yang lebih baik
  return ip;
}

function getAnimeIdFromPath(path: string): string | null {
  // /api/v1/ratings/[animeId]  atau  /api/v1/ratings/[animeId]/
  const match = path.match(/^\/api\/v1\/ratings\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

// ============================================================
// ROUTE HANDLERS
// ============================================================

/**
 * GET /api/v1/ratings              → list semua summary
 * GET /api/v1/ratings/[animeId]    → summary 1 anime
 */
async function handleGet(request: Request, env: Env, animeId: string | null) {
  if (animeId) {
    const row = await env.DB.prepare(
      'SELECT anime_id, average, votes FROM rating_summary WHERE anime_id = ?'
    )
      .bind(animeId)
      .first<RatingRow>();

    if (!row) {
      return json({ data: { animeId, average: 0, votes: 0 } });
    }

    return json({
      data: {
        animeId: row.anime_id,
        average: row.average,
        votes: row.votes,
      },
    });
  }

  // List semua
  const { results } = await env.DB.prepare(
    'SELECT anime_id, average, votes FROM rating_summary ORDER BY anime_id'
  ).all<RatingRow>();

  const data: Record<string, { average: number; votes: number }> = {};
  for (const row of results ?? []) {
    data[row.anime_id] = { average: row.average, votes: row.votes };
  }

  return json({ data, total: Object.keys(data).length });
}

/**
 * POST /api/v1/ratings/[animeId]
 * Body: { score: 1-5 }
 */
async function handlePost(
  request: Request,
  env: Env,
  animeId: string | null
) {
  if (!animeId) {
    return error('BAD_REQUEST', 'Missing anime id', 400);
  }

  // Parse body
  let body: { score?: number };
  try {
    body = await request.json();
  } catch {
    return error('INVALID_JSON', 'Body bukan JSON valid', 400);
  }

  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return error('INVALID_SCORE', 'Score harus integer 1-5', 400);
  }

  // User identity
  const userId = getUserId(request);
  if (!userId) {
    return error('NO_USER_ID', 'Tidak bisa identifikasi user', 400);
  }
  const userHash = await hashIP(userId);

  // UPSERT rating
  await env.DB.prepare(
    `INSERT INTO ratings (anime_id, user_id, score)
     VALUES (?, ?, ?)
     ON CONFLICT (anime_id, user_id)
     DO UPDATE SET score = excluded.score, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(animeId, userHash, score)
    .run();

  // Update summary
  await env.DB.prepare(
    `INSERT INTO rating_summary (anime_id, average, votes, updated_at)
     SELECT 
       ?,
       COALESCE(AVG(score) * 2, 0),
       COUNT(*),
       CURRENT_TIMESTAMP
     FROM ratings
     WHERE anime_id = ?
     ON CONFLICT (anime_id)
     DO UPDATE SET
       average = excluded.average,
       votes = excluded.votes,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(animeId, animeId)
    .run();

  // Baca summary baru
  const summary = await env.DB.prepare(
    'SELECT average, votes FROM rating_summary WHERE anime_id = ?'
  )
    .bind(animeId)
    .first<{ average: number; votes: number }>();

  return json({
    ok: true,
    message: 'Rating tersimpan',
    data: {
      animeId,
      yourScore: score,
      average: summary?.average ?? 0,
      votes: summary?.votes ?? 0,
    },
  });
}

/**
 * DELETE /api/v1/ratings/[animeId] → hapus vote user ini
 */
async function handleDelete(
  request: Request,
  env: Env,
  animeId: string | null
) {
  if (!animeId) {
    return error('BAD_REQUEST', 'Missing anime id', 400);
  }

  const userId = getUserId(request);
  if (!userId) {
    return error('NO_USER_ID', 'Tidak bisa identifikasi user', 400);
  }
  const userHash = await hashIP(userId);

  const result = await env.DB.prepare(
    'DELETE FROM ratings WHERE anime_id = ? AND user_id = ?'
  )
    .bind(animeId, userHash)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    return error('NOT_FOUND', 'Rating tidak ditemukan', 404);
  }

  // Update summary
  await env.DB.prepare(
    `INSERT INTO rating_summary (anime_id, average, votes, updated_at)
     SELECT 
       ?,
       COALESCE(AVG(score) * 2, 0),
       COUNT(*),
       CURRENT_TIMESTAMP
     FROM ratings
     WHERE anime_id = ?
     ON CONFLICT (anime_id)
     DO UPDATE SET
       average = excluded.average,
       votes = excluded.votes,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(animeId, animeId)
    .run();

  return json({ ok: true, message: 'Rating dihapus' });
}

// ============================================================
// MAIN HANDLER
// ============================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (path === '/' || path === '/health') {
      return json({
        name: 'Qimochi API',
        version: 'v1',
        status: 'ok',
        timestamp: new Date().toISOString(),
      });
    }

    // Rating routes
    if (path === '/api/v1/ratings' || path.startsWith('/api/v1/ratings/')) {
      const animeId = getAnimeIdFromPath(path);

      try {
        if (method === 'GET') return handleGet(request, env, animeId);
        if (method === 'POST') return handlePost(request, env, animeId);
        if (method === 'DELETE') return handleDelete(request, env, animeId);
        return error('METHOD_NOT_ALLOWED', `${method} tidak didukung`, 405);
      } catch (err) {
        console.error('[worker error]', err);
        return error('INTERNAL_ERROR', 'Terjadi kesalahan di server', 500);
      }
    }

    return error('NOT_FOUND', `Path ${path} tidak ditemukan`, 404);
  },
} satisfies ExportedHandler<Env>;