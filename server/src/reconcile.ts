import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { listReadyIds, listStaging, markReady, removeFileRecord } from './files.js';
import { fileSize, objectPath, tempPath } from './storage.js';

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
 * - Object files with no row are removed. Temp files are always removed at startup
 *   because an in-progress upload cannot continue after the process exits.
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
    report.removedIncomplete += 1;
  }

  for (const ready of listReadyIds(db)) {
    known.add(ready.id);
    const finalPath = objectPath(storageDir, ready.id);
    const size = finalPath ? await fileSize(finalPath) : null;
    if (size === null) {
      removeFileRecord(db, ready.id);
      report.removedMissing += 1;
      continue;
    }
    if (size !== ready.sizeBytes) {
      removeFileRecord(db, ready.id);
      if (finalPath) await rm(finalPath, { force: true });
      report.removedCorrupt += 1;
    }
  }

  const objectsDir = path.join(storageDir, 'objects');
  for (const name of await safeList(objectsDir)) {
    if (known.has(name)) continue;
    await rm(path.join(objectsDir, name), { force: true });
    report.removedOrphans += 1;
  }

  const tmpDir = path.join(storageDir, 'tmp');
  for (const name of await safeList(tmpDir)) {
    if (name === '.write-probe') continue;
    await rm(path.join(tmpDir, name), { force: true });
    report.removedTemp += 1;
  }

  return report;
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
