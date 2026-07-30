// Auth crypto primitives — all from Node's built-in crypto, no dependencies.
// Password hashing (scrypt), session tokens (HMAC), and secret encryption
// (AES-256-GCM) for API keys at rest.

import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHmac,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { config } from '../config.js';

// A stable process-lifetime key. If APP_SECRET is unset we generate an
// ephemeral one so the app still runs, but sessions and stored secrets won't
// survive a restart — the server logs a warning about this at boot.
export const APP_SECRET = config.appSecret || randomBytes(32).toString('hex');
export const APP_SECRET_IS_EPHEMERAL = !config.appSecret;

// --- Passwords -------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// --- Session tokens (HMAC-signed, stateless) -------------------------------

interface SessionPayload {
  uid: string;
  iat: number;
}

export function signSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
}

// --- Secret encryption at rest (AES-256-GCM) -------------------------------

const encKey = scryptSync(APP_SECRET, 'ai-eth-trade-enc', 32);

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return ''; // wrong key (e.g. APP_SECRET changed) or corrupt data
  }
}
