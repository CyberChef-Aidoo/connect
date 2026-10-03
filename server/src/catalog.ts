import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from './db.js';
import { sanitizeOriginalName } from './storage.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TagRecord = { id: string; name: string };
export type CollectionRecord = { id: string; name: string; canRename: boolean; canDelete: boolean };

export function sanitizeLabel(raw: string, maxLength: number): string | null {
  const cleaned = sanitizeOriginalName(raw)?.replace(/\s+/g, ' ') ?? null;
  if (!cleaned || cleaned.length > maxLength) return null;
  return cleaned;
}

export function listTags(db: DatabaseSync): TagRecord[] {
  return db.prepare('SELECT id, name FROM tags ORDER BY name COLLATE NOCASE ASC, id ASC').all() as TagRecord[];
}

export function listCollections(db: DatabaseSync, userId: string): CollectionRecord[] {
  const rows = db.prepare(`
    SELECT id, name, created_by FROM collections ORDER BY name COLLATE NOCASE ASC, id ASC
  `).all() as Array<{ id: string; name: string; created_by: string }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    canRename: row.created_by === userId,
    canDelete: row.created_by === userId,
  }));
}

export function setFavorite(db: DatabaseSync, userId: string, fileId: string, on: boolean): boolean {
  if (!readyFile(db, fileId)) return false;
  if (on) {
    db.prepare(`
      INSERT INTO favorites (user_id, file_id, created_at) VALUES (?, ?, ?)
      ON CONFLICT (user_id, file_id) DO NOTHING
    `).run(userId, fileId, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND file_id = ?').run(userId, fileId);
  }
  return true;
}

export function attachTag(
  db: DatabaseSync,
  userId: string,
  fileIds: string[],
  rawName: string,
): { ok: true; tag: TagRecord; attached: string[]; skipped: string[] } | { ok: false; reason: 'bad-name' } {
  const name = sanitizeLabel(rawName, 40);
  if (!name) return { ok: false, reason: 'bad-name' };
  return withImmediateTransaction(db, () => {
    let tag = db.prepare('SELECT id, name FROM tags WHERE name = ?').get(name) as TagRecord | undefined;
    if (!tag) {
      tag = { id: randomUUID(), name };
      db.prepare('INSERT INTO tags (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
        tag.id,
        tag.name,
        userId,
        new Date().toISOString(),
      );
    }
    const attached: string[] = [];
    const skipped: string[] = [];
    for (const fileId of fileIds) {
      if (!readyFile(db, fileId)) {
        skipped.push(fileId);
        continue;
      }
      db.prepare(`
        INSERT INTO file_tags (file_id, tag_id, created_by, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (file_id, tag_id) DO NOTHING
      `).run(fileId, tag.id, userId, new Date().toISOString());
      attached.push(fileId);
    }
    if (attached.length === 0 && skipped.length === fileIds.length) {
      db.prepare('DELETE FROM tags WHERE id = ? AND NOT EXISTS (SELECT 1 FROM file_tags WHERE tag_id = tags.id)').run(tag.id);
    }
    return { ok: true, tag, attached, skipped };
  });
}

export function detachTag(db: DatabaseSync, fileId: string, tagId: string): boolean {
  if (!UUID_RE.test(tagId) || !readyFile(db, fileId)) return false;
  const removed = db.prepare('DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?').run(fileId, tagId);
  if (removed.changes !== 1) return false;
  db.prepare('DELETE FROM tags WHERE id = ? AND NOT EXISTS (SELECT 1 FROM file_tags WHERE tag_id = tags.id)').run(tagId);
  return true;
}

export function createCollection(
  db: DatabaseSync,
  userId: string,
  rawName: string,
): { ok: true; collection: CollectionRecord } | { ok: false; reason: 'bad-name' | 'duplicate' } {
  const name = sanitizeLabel(rawName, 80);
  if (!name) return { ok: false, reason: 'bad-name' };
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO collections (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      name,
      userId,
      new Date().toISOString(),
    );
    return { ok: true, collection: { id, name, canRename: true, canDelete: true } };
  } catch (error) {
    if (isUnique(error)) return { ok: false, reason: 'duplicate' };
    throw error;
  }
}

export function renameCollection(
  db: DatabaseSync,
  id: string,
  userId: string,
  rawName: string,
): { ok: true; collection: CollectionRecord } | { ok: false; reason: 'missing' | 'forbidden' | 'bad-name' | 'duplicate' } {
  const name = sanitizeLabel(rawName, 80);
  if (!name) return { ok: false, reason: 'bad-name' };
  const owner = collectionOwner(db, id);
  if (!owner) return { ok: false, reason: 'missing' };
  if (owner !== userId) return { ok: false, reason: 'forbidden' };
  try {
    const result = db.prepare('UPDATE collections SET name = ? WHERE id = ? AND created_by = ?').run(name, id, userId);
    if (result.changes !== 1) return { ok: false, reason: 'missing' };
    return { ok: true, collection: { id, name, canRename: true, canDelete: true } };
  } catch (error) {
    if (isUnique(error)) return { ok: false, reason: 'duplicate' };
    throw error;
  }
}

export function deleteCollection(db: DatabaseSync, id: string, userId: string): 'deleted' | 'missing' | 'forbidden' {
  const owner = collectionOwner(db, id);
  if (!owner) return 'missing';
  if (owner !== userId) return 'forbidden';
  db.prepare('DELETE FROM collections WHERE id = ? AND created_by = ?').run(id, userId);
  return 'deleted';
}

export function addToCollection(
  db: DatabaseSync,
  collectionId: string,
  userId: string,
  fileIds: string[],
): { ok: true; added: string[]; skipped: string[] } | { ok: false; reason: 'missing' } {
  if (!collectionOwner(db, collectionId)) return { ok: false, reason: 'missing' };
  const added: string[] = [];
  const skipped: string[] = [];
  for (const fileId of fileIds) {
    if (!readyFile(db, fileId)) {
      skipped.push(fileId);
      continue;
    }
    db.prepare(`
      INSERT INTO collection_files (collection_id, file_id, added_by, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (collection_id, file_id) DO NOTHING
    `).run(collectionId, fileId, userId, new Date().toISOString());
    added.push(fileId);
  }
  return { ok: true, added, skipped };
}

export function removeFromCollection(db: DatabaseSync, collectionId: string, fileId: string): boolean {
  if (!collectionOwner(db, collectionId) || !readyFile(db, fileId)) return false;
  const removed = db.prepare('DELETE FROM collection_files WHERE collection_id = ? AND file_id = ?').run(collectionId, fileId);
  return removed.changes === 1;
}

export function removeUnusedTags(db: DatabaseSync): void {
  db.exec('DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM file_tags WHERE tag_id = tags.id)');
}

export function tagExists(db: DatabaseSync, id: string): boolean {
  if (!UUID_RE.test(id)) return false;
  return Boolean(db.prepare('SELECT id FROM tags WHERE id = ?').get(id));
}

export function collectionExists(db: DatabaseSync, id: string): boolean {
  if (!UUID_RE.test(id)) return false;
  return Boolean(collectionOwner(db, id));
}

export function attachCatalog<T extends { id: string; favorite: boolean; tags: TagRecord[] }>(
  db: DatabaseSync,
  files: T[],
  userId: string,
): void {
  if (files.length === 0) return;
  const marks = files.map(() => '?').join(', ');
  const ids = files.map((file) => file.id);
  const favorites = db.prepare(
    `SELECT file_id FROM favorites WHERE user_id = ? AND file_id IN (${marks})`,
  ).all(userId, ...ids) as Array<{ file_id: string }>;
  const favoriteIds = new Set(favorites.map((row) => row.file_id));
  const tags = db.prepare(`
    SELECT ft.file_id, t.id, t.name
    FROM file_tags ft
    JOIN tags t ON t.id = ft.tag_id
    WHERE ft.file_id IN (${marks})
    ORDER BY t.name COLLATE NOCASE ASC, t.id ASC
  `).all(...ids) as Array<{ file_id: string; id: string; name: string }>;
  for (const file of files) {
    file.favorite = favoriteIds.has(file.id);
    file.tags = tags.filter((tag) => tag.file_id === file.id).map((tag) => ({ id: tag.id, name: tag.name }));
  }
}

function readyFile(db: DatabaseSync, id: string): boolean {
  if (!UUID_RE.test(id)) return false;
  return Boolean(db.prepare("SELECT id FROM files WHERE id = ? AND state = 'ready' AND deleted_at IS NULL").get(id));
}

function collectionOwner(db: DatabaseSync, id: string): string | undefined {
  if (!UUID_RE.test(id)) return undefined;
  const row = db.prepare('SELECT created_by FROM collections WHERE id = ?').get(id) as { created_by: string } | undefined;
  return row?.created_by;
}

function isUnique(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  const message = error instanceof Error ? error.message : '';
  return code.includes('CONSTRAINT') || message.includes('UNIQUE');
}
