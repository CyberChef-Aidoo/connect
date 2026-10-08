import { once } from 'node:events';
import type { Writable } from 'node:stream';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEEP_MS = 10 * 60 * 1000;

export type TransferKind = 'library' | 'library-zip' | 'relay' | 'relay-zip';
export type TransferErrorCode = 'closed' | 'stopped' | 'failed';

export type TransferView = {
  filename: string;
  kind: TransferKind;
  totalBytes: number | null;
  sentBytes: number;
  uploadBytes: number;
  sourceBytes: number;
  sourceTotal: number | null;
  savedBytes: null;
  done: boolean;
  error: TransferErrorCode | null;
};

type Row = TransferView & {
  sessionId: string;
  abort: (() => void) | null;
  updatedAt: number;
};

export function readProgressId(value: unknown): string | null {
  return typeof value === 'string' && ID_RE.test(value) ? value : null;
}

export function safeTransferName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 180);
  return cleaned || 'download';
}

export function createTransferTracker() {
  const rows = new Map<string, Row>();

  function sweep(now = Date.now()): void {
    for (const [id, row] of rows) {
      if (row.done && now - row.updatedAt > KEEP_MS) rows.delete(id);
    }
  }

  function open(input: {
    id: string;
    sessionId: string;
    filename: string;
    kind: TransferKind;
    totalBytes: number | null;
    sourceTotal: number | null;
    abort: () => void;
  }): boolean {
    if (!ID_RE.test(input.id) || rows.has(input.id)) return false;
    rows.set(input.id, {
      sessionId: input.sessionId,
      filename: safeTransferName(input.filename),
      kind: input.kind,
      totalBytes: input.totalBytes,
      sentBytes: 0,
      uploadBytes: 0,
      sourceBytes: 0,
      sourceTotal: input.sourceTotal,
      savedBytes: null,
      done: false,
      error: null,
      abort: input.abort,
      updatedAt: Date.now(),
    });
    return true;
  }

  function add(id: string | null, field: 'sentBytes' | 'uploadBytes' | 'sourceBytes', bytes: number): void {
    if (!id || bytes <= 0) return;
    const row = rows.get(id);
    if (!row || row.done) return;
    row[field] += bytes;
    row.updatedAt = Date.now();
  }

  function finish(id: string | null): void {
    if (!id) return;
    const row = rows.get(id);
    if (!row || row.done) return;
    row.done = true;
    row.abort = null;
    row.updatedAt = Date.now();
  }

  function fail(id: string | null, error: TransferErrorCode): void {
    if (!id) return;
    const row = rows.get(id);
    if (!row || row.done) return;
    row.done = true;
    row.error = error;
    row.abort = null;
    row.updatedAt = Date.now();
  }

  function view(sessionId: string, id: string): TransferView | null {
    sweep();
    const row = rows.get(id);
    if (!row || row.sessionId !== sessionId) return null;
    return {
      filename: row.filename,
      kind: row.kind,
      totalBytes: row.totalBytes,
      sentBytes: row.sentBytes,
      uploadBytes: row.uploadBytes,
      sourceBytes: row.sourceBytes,
      sourceTotal: row.sourceTotal,
      savedBytes: null,
      done: row.done,
      error: row.error,
    };
  }

  function cancel(sessionId: string, id: string): boolean {
    const row = rows.get(id);
    if (!row || row.sessionId !== sessionId) return false;
    const abort = row.abort;
    fail(id, 'stopped');
    abort?.();
    return true;
  }

  return { open, add, finish, fail, view, cancel };
}

export type TransferTracker = ReturnType<typeof createTransferTracker>;

export async function writeChunks(
  output: Writable,
  source: AsyncIterable<Buffer | Uint8Array>,
  onBytes?: (bytes: number) => void,
): Promise<number> {
  let seen = 0;
  for await (const piece of source) {
    if (output.destroyed) {
      throw Object.assign(new Error('The download was closed.'), { code: 'ECONNRESET' });
    }
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    if (chunk.length === 0) continue;
    seen += chunk.length;
    onBytes?.(chunk.length);
    if (!output.write(chunk)) await once(output, 'drain');
  }
  return seen;
}
