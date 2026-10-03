export type User = { id: string; username: string };

export type Limits = {
  maxFileBytes: number;
  maxStorageBytes: number;
};

export type UploadCaps = {
  maxPerUser: number;
  maxGlobal: number;
};

export type Session = {
  user: User;
  csrfToken: string;
  limits: Limits;
  uploads: UploadCaps;
};

export type PortalFile = {
  id: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
  ownerId: string;
  ownerUsername: string;
  canDelete: boolean;
  folderId?: string | null;
  folderName?: string | null;
};

export type FolderItem = {
  id: string;
  name: string;
  canRename: boolean;
  canDelete: boolean;
};

export type Breadcrumb = { id: string; name: string };

export type FileList = {
  files: PortalFile[];
  folders?: FolderItem[];
  breadcrumbs?: Breadcrumb[];
  page?: { limit: number; nextCursor: string | null };
  storage: { usedBytes: number; limitBytes: number };
  limits: Limits;
};

export type UploadSession = {
  id: string;
  originalName: string;
  sizeBytes: number;
  receivedBytes: number;
  createdAt: string;
  expiresAt: string;
};

export type UploadStart = {
  sessionId?: string | null;
  receivedBytes?: number;
  folderId?: string | null;
  onSession?: (sessionId: string) => void;
};

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function getSession(): Promise<Session | null> {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (response.status === 401) return null;
  return normalizeSession(await readJson<Session>(response));
}

export async function login(username: string, password: string): Promise<Session> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return normalizeSession(await readJson<Session>(response));
}

export async function logout(csrfToken: string): Promise<void> {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export async function listFiles(
  query: string,
  sort: string,
  order: string,
  folderId: string | null = null,
  cursor: string | null = null,
  limit = 24,
): Promise<FileList> {
  const params = new URLSearchParams({ q: query, sort, order, limit: String(limit) });
  if (folderId) params.set('folderId', folderId);
  if (cursor) params.set('cursor', cursor);
  const response = await fetch(`/api/files?${params}`, { credentials: 'same-origin' });
  return readJson<FileList>(response);
}

export async function createFolder(name: string, parentId: string | null, csrfToken: string): Promise<FolderItem> {
  const response = await fetch('/api/folders', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ name, parentId }),
  });
  const body = await readJson<{ folder: FolderItem }>(response);
  return body.folder;
}

export async function renameFolder(id: string, name: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/folders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ name }),
  });
  await readJson(response);
}

export async function deleteFolder(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/folders/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export async function deleteFile(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export async function listUploads(): Promise<{ sessions: UploadSession[]; chunkBytes: number }> {
  const response = await fetch('/api/uploads', { credentials: 'same-origin' });
  return readJson(response);
}

export async function deleteUpload(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/uploads/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export async function uploadFile(
  file: File,
  csrfToken: string,
  onProgress: (loaded: number, total: number) => void,
  signal: AbortSignal,
  start: UploadStart = {},
): Promise<PortalFile> {
  let sessionId = start.sessionId ?? null;
  let offset = sessionId ? Math.max(0, start.receivedBytes ?? 0) : 0;
  let chunkBytes = DEFAULT_CHUNK_BYTES;

  if (!sessionId) {
    const created = await postJson<{ file?: PortalFile; session?: UploadSession; chunkBytes?: number }>(
      '/api/uploads',
      { originalName: file.name, sizeBytes: file.size, folderId: start.folderId ?? null },
      csrfToken,
      signal,
    );
    if (created.file) {
      onProgress(file.size, file.size);
      return created.file;
    }
    if (!created.session) throw new ApiError(500, 'The server did not confirm the upload.');
    sessionId = created.session.id;
    offset = created.session.receivedBytes;
    if (typeof created.chunkBytes === 'number' && created.chunkBytes > 0) chunkBytes = created.chunkBytes;
  }
  start.onSession?.(sessionId);

  let stuck = 0;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkBytes);
    const outcome = await sendChunk({
      sessionId,
      offset,
      blob: file.slice(offset, end),
      csrfToken,
      signal,
      onProgress: (loaded) => onProgress(Math.min(file.size, offset + loaded), file.size),
    });
    if (outcome.kind === 'file') {
      onProgress(file.size, file.size);
      return outcome.file;
    }
    if (outcome.receivedBytes === offset) {
      stuck += 1;
      if (stuck > 3) throw new ApiError(409, 'The upload could not continue from the saved position.');
    } else {
      stuck = 0;
    }
    offset = outcome.receivedBytes;
  }
  throw new ApiError(500, 'The server did not confirm the upload.');
}

function sendChunk(options: {
  sessionId: string;
  offset: number;
  blob: Blob;
  csrfToken: string;
  signal: AbortSignal;
  onProgress: (loaded: number) => void;
}): Promise<{ kind: 'file'; file: PortalFile } | { kind: 'continue'; receivedBytes: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new ApiError(0, 'Upload canceled.'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PATCH', `/api/uploads/${encodeURIComponent(options.sessionId)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-CSRF-Token', options.csrfToken);
    xhr.setRequestHeader('Upload-Offset', String(options.offset));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress(event.loaded);
    };
    xhr.onload = () => {
      const message = messageFrom(xhr.status, xhr.responseText);
      let body: { file?: PortalFile; session?: UploadSession; receivedBytes?: number; error?: string } = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) as typeof body : {};
      } catch {
        reject(new ApiError(xhr.status, 'The server sent an unexpected response.'));
        return;
      }
      if (xhr.status === 201 && body.file) {
        resolve({ kind: 'file', file: body.file });
        return;
      }
      if (xhr.status === 200 && typeof body.session?.receivedBytes === 'number') {
        resolve({ kind: 'continue', receivedBytes: body.session.receivedBytes });
        return;
      }
      if (xhr.status === 409 && typeof body.receivedBytes === 'number') {
        resolve({ kind: 'continue', receivedBytes: body.receivedBytes });
        return;
      }
      reject(new ApiError(xhr.status, message));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Cannot reach the server. Check that it is running and try again.'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload canceled.'));
    options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(options.blob);
  });
}

async function postJson<T>(url: string, body: unknown, csrfToken: string, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ApiError(0, 'Upload canceled.');
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify(body),
      signal,
    });
    return await readJson<T>(response);
  } catch (error) {
    if (signal.aborted) throw new ApiError(0, 'Upload canceled.');
    throw error;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, messageFrom(response.status, text));
  }
  return text ? JSON.parse(text) as T : ({} as T);
}

function normalizeSession(session: Session): Session {
  const perUser = session.uploads?.maxPerUser;
  const globalCap = session.uploads?.maxGlobal;
  return {
    ...session,
    uploads: {
      maxPerUser: typeof perUser === 'number' && perUser > 0 ? perUser : 3,
      maxGlobal: typeof globalCap === 'number' && globalCap > 0 ? globalCap : 8,
    },
  };
}

function messageFrom(status: number, text: string): string {
  try {
    const data = JSON.parse(text) as { error?: unknown };
    if (typeof data.error === 'string' && data.error.trim()) return data.error;
  } catch {
    // The body was not JSON.
  }
  if (status === 0) return 'Cannot reach the server. Check that it is running and try again.';
  return 'The server rejected the request.';
}
