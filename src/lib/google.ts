export interface GoogleUser {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
}

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

interface Jwks {
  keys: Jwk[];
}

interface IdTokenPayload {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
  exp: number;
  iat: number;
}

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL = 3600;

let cachedJwks: { data: Jwks; exp: number } | null = null;

function b64urlToUint8(b64: string): Uint8Array {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const s = b64.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getJwks(): Promise<Jwks> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwks && cachedJwks.exp > now) return cachedJwks.data;

  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = (await res.json()) as Jwks;
  cachedJwks = { data, exp: now + JWKS_TTL };
  return data;
}

async function importKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

export async function verifyGoogleIdToken(
  token: string,
  clientId: string
): Promise<GoogleUser | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const sigB64 = parts[2]!;

  let header: { alg: string; kid: string };
  try {
    header = JSON.parse(
      new TextDecoder().decode(b64urlToUint8(headerB64))
    ) as { alg: string; kid: string };
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || !header.kid) return null;

  let jwks: Jwks;
  try {
    jwks = await getJwks();
  } catch {
    return null;
  }

  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let valid = false;
  try {
    const key = await importKey(jwk);
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToUint8(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: IdTokenPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(b64urlToUint8(payloadB64))
    ) as IdTokenPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;
  if (
    payload.iss !== 'https://accounts.google.com' &&
    payload.iss !== 'accounts.google.com'
  ) {
    return null;
  }
  if (payload.aud !== clientId) return null;
  if (!payload.email_verified) return null;

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    emailVerified: true,
  };
}