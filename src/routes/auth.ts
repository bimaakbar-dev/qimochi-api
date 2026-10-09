import type { Ctx, Router } from '../lib/router';
import { json, error } from '../lib/response';
import { verifyGoogleIdToken } from '../lib/google';
import {
  buildSessionCookie,
  buildClearCookie,
  createSessionToken,
  getSession,
} from '../lib/session';

async function googleLogin(ctx: Ctx): Promise<Response> {
  let body: { credential?: string };
  try {
    body = (await ctx.request.json()) as { credential?: string };
  } catch {
    return error('INVALID_JSON', 'Body bukan JSON valid', ctx.env, 400);
  }

  const credential = body.credential;
  if (!credential || typeof credential !== 'string') {
    return error('MISSING_CREDENTIAL', 'Credential wajib diisi', ctx.env, 400);
  }

  const clientId = ctx.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return error('SERVER_MISCONFIGURED', 'GOOGLE_CLIENT_ID belum diset', ctx.env, 500);
  }

  const googleUser = await verifyGoogleIdToken(credential, clientId);
  if (!googleUser) {
    return error('INVALID_CREDENTIAL', 'Token Google tidak valid', ctx.env, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  await ctx.env.DB.prepare(
    `INSERT INTO users (id, email, name, picture, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       picture = excluded.picture,
       last_seen_at = excluded.last_seen_at`
  )
    .bind(
      googleUser.sub,
      googleUser.email,
      googleUser.name,
      googleUser.picture ?? null,
      now,
      now
    )
    .run();

  const token = await createSessionToken(
    {
      sub: googleUser.sub,
      email: googleUser.email,
      name: googleUser.name,
      picture: googleUser.picture,
    },
    ctx.env.SESSION_SECRET
  );

  return json(
    {
      ok: true,
      user: {
        sub: googleUser.sub,
        email: googleUser.email,
        name: googleUser.name,
        picture: googleUser.picture ?? null,
      },
    },
    ctx.env,
    200,
    { 'Set-Cookie': buildSessionCookie(token) }
  );
}

async function me(ctx: Ctx): Promise<Response> {
  const session = await getSession(ctx.request, ctx.env.SESSION_SECRET);
  if (!session) {
    return json({ ok: false, user: null }, ctx.env);
  }
  return json(
    {
      ok: true,
      user: {
        sub: session.sub,
        email: session.email,
        name: session.name,
        picture: session.picture ?? null,
      },
    },
    ctx.env
  );
}

async function logout(ctx: Ctx): Promise<Response> {
  return json({ ok: true }, ctx.env, 200, {
    'Set-Cookie': buildClearCookie(),
  });
}

export function mountAuth(router: Router): void {
  router.post('/api/v1/auth/google', googleLogin);
  router.get('/api/v1/auth/me', me);
  router.post('/api/v1/auth/logout', logout);
}