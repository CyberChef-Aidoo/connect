import type { DatabaseSync } from 'node:sqlite';
import { sqlNumber, withImmediateTransaction } from './db.js';
import type { FileRecord } from './types.js';

export type NewFile = {
  id: string;
  ownerId: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
  folderId?: string | null;
};

type SortName = 'name' | 'size' | 'date';
type SortOrder = 'asc' | 'desc';

const ORDER_SQL: Record<string, string> = {
  'name:asc': 'f.original_name COLLATE NOCASE ASC, f.id ASC',
  'name:desc': 'f.original_name COLLATE NOCASE DESC, f.id DESC',
  'size:asc': 'f.size_bytes ASC, f.id ASC',
  'size:desc': 'f.size_bytes DESC, f.id DESC',
  'date:asc': 'f.created_at ASC, f.id ASC',
  'date:desc': 'f.created_at DESC, f.id DESC',
};

const CURSOR_SQL: Record<string, string> = {
  'name:asc': '(f.original_name COLLATE NOCASE > ? OR (f.original_name COLLATE NOCASE = ? AND f.id > ?))',
  'name:desc': '(f.original_name COLLATE NOCASE < ? OR (f.original_name COLLATE NOCASE = ? AND f.id < ?))',
  'size:asc': '(f.size_bytes > ? OR (f.size_bytes = ? AND f.id > ?))',
  'size:desc': '(f.size_bytes < ? OR (f.size_bytes = ? AND f.id < ?))',
  'date:asc': '(f.created_at > ? OR (f.created_at = ? AND f.id > ?))',
  'date:desc': '(f.created_at < ? OR (f.created_at = ? AND f.id < ?))',
};

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

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

export function reservedBytes(db: DatabaseSync): number {
  const files = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS used FROM files').get() as { used: unknown };
  const sessions = db.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS used FROM upload_sessions',
  ).get() as { used: unknown };
  return sqlNumber(files.used) + sqlNumber(sessions.used);
}

export function displayedUsedBytes(db: DatabaseSync): number {
  const sessions = db.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS used FROM upload_sessions',
  ).get() as { used: unknown };
  return readyBytes(db) + sqlNumber(sessions.used);
}

export function stageFile(
  db: DatabaseSync,
  file: NewFile,
  maxStorageBytes: number,
): { ok: true } | { ok: false } {
  return withImmediateTransaction(db, () => {
    if (reservedBytes(db) + file.sizeBytes > maxStorageBytes) {
      return { ok: false };
    }
    db.prepare(`
      INSERT INTO files (id, owner_id, original_name, size_bytes, created_at, state, folder_id)
      VALUES (?, ?, ?, ?, ?, 'staging', ?)
    `).run(file.id, file.ownerId, file.originalName, file.sizeBytes, file.createdAt, file.folderId ?? null);
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

export type FilePage = { files: FileRecord[]; nextCursor: string | null };

export function listFiles(
  db: DatabaseSync,
  options: {
    query: string;
    sort: string;
    order: string;
    userId: string;
    folderId: string | null;
    limit: number;
    cursor: string | null;
  },
): FilePage | 'bad-sort' | 'bad-cursor' {
  const sort = options.sort as SortName;
  const order = options.order as SortOrder;
  const key = `${sort}:${order}`;
  const orderSql = ORDER_SQL[key];
  const cursorSql = CURSOR_SQL[key];
  if (!orderSql || !cursorSql) return 'bad-sort';

  const params: Array<string | number> = [];
  let where = "WHERE f.state = 'ready'";
  if (options.query) {
    where += " AND f.original_name LIKE ? ESCAPE '\\'";
    params.push(likePattern(options.query));
  } else if (options.folderId) {
    where += ' AND f.folder_id = ?';
    params.push(options.folderId);
  } else {
    where += ' AND f.folder_id IS NULL';
  }
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    if (!cursor) return 'bad-cursor';
    const primary = sort === 'size' ? Number(cursor.primary) : cursor.primary;
    if (sort === 'size' && !Number.isSafeInteger(primary)) return 'bad-cursor';
    where += ` AND ${cursorSql}`;
    params.push(primary, primary, cursor.id);
  }

  const rows = db.prepare(`
    SELECT f.id, f.original_name, f.size_bytes, f.created_at, f.owner_id, f.folder_id, u.username, d.name AS folder_name
    FROM files f
    JOIN users u ON u.id = f.owner_id
    LEFT JOIN folders d ON d.id = f.folder_id
    ${where}
    ORDER BY ${orderSql}
    LIMIT ?
  `).all(...params, options.limit + 1) as FileRow[];

  const page = rows.slice(0, options.limit).map((row) => mapFile(row, options.userId));
  const last = page.at(-1);
  const nextCursor = rows.length > options.limit && last
    ? encodeCursor(sort === 'name' ? last.originalName : sort === 'size' ? String(last.sizeBytes) : last.createdAt, last.id)
    : null;
  return { files: page, nextCursor };
}

export function getReadyFile(db: DatabaseSync, id: string, userId: string): FileRecord | undefined {
  const row = db.prepare(`
    SELECT f.id, f.original_name, f.size_bytes, f.created_at, f.owner_id, f.folder_id, u.username, d.name AS folder_name
    FROM files f
    JOIN users u ON u.id = f.owner_id
    LEFT JOIN folders d ON d.id = f.folder_id
    WHERE f.id = ? AND f.state = 'ready'
  `).get(id) as FileRow | undefined;
  return row ? mapFile(row, userId) : undefined;
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

type FileRow = {
  id: string;
  original_name: string;
  size_bytes: unknown;
  created_at: string;
  owner_id: string;
  folder_id: string | null;
  username: string;
  folder_name: string | null;
};

function mapFile(row: FileRow, userId: string): FileRecord {
  return {
    id: row.id,
    originalName: row.original_name,
    sizeBytes: sqlNumber(row.size_bytes),
    createdAt: row.created_at,
    ownerId: row.owner_id,
    ownerUsername: row.username,
    canDelete: row.owner_id === userId,
    folderId: row.folder_id,
    folderName: row.folder_name,
  };
}

function encodeCursor(primary: string, id: string): string {
  return Buffer.from(JSON.stringify({ p: primary, id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { primary: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { p?: unknown; id?: unknown };
    if (typeof parsed.p !== 'string' || typeof parsed.id !== 'string') return null;
    if (!/^[0-9a-f-]{36}$/i.test(parsed.id)) return null;
    return { primary: parsed.p, id: parsed.id };
  } catch {
    return null;
  }
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
