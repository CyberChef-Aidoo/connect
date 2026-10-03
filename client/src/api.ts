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
  openAccess?: boolean;
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
  favorite?: boolean;
  tags?: TagItem[];
  preview?: 'image' | 'text' | 'none';
  versionCount?: number;
};

export type DirectSignal = {
  transferId: string;
  fromUserId: string;
  toUserId: string;
  fileId: string;
  kind: 'request' | 'offer' | 'answer' | 'ice' | 'reject';
  payload: string;
};

export type FileVersion = {
  id: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
};

export type TagItem = { id: string; name: string };

export type CollectionItem = {
  id: string;
  name: string;
  canRename: boolean;
  canDelete: boolean;
};

export type FileFilters = {
  favorite?: boolean;
  tagId?: string;
  collectionId?: string;
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

export async function heartbeat(csrfToken: string): Promise<void> {
  const response = await fetch('/api/peers/heartbeat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export async function listPeers(): Promise<{ online: string[] }> {
  const response = await fetch('/api/peers', { credentials: 'same-origin' });
  return readJson(response);
}

export async function takeSignals(): Promise<{ signals: DirectSignal[] }> {
  const response = await fetch('/api/signals', { credentials: 'same-origin' });
  return readJson(response);
}

export async function postSignal(body: {
  fileId: string;
  toUserId: string;
  kind: DirectSignal['kind'];
  transferId?: string;
  payload: string;
}, csrfToken: string): Promise<{ transferId: string }> {
  const response = await fetch('/api/signals', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body),
  });
  return readJson(response);
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
  filters: FileFilters = {},
): Promise<FileList> {
  const params = new URLSearchParams({ q: query, sort, order, limit: String(limit) });
  if (folderId) params.set('folderId', folderId);
  if (cursor) params.set('cursor', cursor);
  if (filters.favorite) params.set('favorite', '1');
  if (filters.tagId) params.set('tagId', filters.tagId);
  if (filters.collectionId) params.set('collectionId', filters.collectionId);
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

export async function ensureFolder(
  path: string,
  parentId: string | null,
  csrfToken: string,
): Promise<{ folderId: string | null }> {
  const response = await fetch('/api/folders/ensure', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ path, parentId }),
  });
  return readJson(response);
}

export async function moveFiles(
  ids: string[],
  folderId: string | null,
  csrfToken: string,
): Promise<{ moved: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const response = await fetch('/api/files/move', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ ids, folderId }),
  });
  return readJson(response);
}

export async function deleteFiles(
  ids: string[],
  csrfToken: string,
): Promise<{ deleted: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const response = await fetch('/api/files/delete-many', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ ids, }),
  });
  return readJson(response);
}

export function zipUrl(ids: string[]): string {
  return `/api/files/zip?ids=${ids.map((id) => encodeURIComponent(id)).join(',')}`;
}

export type BinFile = PortalFile & { deletedAt: string };

export async function listBin(): Promise<{ files: BinFile[]; retentionDays: number }> {
  const response = await fetch('/api/bin', { credentials: 'same-origin' });
  return readJson(response);
}

export async function restoreFile(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export async function purgeFile(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}/permanent`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export async function replaceFile(id: string, file: File, csrfToken: string): Promise<void> {
  const body = new FormData();
  body.set('file', file);
  const response = await fetch(`/api/files/${encodeURIComponent(id)}/replace`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
    body,
  });
  await readJson(response);
}

export async function listVersions(id: string): Promise<{ versions: FileVersion[] }> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}/versions`, { credentials: 'same-origin' });
  return readJson(response);
}

export async function deleteVersion(fileId: string, versionId: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}`, {
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

export async function listTags(): Promise<{ tags: TagItem[] }> {
  const response = await fetch('/api/tags', { credentials: 'same-origin' });
  return readJson(response);
}

export async function listCollections(): Promise<{ collections: CollectionItem[] }> {
  const response = await fetch('/api/collections', { credentials: 'same-origin' });
  return readJson(response);
}

export async function setFavorite(id: string, on: boolean, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}/favorite`, {
    method: on ? 'POST' : 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export async function tagFiles(ids: string[], name: string, csrfToken: string): Promise<void> {
  const response = await fetch('/api/files/tags', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ ids, name }),
  });
  await readJson(response);
}

export async function detachTag(fileId: string, tagId: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/tags/${encodeURIComponent(tagId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export async function createCollection(name: string, csrfToken: string): Promise<CollectionItem> {
  const response = await fetch('/api/collections', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ name }),
  });
  const body = await readJson<{ collection: CollectionItem }>(response);
  return body.collection;
}

export async function renameCollection(id: string, name: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/collections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ name }),
  });
  await readJson(response);
}

export async function deleteCollection(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/collections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export async function addToCollection(id: string, ids: string[], csrfToken: string): Promise<void> {
  const response = await fetch(`/api/collections/${encodeURIComponent(id)}/files`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ ids }),
  });
  await readJson(response);
}

export async function removeFromCollection(id: string, fileId: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/collections/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

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
