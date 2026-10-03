import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(databasePath: string): DatabaseSync {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      original_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      created_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('staging', 'ready'))
    );

    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      original_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      received_bytes INTEGER NOT NULL CHECK (received_bytes >= 0 AND received_bytes <= size_bytes),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions (expired);
    CREATE INDEX IF NOT EXISTS idx_files_state_created ON files (state, created_at);
    CREATE INDEX IF NOT EXISTS idx_files_owner ON files (owner_id);
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_owner ON upload_sessions (owner_id, expires_at);
  `);
  migrateFolders(db);
  migrateCatalog(db);
  migrateBin(db);
  migrateVersions(db);
  return db;
}

function migrateFolders(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES folders(id),
      name TEXT NOT NULL COLLATE NOCASE,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'files', 'folder_id', 'ALTER TABLE files ADD COLUMN folder_id TEXT REFERENCES folders(id)');
  ensureColumn(
    db,
    'upload_sessions',
    'folder_id',
    'ALTER TABLE upload_sessions ADD COLUMN folder_id TEXT REFERENCES folders(id)',
  );
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_root_name ON folders(name) WHERE parent_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_child_name ON folders(parent_id, name) WHERE parent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, name);
    CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id, state, created_at);
  `);
}

function migrateCatalog(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_tags (
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (file_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, file_id)
    );

    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_files (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      added_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (collection_id, file_id)
    );

    CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_collection_files_file ON collection_files(file_id);
  `);
}

function migrateVersions(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_versions (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id, created_at);
  `);
}

function migrateBin(db: DatabaseSync): void {
  ensureColumn(db, 'files', 'deleted_at', 'ALTER TABLE files ADD COLUMN deleted_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(owner_id, deleted_at)');
}

function ensureColumn(db: DatabaseSync, table: string, column: string, statement: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) db.exec(statement);
}

export function withImmediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be closed.
    }
    throw error;
  }
}

export function sqlNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
