export type User = { id: string; username: string };

export type Limits = {
  maxFileBytes: number;
  maxStorageBytes: number;
};

export type Session = {
  user: User;
  csrfToken: string;
  limits: Limits;
};

export type PortalFile = {
  id: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
  ownerId: string;
  ownerUsername: string;
  canDelete: boolean;
};

export type FileList = {
  files: PortalFile[];
  storage: { usedBytes: number; limitBytes: number };
  limits: Limits;
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
  return readJson<Session>(response);
}

export async function login(username: string, password: string): Promise<Session> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return readJson<Session>(response);
}

export async function logout(csrfToken: string): Promise<void> {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export async function listFiles(query: string, sort: string, order: string): Promise<FileList> {
  const params = new URLSearchParams({ q: query, sort, order });
  const response = await fetch(`/api/files?${params}`, { credentials: 'same-origin' });
  return readJson<FileList>(response);
}

export async function deleteFile(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  await readJson(response);
}

export function uploadFile(
  file: File,
  csrfToken: string,
  onProgress: (loaded: number, total: number) => void,
  signal: AbortSignal,
): Promise<PortalFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      const message = messageFrom(xhr.status, xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { file?: PortalFile };
          if (!body.file) {
            reject(new ApiError(xhr.status, 'The server did not confirm the upload.'));
            return;
          }
          resolve(body.file);
        } catch {
          reject(new ApiError(xhr.status, 'The server sent an unexpected response.'));
        }
        return;
      }
      reject(new ApiError(xhr.status, message));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Cannot reach the server. Check that it is running and try again.'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload canceled.'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    const body = new FormData();
    body.append('file', file, file.name);
    xhr.send(body);
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, messageFrom(response.status, text));
  }
  return text ? JSON.parse(text) as T : ({} as T);
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
