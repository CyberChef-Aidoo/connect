import { randomId } from './randomId';
import type { TransferActivity } from './transfer';

export type DownloadWatch = {
  id: string;
  href: string;
  filename: string;
  kind: string;
  totalBytes: number | null;
  sentBytes: number;
  uploadBytes: number;
  sourceBytes: number;
  sourceTotal: number | null;
  status: TransferActivity;
  error: string | null;
};

type ServerProgress = {
  filename?: string;
  kind?: string;
  totalBytes?: number | null;
  sentBytes?: number;
  uploadBytes?: number;
  sourceBytes?: number;
  sourceTotal?: number | null;
  savedBytes?: null;
  done?: boolean;
  error?: string | null;
};

export function startBrowserDownload(options: {
  href: string;
  filename: string;
  csrf: string;
  onUpdate: (watch: DownloadWatch) => void;
}): { id: string; cancel: () => void } {
  const id = randomId();
  const url = new URL(options.href, window.location.origin);
  url.searchParams.set('progress', id);
  const watch: DownloadWatch = {
    id,
    href: options.href,
    filename: options.filename,
    kind: 'library',
    totalBytes: null,
    sentBytes: 0,
    uploadBytes: 0,
    sourceBytes: 0,
    sourceTotal: null,
    status: 'downloading',
    error: null,
  };
  options.onUpdate(watch);
  const link = document.createElement('a');
  link.href = `${url.pathname}${url.search}`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();

  let stop = false;
  let misses = 0;
  let timer = 0;
  const publish = (next: DownloadWatch) => {
    Object.assign(watch, next);
    options.onUpdate({ ...watch });
  };
  const tick = async () => {
    if (stop) return;
    try {
      const response = await fetch(`/api/transfers/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      if (response.status === 404) {
        misses += 1;
        if (misses < 8) {
          timer = window.setTimeout(() => void tick(), 250);
          return;
        }
        publish({ ...watch, status: 'lost', error: 'The connection was lost. Try again.' });
        return;
      }
      if (!response.ok) {
        publish({ ...watch, status: 'retry', error: 'The download did not finish. Try again.' });
        return;
      }
      misses = 0;
      const body = await response.json() as ServerProgress;
      const next = applyServerProgress(watch, body);
      publish(next);
      if (next.status === 'completed' || next.status === 'lost' || next.status === 'retry' || next.status === 'canceled') return;
    } catch {
      publish({ ...watch, status: 'lost', error: 'The connection was lost. Try again.' });
      return;
    }
    timer = window.setTimeout(() => void tick(), 250);
  };
  timer = window.setTimeout(() => void tick(), 250);
  return {
    id,
    cancel: () => {
      stop = true;
      window.clearTimeout(timer);
      void fetch(`/api/transfers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': options.csrf },
      }).catch(() => undefined);
      publish({ ...watch, status: 'canceled', error: null });
    },
  };
}

export function applyServerProgress(current: DownloadWatch, body: ServerProgress): DownloadWatch {
  const totalBytes = typeof body.totalBytes === 'number' ? body.totalBytes : body.totalBytes === null ? null : current.totalBytes;
  const sentBytes = typeof body.sentBytes === 'number' ? body.sentBytes : current.sentBytes;
  const uploadBytes = typeof body.uploadBytes === 'number' ? body.uploadBytes : current.uploadBytes;
  const sourceBytes = typeof body.sourceBytes === 'number' ? body.sourceBytes : current.sourceBytes;
  const sourceTotal = typeof body.sourceTotal === 'number' ? body.sourceTotal : body.sourceTotal === null ? null : current.sourceTotal;
  let status: TransferActivity = 'downloading';
  let error: string | null = null;
  if (body.error === 'stopped') status = 'canceled';
  else if (body.error === 'closed') {
    status = 'lost';
    error = 'The connection was lost. Try again.';
  } else if (body.error) {
    status = 'retry';
    error = 'The download did not finish. Try again.';
  } else if (body.done) status = 'completed';
  else if (totalBytes !== null && sentBytes >= totalBytes) status = 'finishing';
  else if ((body.kind === 'relay' || body.kind === 'relay-zip') && sentBytes === 0 && uploadBytes > 0) status = 'sending';
  return {
    ...current,
    filename: typeof body.filename === 'string' && body.filename ? body.filename : current.filename,
    kind: typeof body.kind === 'string' ? body.kind : current.kind,
    totalBytes,
    sentBytes,
    uploadBytes,
    sourceBytes,
    sourceTotal,
    status,
    error,
  };
}
