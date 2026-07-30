// Session cookie handling + route guard. No cookie-parser dependency; we read
// the Cookie header directly.

import type { Request, Response, NextFunction } from 'express';
import { signSession, verifySession } from './crypto.js';
import { findById, toPublic, type PublicUser } from './users.js';

const COOKIE = 'sid';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setSessionCookie(res: Response, userId: string): void {
  const token = signSession({ uid: userId, iat: Date.now() });
  const secure = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Resolve the current user from the session cookie, or null. */
export function currentUser(req: Request): PublicUser | null {
  const token = parseCookies(req.header('cookie'))[COOKIE];
  const session = verifySession(token);
  if (!session) return null;
  const user = findById(session.uid);
  return user ? toPublic(user) : null;
}

/** Guard: 401 unless a valid session resolves to a known user. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = user;
  next();
}
