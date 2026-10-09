import { signJwt, verifyJwt, type JwtPayload } from './jwt';

const COOKIE_NAME = 'qimochi_session';
const COOKIE_DOMAIN = '.qimochi.web.id';
const MAX_AGE = 60 * 60 * 24 * 30;

export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export function buildSessionCookie(token: string): string {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    `Domain=${COOKIE_DOMAIN}`,
    `Max-Age=${MAX_AGE}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export function buildClearCookie(): string {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    `Domain=${COOKIE_DOMAIN}`,
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function readSessionToken(request: Request): string | null {
  const cookies = parseCookies(request.headers.get('Cookie'));
  return cookies[COOKIE_NAME] ?? null;
}

export async function getSession(
  request: Request,
  secret: string
): Promise<JwtPayload | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  return verifyJwt(token, secret);
}

export async function createSessionToken(
  user: SessionUser,
  secret: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      sub: user.sub,
      email: user.email,
      name: user.name,
      picture: user.picture,
      iat: now,
      exp: now + MAX_AGE,
    },
    secret
  );
}