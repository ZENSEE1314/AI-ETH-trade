// User accounts: register, authenticate, persist. Passwords are never stored
// in plaintext (scrypt), and the API never returns password hashes.

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { readJson, writeJson } from '../store.js';
import { hashPassword, verifyPassword } from './crypto.js';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
}

export interface PublicUser {
  id: string;
  username: string;
  createdAt: number;
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;

let users: User[] = readJson<User[]>('users', []);

function persist(): void {
  writeJson('users', users);
}

export function toPublic(u: User): PublicUser {
  return { id: u.id, username: u.username, createdAt: u.createdAt };
}

export function userCount(): number {
  return users.length;
}

export function findById(id: string): User | undefined {
  return users.find((u) => u.id === id);
}

export class AuthError extends Error {}

/**
 * Register a new account. The first account (bootstrap owner) is always
 * allowed; subsequent registrations require the configured REGISTRATION_CODE.
 */
export function register(username: string, password: string, code: string | undefined): PublicUser {
  const name = username?.trim();
  if (!USERNAME_RE.test(name ?? '')) {
    throw new AuthError('Username must be 3-32 chars: letters, numbers, . _ -');
  }
  if (!password || password.length < MIN_PASSWORD) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    throw new AuthError('Username already taken.');
  }

  const isBootstrap = users.length === 0;
  if (!isBootstrap) {
    if (!config.registrationCode) throw new AuthError('Registration is closed.');
    if (code !== config.registrationCode) throw new AuthError('Invalid registration code.');
  }

  const user: User = {
    id: randomUUID(),
    username: name,
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
  };
  users.push(user);
  persist();
  return toPublic(user);
}

export function authenticate(username: string, password: string): User {
  const user = users.find((u) => u.username.toLowerCase() === username?.trim().toLowerCase());
  // Always run a verify to keep timing similar whether or not the user exists.
  const ok = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, 'x:y');
  if (!user || !ok) throw new AuthError('Invalid username or password.');
  return user;
}
