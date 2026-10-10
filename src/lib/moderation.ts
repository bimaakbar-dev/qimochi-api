export type ModerationDecision = 'approved' | 'rejected' | 'pending';

export interface ModerationResult {
  decision: ModerationDecision;
  reason: string;
  matched: string | null;
}

interface ModerationEnv {
  BAD_WORDS?: string;
  AUTO_MODERATE?: string;
}

const LEET_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
};

const SUSPICIOUS_TLDS = [
  '.tk',
  '.ml',
  '.ga',
  '.cf',
  '.gq',
  '.xyz',
  '.top',
  '.click',
  '.work',
  '.loan',
  '.racing',
  '.download',
  '.stream',
];

function normalize(input: string): string {
  let s = input.toLowerCase();
  s = s.replace(/[0-9@$]/g, (m) => LEET_MAP[m] ?? m);
  s = s.replace(/[^a-z\s]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function collapseRepeats(input: string): string {
  return input.replace(/(.)\1{2,}/g, '$1$1');
}

function parseBadWords(env: ModerationEnv): string[] {
  const raw = env.BAD_WORDS ?? '';
  return raw
    .split(',')
    .map((w) => normalize(collapseRepeats(w)))
    .map((w) => w.trim())
    .filter(Boolean);
}

function isAutoModerateOn(env: ModerationEnv): boolean {
  const v = (env.AUTO_MODERATE ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function countUrls(text: string): number {
  const m = text.match(/https?:\/\/[^\s]+/gi);
  return m ? m.length : 0;
}

function hasSuspiciousUrl(text: string): boolean {
  const lower = text.toLowerCase();
  for (const tld of SUSPICIOUS_TLDS) {
    if (lower.includes(tld)) return true;
  }
  return false;
}

function capsRatio(text: string): number {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 15) return 0;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length;
}

function tooManyRepeats(text: string): boolean {
  return /(.)\1{9,}/.test(text);
}

export function moderate(text: string, env: ModerationEnv): ModerationResult {
  const normalized = normalize(collapseRepeats(text));
  const words = normalized.split(' ');

  const badWords = parseBadWords(env);
  for (const bw of badWords) {
    const bwParts = bw.split(' ');
    if (bwParts.length === 1) {
      if (words.includes(bw)) {
        return {
          decision: 'rejected',
          reason: `Mengandung kata terlarang`,
          matched: bw,
        };
      }
    } else {
      if (normalized.includes(bw)) {
        return {
          decision: 'rejected',
          reason: `Mengandung frasa terlarang`,
          matched: bw,
        };
      }
    }
  }

  if (countUrls(text) >= 3) {
    return {
      decision: 'pending',
      reason: 'Banyak link — perlu review manual',
      matched: null,
    };
  }

  if (hasSuspiciousUrl(text)) {
    return {
      decision: 'pending',
      reason: 'URL mencurigakan — perlu review manual',
      matched: null,
    };
  }

  if (capsRatio(text) > 0.7) {
    return {
      decision: 'pending',
      reason: 'Terlalu banyak huruf kapital',
      matched: null,
    };
  }

  if (tooManyRepeats(text)) {
    return {
      decision: 'pending',
      reason: 'Karakter berulang berlebihan',
      matched: null,
    };
  }

  if (isAutoModerateOn(env)) {
    return {
      decision: 'approved',
      reason: 'Auto-approved',
      matched: null,
    };
  }

  return {
    decision: 'pending',
    reason: '',
    matched: null,
  };
}
