import type { DatabaseSync } from 'node:sqlite';
import { sqlNumber, withImmediateTransaction } from './db.js';
import type { FileRecord } from './types.js';

export type NewFile = {
  id: string;
  ownerId: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
};

type SortName = 'name' | 'size' | 'date';
type SortOrder = 'asc' | 'desc';

const ORDER_SQL: Record<string, string> = {
  'name:asc': 'f.original_name COLLATE NOCASE ASC, f.created_at DESC',
  'name:desc': 'f.original_name COLLATE NOCASE DESC, f.created_at DESC',
  'size:asc': 'f.size_bytes ASC, f.created_at DESC',
  'size:desc': 'f.size_bytes DESC, f.created_at DESC',
  'date:asc': 'f.created_at ASC, f.original_name COLLATE NOCASE ASC',
  'date:desc': 'f.created_at DESC, f.original_name COLLATE NOCASE ASC',
};

export function usedBytes(db: DatabaseSync): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) AS used FROM files WHERE state IN ('staging', 'ready')",
  ).get() as { used: unknown };
  return sqlNumber(row.used);
}

export function readyBytes(db: DatabaseSync): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) AS used FROM files WHERE state = 'ready'",
  ).get() as { used: unknown };
  return sqlNumber(row.used);
}

export function stageFile(
  db: DatabaseSync,
  file: NewFile,
  maxStorageBytes: number,
): { ok: true } | { ok: false } {
  return withImmediateTransaction(db, () => {
    const row = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS used FROM files').get() as { used: unknown };
    if (sqlNumber(row.used) + file.sizeBytes > maxStorageBytes) {
      return { ok: false };
    }
    db.prepare(`
      INSERT INTO files (id, owner_id, original_name, size_bytes, created_at, state)
      VALUES (?, ?, ?, ?, ?, 'staging')
    `).run(file.id, file.ownerId, file.originalName, file.sizeBytes, file.createdAt);
    return { ok: true };
  });
}

export function markReady(db: DatabaseSync, id: string): boolean {
  const result = db.prepare(
    "UPDATE files SET state = 'ready' WHERE id = ? AND state = 'staging'",
  ).run(id);
  return result.changes === 1;
}

export function removeFileRecord(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
}

export function listFiles(
  db: DatabaseSync,
  options: { query: string; sort: string; order: string; userId: string },
): FileRecord[] | null {
  const sort = options.sort as SortName;
  const order = options.order as SortOrder;
  const orderSql = ORDER_SQL[`${sort}:${order}`];
  if (!orderSql) return null;

  const params: Array<string> = [];
  let where = "WHERE f.state = 'ready'";
  if (options.query) {
    where += " AND f.original_name LIKE ? ESCAPE '\\'";
    params.push(likePattern(options.query));
  }

  const rows = db.prepare(`
    SELECT f.id, f.original_name, f.size_bytes, f.created_at, f.owner_id, u.username
    FROM files f
    JOIN users u ON u.id = f.owner_id
    ${where}
    ORDER BY ${orderSql}
  `).all(...params) as Array<{
    id: string;
    original_name: string;
    size_bytes: number;
    created_at: string;
    owner_id: string;
    username: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    originalName: row.original_name,
    sizeBytes: sqlNumber(row.size_bytes),
    createdAt: row.created_at,
    ownerId: row.owner_id,
    ownerUsername: row.username,
    canDelete: row.owner_id === options.userId,
  }));
}

export function getReadyFile(db: DatabaseSync, id: string, userId: string): FileRecord | undefined {
  const row = db.prepare(`
    SELECT f.id, f.original_name, f.size_bytes, f.created_at, f.owner_id, u.username
    FROM files f
    JOIN users u ON u.id = f.owner_id
    WHERE f.id = ? AND f.state = 'ready'
  `).get(id) as {
    id: string;
    original_name: string;
    size_bytes: number;
    created_at: string;
    owner_id: string;
    username: string;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    originalName: row.original_name,
    sizeBytes: sqlNumber(row.size_bytes),
    createdAt: row.created_at,
    ownerId: row.owner_id,
    ownerUsername: row.username,
    canDelete: row.owner_id === userId,
  };
}

export function deleteOwnedFile(db: DatabaseSync, id: string, ownerId: string): 'deleted' | 'missing' | 'forbidden' {
  const result = db.prepare(
    "DELETE FROM files WHERE id = ? AND owner_id = ? AND state = 'ready'",
  ).run(id, ownerId);
  if (result.changes === 1) return 'deleted';
  const existing = db.prepare(
    "SELECT owner_id FROM files WHERE id = ? AND state = 'ready'",
  ).get(id) as { owner_id: string } | undefined;
  return existing ? 'forbidden' : 'missing';
}

export function listStaging(db: DatabaseSync): NewFile[] {
  const rows = db.prepare(`
    SELECT id, owner_id, original_name, size_bytes, created_at
    FROM files WHERE state = 'staging'
  `).all() as Array<{
    id: string;
    owner_id: string;
    original_name: string;
    size_bytes: number;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    originalName: row.original_name,
    sizeBytes: sqlNumber(row.size_bytes),
    createdAt: row.created_at,
  }));
}

export function listReadyIds(db: DatabaseSync): Array<{ id: string; sizeBytes: number }> {
  const rows = db.prepare(
    "SELECT id, size_bytes FROM files WHERE state = 'ready'",
  ).all() as Array<{ id: string; size_bytes: number }>;
  return rows.map((row) => ({ id: row.id, sizeBytes: sqlNumber(row.size_bytes) }));
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
