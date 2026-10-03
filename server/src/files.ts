import type { DatabaseSync } from 'node:sqlite';
import { sqlNumber, withImmediateTransaction } from './db.js';
import { attachCatalog } from './catalog.js';
import { previewKind } from './preview.js';
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

export const BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
    favoriteOnly?: boolean;
    tagId?: string | null;
    collectionId?: string | null;
  },
): FilePage | 'bad-sort' | 'bad-cursor' {
  const sort = options.sort as SortName;
  const order = options.order as SortOrder;
  const key = `${sort}:${order}`;
  const orderSql = ORDER_SQL[key];
  const cursorSql = CURSOR_SQL[key];
  if (!orderSql || !cursorSql) return 'bad-sort';

  const params: Array<string | number> = [options.userId];
  const wide = Boolean(options.query || options.favoriteOnly || options.tagId || options.collectionId);
  let where = "WHERE f.state = 'ready' AND f.deleted_at IS NULL";
  if (options.query) {
    where += " AND f.original_name LIKE ? ESCAPE '\\'";
    params.push(likePattern(options.query));
  } else if (!wide && options.folderId) {
    where += ' AND f.folder_id = ?';
    params.push(options.folderId);
  } else if (!wide) {
    where += ' AND f.folder_id IS NULL';
  }
  if (options.favoriteOnly) where += ' AND fav.user_id IS NOT NULL';
  if (options.tagId) {
    where += ' AND EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id AND ft.tag_id = ?)';
    params.push(options.tagId);
  }
  if (options.collectionId) {
    where += ' AND EXISTS (SELECT 1 FROM collection_files cf WHERE cf.file_id = f.id AND cf.collection_id = ?)';
    params.push(options.collectionId);
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
    LEFT JOIN favorites fav ON fav.file_id = f.id AND fav.user_id = ?
    ${where}
    ORDER BY ${orderSql}
    LIMIT ?
  `).all(...params, options.limit + 1) as FileRow[];

  const page = rows.slice(0, options.limit).map((row) => mapFile(row, options.userId));
  attachCatalog(db, page, options.userId);
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
    WHERE f.id = ? AND f.state = 'ready' AND f.deleted_at IS NULL
  `).get(id) as FileRow | undefined;
  if (!row) return undefined;
  const file = mapFile(row, userId);
  attachCatalog(db, [file], userId);
  return file;
}

export type SkippedFile = { id: string; reason: 'missing' | 'forbidden' };

export function moveOwnedFiles(
  db: DatabaseSync,
  ownerId: string,
  ids: string[],
  folderId: string | null,
): { moved: string[]; skipped: SkippedFile[] } {
  return withImmediateTransaction(db, () => applyOwnedChange(db, ownerId, ids, (id) => {
    const result = db.prepare(
      "UPDATE files SET folder_id = ? WHERE id = ? AND owner_id = ? AND state = 'ready' AND deleted_at IS NULL",
    ).run(folderId, id, ownerId);
    return result.changes === 1;
  }));
}

export function deleteOwnedFiles(
  db: DatabaseSync,
  ownerId: string,
  ids: string[],
): { deleted: string[]; skipped: SkippedFile[] } {
  const applied = withImmediateTransaction(db, () => applyOwnedChange(db, ownerId, ids, (id) => {
    const result = db.prepare(
      "UPDATE files SET deleted_at = ? WHERE id = ? AND owner_id = ? AND state = 'ready' AND deleted_at IS NULL",
    ).run(new Date().toISOString(), id, ownerId);
    return result.changes === 1;
  }));
  return { deleted: applied.moved, skipped: applied.skipped };
}

function applyOwnedChange(
  db: DatabaseSync,
  ownerId: string,
  ids: string[],
  change: (id: string) => boolean,
): { moved: string[]; skipped: SkippedFile[] } {
  const moved: string[] = [];
  const skipped: SkippedFile[] = [];
  for (const id of ids) {
    if (change(id)) {
      moved.push(id);
      continue;
    }
    const existing = db.prepare(
      "SELECT owner_id FROM files WHERE id = ? AND state = 'ready' AND deleted_at IS NULL",
    ).get(id) as { owner_id: string } | undefined;
    skipped.push({ id, reason: existing && existing.owner_id !== ownerId ? 'forbidden' : 'missing' });
  }
  return { moved, skipped };
}

export function deleteOwnedFile(db: DatabaseSync, id: string, ownerId: string): 'deleted' | 'missing' | 'forbidden' {
  const result = db.prepare(
    "UPDATE files SET deleted_at = ? WHERE id = ? AND owner_id = ? AND state = 'ready' AND deleted_at IS NULL",
  ).run(new Date().toISOString(), id, ownerId);
  if (result.changes === 1) return 'deleted';
  const existing = db.prepare(
    "SELECT owner_id FROM files WHERE id = ? AND state = 'ready' AND deleted_at IS NULL",
  ).get(id) as { owner_id: string } | undefined;
  return existing ? 'forbidden' : 'missing';
}

export type BinFile = FileRecord & { deletedAt: string };

export function listBin(db: DatabaseSync, userId: string): BinFile[] {
  const rows = db.prepare(`
    SELECT f.id, f.original_name, f.size_bytes, f.created_at, f.owner_id, f.folder_id, f.deleted_at, u.username, d.name AS folder_name
    FROM files f
    JOIN users u ON u.id = f.owner_id
    LEFT JOIN folders d ON d.id = f.folder_id
    WHERE f.state = 'ready' AND f.deleted_at IS NOT NULL AND f.owner_id = ?
    ORDER BY f.deleted_at DESC, f.id ASC
  `).all(userId) as Array<FileRow & { deleted_at: string }>;
  const files = rows.map((row) => ({ ...mapFile(row, userId), deletedAt: row.deleted_at }));
  attachCatalog(db, files, userId);
  return files;
}

export function restoreOwnedFile(db: DatabaseSync, id: string, ownerId: string): 'restored' | 'missing' | 'forbidden' {
  const result = db.prepare(
    "UPDATE files SET deleted_at = NULL WHERE id = ? AND owner_id = ? AND state = 'ready' AND deleted_at IS NOT NULL",
  ).run(id, ownerId);
  if (result.changes === 1) return 'restored';
  const existing = db.prepare(
    "SELECT owner_id FROM files WHERE id = ? AND state = 'ready' AND deleted_at IS NOT NULL",
  ).get(id) as { owner_id: string } | undefined;
  return existing ? 'forbidden' : 'missing';
}

export function purgeOwnedBinFile(db: DatabaseSync, id: string, ownerId: string): 'purged' | 'missing' | 'forbidden' {
  const result = db.prepare(
    "DELETE FROM files WHERE id = ? AND owner_id = ? AND state = 'ready' AND deleted_at IS NOT NULL",
  ).run(id, ownerId);
  if (result.changes === 1) return 'purged';
  const existing = db.prepare(
    "SELECT owner_id FROM files WHERE id = ? AND state = 'ready' AND deleted_at IS NOT NULL",
  ).get(id) as { owner_id: string } | undefined;
  return existing ? 'forbidden' : 'missing';
}

export function takeExpiredBinIds(db: DatabaseSync, nowMs = Date.now()): string[] {
  const cutoff = new Date(nowMs - BIN_RETENTION_MS).toISOString();
  return withImmediateTransaction(db, () => {
    const rows = db.prepare(
      "SELECT id FROM files WHERE state = 'ready' AND deleted_at IS NOT NULL AND deleted_at <= ?",
    ).all(cutoff) as Array<{ id: string }>;
    const remove = db.prepare('DELETE FROM files WHERE id = ? AND deleted_at IS NOT NULL');
    const ids: string[] = [];
    for (const row of rows) {
      if (remove.run(row.id).changes === 1) ids.push(row.id);
    }
    return ids;
  });
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
    favorite: false,
    tags: [],
    preview: previewKind(row.original_name, sqlNumber(row.size_bytes)),
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
