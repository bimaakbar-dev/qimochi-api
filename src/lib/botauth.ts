export async function constantTimeEqual(
  a: string,
  b: string
): Promise<boolean> {
  const enc = new TextEncoder();
  const ha = new Uint8Array(
    await crypto.subtle.digest('SHA-256', enc.encode(a))
  );
  const hb = new Uint8Array(
    await crypto.subtle.digest('SHA-256', enc.encode(b))
  );
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}

export function extractBearer(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

export async function requireBot(
  request: Request,
  secret: string
): Promise<boolean> {
  if (!secret) return false;
  const token = extractBearer(request);
  if (!token) return false;
  return constantTimeEqual(token, secret);
}