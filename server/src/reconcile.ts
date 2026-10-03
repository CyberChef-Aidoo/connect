import { readdir, rename, rm, truncate } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { listReadyIds, listStaging, listVersionsForRecovery, markReady, removeFileRecord } from './files.js';
import {
  deleteSession,
  listRecoverySessions,
  setReceivedBytes,
  takeForPublish,
} from './resume.js';
import { fileSize, objectPath, tempPath, thumbPath } from './storage.js';

export type RecoveryReport = {
  publishedInterrupted: number;
  removedIncomplete: number;
  removedMissing: number;
  removedCorrupt: number;
  removedOrphans: number;
  removedTemp: number;
};

/**
 * Recovery after a crash between the disk and the database:
 * - A file is listed only when its row is "ready" and the bytes are in the objects folder.
 * - "staging" means the upload was validated and reserved, but publishing did not finish.
 * - If the finished object is already on disk with the expected size, publishing is completed.
 * - Otherwise the reservation and any partial or final bytes are removed.
 * - Ready rows whose files are missing or the wrong size are removed.
 * - An unfinished upload session is kept until it expires. Its temp file is truncated
 *   back to the last saved checkpoint, or the checkpoint is lowered if the file is shorter.
 * - A session whose saved bytes already match the full size is published.
 * - Expired sessions and temp files with no session are removed.
 */
export async function reconcileStorage(db: DatabaseSync, storageDir: string): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    publishedInterrupted: 0,
    removedIncomplete: 0,
    removedMissing: 0,
    removedCorrupt: 0,
    removedOrphans: 0,
    removedTemp: 0,
  };

  const known = new Set<string>();
  const keptTemps = new Set<string>();
  await repairUploadSessions(db, storageDir, known, keptTemps, report);

  for (const staging of listStaging(db)) {
    known.add(staging.id);
    const finalPath = objectPath(storageDir, staging.id);
    const partial = tempPath(storageDir, staging.id);
    const size = finalPath ? await fileSize(finalPath) : null;
    if (finalPath && size === staging.sizeBytes) {
      markReady(db, staging.id);
      report.publishedInterrupted += 1;
      continue;
    }
    removeFileRecord(db, staging.id);
    if (finalPath) await rm(finalPath, { force: true });
    if (partial) await rm(partial, { force: true });
    await discardThumb(storageDir, staging.id);
    report.removedIncomplete += 1;
  }

  for (const ready of listReadyIds(db)) {
    known.add(ready.id);
    const finalPath = objectPath(storageDir, ready.id);
    const size = finalPath ? await fileSize(finalPath) : null;
    if (size === null) {
      removeFileRecord(db, ready.id);
      await discardThumb(storageDir, ready.id);
      report.removedMissing += 1;
      continue;
    }
    if (size !== ready.sizeBytes) {
      removeFileRecord(db, ready.id);
      if (finalPath) await rm(finalPath, { force: true });
      await discardThumb(storageDir, ready.id);
      report.removedCorrupt += 1;
    }
  }

  for (const version of listVersionsForRecovery(db)) {
    const versionPath = objectPath(storageDir, version.id);
    const size = versionPath ? await fileSize(versionPath) : null;
    if (versionPath && size === version.sizeBytes) {
      known.add(version.id);
      continue;
    }
    db.prepare('DELETE FROM file_versions WHERE id = ?').run(version.id);
    if (versionPath && size !== null) await rm(versionPath, { force: true });
    report.removedCorrupt += 1;
  }

  const objectsDir = path.join(storageDir, 'objects');
  for (const name of await safeList(objectsDir)) {
    if (known.has(name)) continue;
    await rm(path.join(objectsDir, name), { force: true });
    report.removedOrphans += 1;
  }

  const thumbsDir = path.join(storageDir, 'thumbs');
  for (const name of await safeList(thumbsDir)) {
    const id = name.endsWith('.jpg') ? name.slice(0, -4) : '';
    if (known.has(id)) continue;
    await rm(path.join(thumbsDir, name), { force: true });
    report.removedOrphans += 1;
  }

  const tmpDir = path.join(storageDir, 'tmp');
  for (const name of await safeList(tmpDir)) {
    if (name === '.write-probe' || keptTemps.has(name)) continue;
    await rm(path.join(tmpDir, name), { force: true });
    report.removedTemp += 1;
  }

  return report;
}

async function repairUploadSessions(
  db: DatabaseSync,
  storageDir: string,
  known: Set<string>,
  keptTemps: Set<string>,
  report: RecoveryReport,
): Promise<void> {
  for (const session of listRecoverySessions(db)) {
    const partial = tempPath(storageDir, session.id);
    const expired = Date.parse(session.expiresAt) <= Date.now();
    if (expired) {
      deleteSession(db, session.id);
      if (partial) await rm(partial, { force: true });
      report.removedTemp += 1;
      continue;
    }
    const onDisk = partial ? await fileSize(partial) : null;
    if (!partial || onDisk === null) {
      deleteSession(db, session.id);
      report.removedIncomplete += 1;
      continue;
    }
    let size = onDisk;
    let received = session.receivedBytes;
    if (size > received) {
      await truncate(partial, received);
      size = received;
    } else if (size < received) {
      setReceivedBytes(db, session.id, size);
      received = size;
    }
    if (received === session.sizeBytes && size === session.sizeBytes) {
      const published = takeForPublish(db, session.id, session.ownerId, 0, { enforceQuota: false });
      const finalPath = objectPath(storageDir, session.id);
      if (published.ok && finalPath) {
        try {
          await rename(partial, finalPath);
          if (markReady(db, session.id)) {
            known.add(session.id);
            report.publishedInterrupted += 1;
            continue;
          }
        } catch {
          // The staging row remains. The loop below removes it if the object is missing.
        }
      }
    }
    keptTemps.add(`${session.id}.partial`);
  }
}

async function discardThumb(storageDir: string, id: string): Promise<void> {
  const thumb = thumbPath(storageDir, id);
  if (thumb) await rm(thumb, { force: true });
}

async function safeList(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'ENOENT') return [];
    throw error;
  }
}
