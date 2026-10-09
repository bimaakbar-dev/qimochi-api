interface TurnstileVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
}

const VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  token: string,
  secret: string,
  remoteIp?: string
): Promise<boolean> {
  if (!token) return false;

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);

  let res: Response;
  try {
    res = await fetch(VERIFY_URL, { method: 'POST', body: form });
  } catch {
    return false;
  }

  if (!res.ok) return false;

  let data: TurnstileVerifyResponse;
  try {
    data = (await res.json()) as TurnstileVerifyResponse;
  } catch {
    return false;
  }

  return data.success === true;
}