import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { sqlNumber, withImmediateTransaction } from './db.js';
import { reservedBytes } from './files.js';
import { resolveFolder } from './folders.js';

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_OPEN_SESSIONS = 30;

export type UploadSessionRecord = {
  id: string;
  originalName: string;
  sizeBytes: number;
  receivedBytes: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type RecoverySession = {
  id: string;
  ownerId: string;
  sizeBytes: number;
  receivedBytes: number;
  expiresAt: string;
};

const busy = new Set<string>();

export function tryLockSession(id: string): boolean {
  if (busy.has(id)) return false;
  busy.add(id);
  return true;
}

export function unlockSession(id: string): void {
  busy.delete(id);
}

export function createUploadSession(
  db: DatabaseSync,
  input: { id: string; ownerId: string; originalName: string; sizeBytes: number; folderId: string | null; now?: Date },
  maxStorageBytes: number,
): { ok: true; session: UploadSessionRecord } | { ok: false; reason: 'quota' | 'too-many' | 'missing-folder' } {
  return withImmediateTransaction(db, () => {
    if (input.folderId && !resolveFolder(db, input.folderId).ok) {
      return { ok: false, reason: 'missing-folder' };
    }
    if (reservedBytes(db) + input.sizeBytes > maxStorageBytes) {
      return { ok: false, reason: 'quota' };
    }
    const count = db.prepare(
      'SELECT COUNT(*) AS n FROM upload_sessions WHERE owner_id = ?',
    ).get(input.ownerId) as { n: unknown };
    if (sqlNumber(count.n) >= MAX_OPEN_SESSIONS) {
      return { ok: false, reason: 'too-many' };
    }
    const now = input.now ?? new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    db.prepare(`
      INSERT INTO upload_sessions (
        id, owner_id, original_name, size_bytes, received_bytes, created_at, updated_at, expires_at, folder_id
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      input.id,
      input.ownerId,
      input.originalName,
      input.sizeBytes,
      createdAt,
      createdAt,
      expiresAt,
      input.folderId,
    );
    return {
      ok: true,
      session: {
        id: input.id,
        originalName: input.originalName,
        sizeBytes: input.sizeBytes,
        receivedBytes: 0,
        createdAt,
        updatedAt: createdAt,
        expiresAt,
      },
    };
  });
}

export function listOpenSessions(db: DatabaseSync, ownerId: string, nowIso: string): UploadSessionRecord[] {
  const rows = db.prepare(`
    SELECT id, original_name, size_bytes, received_bytes, created_at, updated_at, expires_at
    FROM upload_sessions
    WHERE owner_id = ? AND expires_at > ?
    ORDER BY created_at ASC
  `).all(ownerId, nowIso) as SessionRow[];
  return rows.map(mapSession);
}

export function sweepExpired(db: DatabaseSync, ownerId: string, nowIso: string): string[] {
  const rows = db.prepare(
    'SELECT id FROM upload_sessions WHERE owner_id = ? AND expires_at <= ?',
  ).all(ownerId, nowIso) as Array<{ id: string }>;
  if (rows.length === 0) return [];
  db.prepare('DELETE FROM upload_sessions WHERE owner_id = ? AND expires_at <= ?').run(ownerId, nowIso);
  return rows.map((row) => row.id);
}

export function getOwnedSession(
  db: DatabaseSync,
  id: string,
  ownerId: string,
): UploadSessionRecord | undefined {
  const row = db.prepare(`
    SELECT id, original_name, size_bytes, received_bytes, created_at, updated_at, expires_at
    FROM upload_sessions
    WHERE id = ? AND owner_id = ?
  `).get(id, ownerId) as SessionRow | undefined;
  return row ? mapSession(row) : undefined;
}

export function deleteOwnedSession(db: DatabaseSync, id: string, ownerId: string): boolean {
  const result = db.prepare('DELETE FROM upload_sessions WHERE id = ? AND owner_id = ?').run(id, ownerId);
  return result.changes === 1;
}

export function deleteSession(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(id);
}

export function advanceSession(
  db: DatabaseSync,
  id: string,
  ownerId: string,
  previous: number,
  next: number,
): boolean {
  const result = db.prepare(`
    UPDATE upload_sessions
    SET received_bytes = ?, updated_at = ?
    WHERE id = ? AND owner_id = ? AND received_bytes = ? AND size_bytes >= ?
  `).run(next, new Date().toISOString(), id, ownerId, previous, next);
  return result.changes === 1;
}

export function setReceivedBytes(db: DatabaseSync, id: string, receivedBytes: number): void {
  db.prepare(
    'UPDATE upload_sessions SET received_bytes = ?, updated_at = ? WHERE id = ?',
  ).run(receivedBytes, new Date().toISOString(), id);
}

export function listRecoverySessions(db: DatabaseSync): RecoverySession[] {
  const rows = db.prepare(`
    SELECT id, owner_id, size_bytes, received_bytes, expires_at
    FROM upload_sessions
  `).all() as Array<{
    id: string;
    owner_id: string;
    size_bytes: unknown;
    received_bytes: unknown;
    expires_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    sizeBytes: sqlNumber(row.size_bytes),
    receivedBytes: sqlNumber(row.received_bytes),
    expiresAt: row.expires_at,
  }));
}

export function takeForPublish(
  db: DatabaseSync,
  id: string,
  ownerId: string,
  maxStorageBytes: number,
  options: { enforceQuota?: boolean } = {},
): { ok: true; originalName: string; sizeBytes: number } | { ok: false; reason: 'missing' | 'incomplete' | 'quota' } {
  return withImmediateTransaction(db, () => {
    const row = db.prepare(`
      SELECT original_name, size_bytes, received_bytes, folder_id
      FROM upload_sessions
      WHERE id = ? AND owner_id = ?
    `).get(id, ownerId) as {
      original_name: string;
      size_bytes: unknown;
      received_bytes: unknown;
      folder_id: string | null;
    } | undefined;
    if (!row) return { ok: false, reason: 'missing' };
    const sizeBytes = sqlNumber(row.size_bytes);
    if (sqlNumber(row.received_bytes) !== sizeBytes) return { ok: false, reason: 'incomplete' };
    if (options.enforceQuota !== false && reservedBytes(db) > maxStorageBytes) {
      return { ok: false, reason: 'quota' };
    }
    const folderId = row.folder_id && resolveFolder(db, row.folder_id).ok ? row.folder_id : null;
    db.prepare('DELETE FROM upload_sessions WHERE id = ? AND owner_id = ?').run(id, ownerId);
    db.prepare(`
      INSERT INTO files (id, owner_id, original_name, size_bytes, created_at, state, folder_id)
      VALUES (?, ?, ?, ?, ?, 'staging', ?)
    `).run(id, ownerId, row.original_name, sizeBytes, new Date().toISOString(), folderId);
    return { ok: true, originalName: row.original_name, sizeBytes };
  });
}

export async function writeChunk(
  filePath: string,
  offset: number,
  source: AsyncIterable<Buffer | string>,
  expectedLength: number,
): Promise<'ok' | 'short'> {
  const handle = await open(filePath, 'r+');
  let written = 0;
  try {
    for await (const chunk of source) {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (written + piece.length > expectedLength) {
        await handle.truncate(offset);
        return 'short';
      }
      await writeAll(handle, piece, offset + written);
      written += piece.length;
    }
    if (written !== expectedLength) {
      await handle.truncate(offset);
      return 'short';
    }
    await handle.sync();
    return 'ok';
  } catch (error) {
    try {
      await handle.truncate(offset);
    } catch {
      // Keep the original failure.
    }
    const code = errorCode(error);
    if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') throw error;
    if (error instanceof TypeError) throw error;
    return 'short';
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  let pos = position;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, pos);
    if (bytesWritten <= 0) {
      throw Object.assign(new Error('The upload could not be saved.'), { code: 'EIO' });
    }
    offset += bytesWritten;
    pos += bytesWritten;
  }
}

type SessionRow = {
  id: string;
  original_name: string;
  size_bytes: unknown;
  received_bytes: unknown;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

function mapSession(row: SessionRow): UploadSessionRecord {
  return {
    id: row.id,
    originalName: row.original_name,
    sizeBytes: sqlNumber(row.size_bytes),
    receivedBytes: sqlNumber(row.received_bytes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return '';
}
