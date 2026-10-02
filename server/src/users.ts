import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './passwords.js';

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

export type UserRow = {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
};

export function usernameProblem(username: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return 'Usernames must be 3–32 characters and use only letters, numbers, periods, underscores, and hyphens.';
  }
  return null;
}

export async function createUser(
  db: DatabaseSync,
  username: string,
  password: string,
  cost?: number,
): Promise<UserRow> {
  const nameError = usernameProblem(username);
  if (nameError) throw new Error(nameError);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const passwordHash = await hashPassword(password, cost);
  try {
    db.prepare(
      'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, username, passwordHash, createdAt);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error('That username is already in use.');
    }
    throw error;
  }
  return { id, username, passwordHash, createdAt };
}

export function findUserByUsername(db: DatabaseSync, username: string): UserRow | undefined {
  const row = db.prepare(
    'SELECT id, username, password_hash, created_at FROM users WHERE username = ? COLLATE NOCASE',
  ).get(username) as RawUser | undefined;
  return row ? mapUser(row) : undefined;
}

export function findUserById(db: DatabaseSync, id: string): UserRow | undefined {
  const row = db.prepare(
    'SELECT id, username, password_hash, created_at FROM users WHERE id = ?',
  ).get(id) as RawUser | undefined;
  return row ? mapUser(row) : undefined;
}

type RawUser = {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
};

function mapUser(row: RawUser): UserRow {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/i.test(error.message);
}
