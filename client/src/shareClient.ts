import { ApiError } from './api';

export type ShareFileDraft = {
  clientToken: string;
  relativePath: string;
  size: number;
  modifiedAt: number;
};

export type ShareSummary = {
  id: string;
  name: string;
  ownerPeerId: string;
  ownerName: string;
  mine: boolean;
  available: boolean;
  revoked: boolean;
  fileCount: number;
  sizeBytes: number;
};

export type ListedFile = ShareFileDraft & { id: string };

export type ShareFolder = { name: string; path: string; fileCount: number };

export type ShareListing = {
  share: ShareSummary;
  dir: string;
  breadcrumbs: Array<{ name: string; path: string }>;
  folders: ShareFolder[];
  files: ListedFile[];
  search: string;
};

export type SharePerson = { peerId: string; displayName: string };

export type OutboxJob = {
  id: string;
  kind: 'file' | 'zip';
  shareId: string;
  nextFileId: string | null;
  ready: boolean;
  files: Array<{ fileId: string; relativePath: string; size: number }>;
};

export function folderSelectionAvailable(): boolean {
  return typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input');
}

function apiUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return new URL(path, window.location.origin).href;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/html') || text.trimStart().startsWith('<!')) {
    throw new ApiError(response.status || 502, 'The server returned the website instead of an API response.');
  }
  let body = {} as T & { error?: string };
  if (text) {
    try {
      body = JSON.parse(text) as T & { error?: string };
    } catch {
      throw new ApiError(response.status || 502, 'The server returned the website instead of an API response.');
    }
  }
  if (!response.ok) throw new ApiError(response.status, body.error || 'The share request was refused.');
  return body;
}

export async function previewShare(files: ShareFileDraft[], csrf: string) {
  const response = await fetch(apiUrl('/api/shares/preview'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ files }),
  });
  return readJson<{ files: ShareFileDraft[]; rejected: Array<{ relativePath: string; reason: string }>; fileCount: number }>(response);
}

export async function publishShare(name: string, peerIds: string[], files: ShareFileDraft[], csrf: string) {
  const response = await fetch(apiUrl('/api/shares'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ name, peerIds, files }),
  });
  return readJson<{ share: ShareSummary; files: ListedFile[] }>(response);
}

export async function releaseShares(csrf: string): Promise<void> {
  const response = await fetch(apiUrl('/api/shares/release'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrf },
  });
  await readJson(response);
}

export async function revokeShare(id: string, csrf: string): Promise<string> {
  const response = await fetch(apiUrl(`/api/shares/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrf },
  });
  const body = await readJson<{ note?: string }>(response);
  return body.note ?? 'New downloads are refused.';
}

export async function listShares(): Promise<ShareSummary[]> {
  const response = await fetch(apiUrl('/api/shares'), { credentials: 'same-origin' });
  const body = await readJson<{ shares: ShareSummary[] }>(response);
  return body.shares;
}

export async function browseShare(id: string, dir: string, query: string): Promise<ShareListing> {
  const params = new URLSearchParams();
  if (dir) params.set('dir', dir);
  if (query) params.set('q', query);
  const response = await fetch(apiUrl(`/api/shares/${encodeURIComponent(id)}?${params}`), { credentials: 'same-origin' });
  return readJson(response);
}

export async function listSharePeers(): Promise<{ self: string; people: SharePerson[] }> {
  const params = new URLSearchParams();
  const name = typeof localStorage === 'undefined' ? '' : (localStorage.getItem('portal-share-name') || '');
  if (name) params.set('name', name);
  const response = await fetch(apiUrl(`/api/share-peers?${params}`), { credentials: 'same-origin' });
  return readJson(response);
}

export async function shareOutbox(): Promise<OutboxJob[]> {
  const response = await fetch(apiUrl('/api/shares/outbox'), { credentials: 'same-origin' });
  const body = await readJson<{ jobs: OutboxJob[] }>(response);
  return body.jobs;
}

export function relayFileUrl(shareId: string, fileId: string): string {
  return apiUrl(`/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(fileId)}`);
}

export function relayZipUrl(shareId: string, dir: string, ids: string[] = []): string {
  const params = new URLSearchParams();
  if (dir) params.set('dir', dir);
  if (ids.length > 0) params.set('ids', ids.join(','));
  return apiUrl(`/api/shares/${encodeURIComponent(shareId)}/archive?${params}`);
}

export async function confirmRelay(url: string): Promise<{ mode: string }> {
  const check = new URL(url, typeof window === 'undefined' ? 'http://127.0.0.1' : window.location.origin);
  check.searchParams.set('check', '1');
  const response = await fetch(check, { credentials: 'same-origin' });
  const body = await readJson<{ mode?: string }>(response);
  return { mode: body.mode ?? 'relay' };
}

export async function abortOutbox(jobId: string, csrf: string): Promise<void> {
  const response = await fetch(apiUrl(`/api/shares/outbox/${encodeURIComponent(jobId)}/abort`), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrf },
  });
  await readJson(response);
}

export type ShareSignal = {
  transferId: string;
  shareId: string;
  fileId: string;
  fromPeerId: string;
  toPeerId: string;
  kind: string;
  payload: string;
};

export async function postShareSignal(body: {
  shareId: string;
  fileId: string;
  toPeerId: string;
  kind: string;
  transferId?: string;
  payload: string;
}, csrf: string): Promise<{ transferId: string }> {
  const response = await fetch(apiUrl('/api/share-signals'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

export async function takeShareSignals(): Promise<ShareSignal[]> {
  const response = await fetch(apiUrl('/api/share-signals'), { credentials: 'same-origin' });
  const body = await readJson<{ signals: ShareSignal[] }>(response);
  return body.signals;
}

export async function sendSharedBytes(jobId: string, fileId: string, file: File, csrf: string): Promise<void> {
  const response = await fetch(apiUrl(`/api/shares/outbox/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileId)}`), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf },
    body: file,
  });
  await readJson(response);
}
