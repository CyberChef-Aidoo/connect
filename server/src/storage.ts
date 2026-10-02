import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ensureStorage(storageDir: string): Promise<void> {
  const objects = path.join(storageDir, 'objects');
  const tmp = path.join(storageDir, 'tmp');
  await mkdir(objects, { recursive: true });
  await mkdir(tmp, { recursive: true });
  const probe = path.join(tmp, '.write-probe');
  try {
    await writeFile(probe, 'ok', { flag: 'w' });
    await rm(probe, { force: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`The server cannot write to the storage folder: ${storageDir}`);
    }
    throw new Error(`The storage folder is not usable: ${storageDir}`);
  }
}

export function objectPath(storageDir: string, id: string): string | null {
  if (!UUID_RE.test(id)) return null;
  return containedPath(path.resolve(storageDir, 'objects'), id);
}

export function tempPath(storageDir: string, id: string): string | null {
  if (!UUID_RE.test(id)) return null;
  return containedPath(path.resolve(storageDir, 'tmp'), `${id}.partial`);
}

export async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function fileSize(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : null;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

export function sanitizeOriginalName(raw: string): string | null {
  if (typeof raw !== 'string' || raw.includes('\0')) return null;
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  if (cleaned.length > 255) return null;
  return cleaned;
}

export function attachmentDisposition(originalName: string): string {
  const cleaned = sanitizeOriginalName(originalName) ?? 'download';
  const encoded = encodeURIComponent(cleaned).replace(/['()*]/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
  });
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const fallback = ascii.length > 0 ? ascii : 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function mapFsError(error: unknown): { httpStatus: number; message: string } {
  const code = errorCode(error);
  if (code === 'ENOSPC') {
    return {
      httpStatus: 507,
      message: 'The disk is full. Free some space on the server and try again.',
    };
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    return {
      httpStatus: 500,
      message: 'The server could not use its storage folder. Check the folder permissions and whether another program has the file open.',
    };
  }
  return { httpStatus: 500, message: 'The upload could not be saved.' };
}

function containedPath(root: string, name: string): string | null {
  if (name !== path.basename(name)) return null;
  if (name.includes('\0')) return null;
  const full = path.resolve(root, name);
  const relative = path.relative(root, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return full;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return '';
}
