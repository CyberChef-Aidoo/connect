import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from './db.js';
import { sanitizeOriginalName } from './storage.js';

export const MAX_FOLDER_DEPTH = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FolderRecord = {
  id: string;
  name: string;
  canRename: boolean;
  canDelete: boolean;
};

export type Breadcrumb = { id: string; name: string };

export function sanitizeFolderName(raw: string): string | null {
  return sanitizeOriginalName(raw);
}

export function splitFolderPath(raw: string): string[] | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) return null;
  const parts = raw.split(/[/\\]/).map((part) => part.trim()).filter((part) => part && part !== '.' && part !== '..');
  if (parts.length === 0 || parts.length > MAX_FOLDER_DEPTH) return null;
  const names: string[] = [];
  for (const part of parts) {
    const name = sanitizeFolderName(part);
    if (!name) return null;
    names.push(name);
  }
  return names;
}

export function ensureFolderPath(
  db: DatabaseSync,
  parentId: string | null,
  segments: string[],
  userId: string,
): { ok: true; folderId: string | null; created: string[] } | { ok: false; reason: 'missing' | 'duplicate' | 'deep' | 'bad-name' } {
  if (parentId && !resolveFolder(db, parentId).ok) return { ok: false, reason: 'missing' };
  let current = parentId;
  const created: string[] = [];
  for (const segment of segments) {
    const existing = findChild(db, current, segment);
    if (existing) {
      current = existing;
      continue;
    }
    const made = createFolder(db, { parentId: current, name: segment, createdBy: userId });
    if (!made.ok && made.reason === 'duplicate') {
      const again = findChild(db, current, segment);
      if (!again) return { ok: false, reason: 'duplicate' };
      current = again;
      continue;
    }
    if (!made.ok) return made;
    created.push(made.folder.name);
    current = made.folder.id;
  }
  return { ok: true, folderId: current, created };
}

function findChild(db: DatabaseSync, parentId: string | null, name: string): string | undefined {
  const row = (parentId
    ? db.prepare('SELECT id FROM folders WHERE parent_id = ? AND name = ?').get(parentId, name)
    : db.prepare('SELECT id FROM folders WHERE parent_id IS NULL AND name = ?').get(name)) as { id: string } | undefined;
  return row?.id;
}

export function resolveFolder(
  db: DatabaseSync,
  folderId: string | null,
): { ok: true; folderId: string | null } | { ok: false } {
  if (!folderId) return { ok: true, folderId: null };
  if (!UUID_RE.test(folderId)) return { ok: false };
  const row = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId) as { id: string } | undefined;
  return row ? { ok: true, folderId: row.id } : { ok: false };
}

export function createFolder(
  db: DatabaseSync,
  input: { parentId: string | null; name: string; createdBy: string },
): { ok: true; folder: FolderRecord } | { ok: false; reason: 'missing' | 'duplicate' | 'deep' | 'bad-name' } {
  const name = sanitizeFolderName(input.name);
  if (!name) return { ok: false, reason: 'bad-name' };
  try {
    return withImmediateTransaction(db, () => {
      if (input.parentId) {
        const depth = folderDepth(db, input.parentId);
        if (depth === null) return { ok: false, reason: 'missing' };
        if (depth >= MAX_FOLDER_DEPTH) return { ok: false, reason: 'deep' };
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO folders (id, parent_id, name, created_by, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, input.parentId, name, input.createdBy, createdAt);
      return { ok: true, folder: { id, name, canRename: true, canDelete: true } };
    });
  } catch (error) {
    if (isUniqueConstraint(error)) return { ok: false, reason: 'duplicate' };
    throw error;
  }
}

export function renameFolder(
  db: DatabaseSync,
  id: string,
  userId: string,
  rawName: string,
): { ok: true; folder: FolderRecord } | { ok: false; reason: 'missing' | 'forbidden' | 'duplicate' | 'bad-name' } {
  const name = sanitizeFolderName(rawName);
  if (!name) return { ok: false, reason: 'bad-name' };
  const existing = ownerOf(db, id);
  if (!existing) return { ok: false, reason: 'missing' };
  if (existing.created_by !== userId) return { ok: false, reason: 'forbidden' };
  try {
    const result = db.prepare('UPDATE folders SET name = ? WHERE id = ? AND created_by = ?').run(name, id, userId);
    if (result.changes !== 1) return { ok: false, reason: 'missing' };
    return { ok: true, folder: { id, name, canRename: true, canDelete: true } };
  } catch (error) {
    if (isUniqueConstraint(error)) return { ok: false, reason: 'duplicate' };
    throw error;
  }
}

export function deleteFolder(
  db: DatabaseSync,
  id: string,
  userId: string,
): { ok: true } | { ok: false; reason: 'missing' | 'forbidden' | 'not-empty' } {
  return withImmediateTransaction(db, () => {
    const existing = ownerOf(db, id);
    if (!existing) return { ok: false, reason: 'missing' };
    if (existing.created_by !== userId) return { ok: false, reason: 'forbidden' };
    const children = db.prepare('SELECT COUNT(*) AS n FROM folders WHERE parent_id = ?').get(id) as { n: unknown };
    const files = db.prepare('SELECT COUNT(*) AS n FROM files WHERE folder_id = ?').get(id) as { n: unknown };
    const uploads = db.prepare('SELECT COUNT(*) AS n FROM upload_sessions WHERE folder_id = ?').get(id) as { n: unknown };
    if (count(children.n) + count(files.n) + count(uploads.n) > 0) return { ok: false, reason: 'not-empty' };
    const result = db.prepare('DELETE FROM folders WHERE id = ? AND created_by = ?').run(id, userId);
    return result.changes === 1 ? { ok: true } : { ok: false, reason: 'missing' };
  });
}

export function listChildFolders(db: DatabaseSync, parentId: string | null, userId: string): FolderRecord[] {
  const rows = (parentId
    ? db.prepare(`
      SELECT id, name, created_by FROM folders WHERE parent_id = ? ORDER BY name COLLATE NOCASE ASC, id ASC LIMIT 200
    `).all(parentId)
    : db.prepare(`
      SELECT id, name, created_by FROM folders WHERE parent_id IS NULL ORDER BY name COLLATE NOCASE ASC, id ASC LIMIT 200
    `).all()) as Array<{ id: string; name: string; created_by: string }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    canRename: row.created_by === userId,
    canDelete: row.created_by === userId,
  }));
}

export function breadcrumbs(db: DatabaseSync, folderId: string): Breadcrumb[] | null {
  const chain: Breadcrumb[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;
  while (current) {
    if (seen.has(current) || chain.length > MAX_FOLDER_DEPTH + 2) return null;
    seen.add(current);
    const row = db.prepare('SELECT id, parent_id, name FROM folders WHERE id = ?').get(current) as {
      id: string;
      parent_id: string | null;
      name: string;
    } | undefined;
    if (!row) return null;
    chain.push({ id: row.id, name: row.name });
    current = row.parent_id;
  }
  return chain.reverse();
}

function ownerOf(db: DatabaseSync, id: string): { created_by: string } | undefined {
  return db.prepare('SELECT created_by FROM folders WHERE id = ?').get(id) as { created_by: string } | undefined;
}

function folderDepth(db: DatabaseSync, id: string): number | null {
  let depth = 0;
  let current: string | null = id;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current) || depth > MAX_FOLDER_DEPTH + 2) return null;
    seen.add(current);
    const row = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(current) as {
      parent_id: string | null;
    } | undefined;
    if (!row) return null;
    depth += 1;
    current = row.parent_id;
  }
  return depth;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isUniqueConstraint(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  const message = error instanceof Error ? error.message : '';
  return code.includes('CONSTRAINT') || message.includes('UNIQUE');
}
