const ACK_BYTES = 256 * 1024;
const UNACKED_LIMIT = 1024 * 1024;
const ACK_WAIT_MS = 20_000;

export type DirectSendProgress = {
  sentBytes: number;
  confirmedBytes: number;
  totalBytes: number;
};

export function ackMessage(received: number): string {
  return JSON.stringify({ type: 'ack', received });
}

export function readAck(data: string): number | null {
  try {
    const parsed = JSON.parse(data) as { type?: string; received?: number };
    if (parsed.type === 'ack' && typeof parsed.received === 'number' && Number.isFinite(parsed.received) && parsed.received >= 0) {
      return parsed.received;
    }
  } catch {
    return null;
  }
  return null;
}

export async function sendDirectFile(
  channel: RTCDataChannel,
  file: File,
  chunkBytes: number,
  options: { onProgress?: (progress: DirectSendProgress) => void; signal?: AbortSignal } = {},
): Promise<void> {
  let confirmed = 0;
  channel.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    const received = readAck(event.data);
    if (received !== null && received >= confirmed) confirmed = received;
  };
  channel.send(JSON.stringify({ type: 'meta', size: file.size }));
  let offset = 0;
  while (offset < file.size) {
    throwIfStopped(channel, options.signal);
    if (offset - confirmed > UNACKED_LIMIT || channel.bufferedAmount > UNACKED_LIMIT) {
      await waitUntil(() => offset - confirmed <= UNACKED_LIMIT && channel.bufferedAmount <= UNACKED_LIMIT, options.signal);
    }
    const end = Math.min(offset + chunkBytes, file.size);
    channel.send(await file.slice(offset, end).arrayBuffer());
    offset = end;
    options.onProgress?.({ sentBytes: offset, confirmedBytes: confirmed, totalBytes: file.size });
  }
  const deadline = Date.now() + ACK_WAIT_MS;
  await waitUntil(() => confirmed >= file.size || Date.now() >= deadline, options.signal);
  if (confirmed < file.size) throw new Error('The direct connection closed.');
  options.onProgress?.({ sentBytes: offset, confirmedBytes: confirmed, totalBytes: file.size });
  channel.send(JSON.stringify({ type: 'done' }));
}

export function receiveDirectFile(
  channel: RTCDataChannel,
  options: { onProgress?: (received: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const parts: BlobPart[] = [];
    let expected = -1;
    let received = 0;
    let acked = 0;
    let settled = false;
    const finish = (error?: Error, blob?: Blob) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (blob) resolve(blob);
    };
    const onAbort = () => finish(new Error('Direct download was canceled.'));
    options.signal?.addEventListener('abort', onAbort);
    if (options.signal?.aborted) {
      finish(new Error('Direct download was canceled.'));
      return;
    }
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let message: { type?: string; size?: number };
        try {
          message = JSON.parse(event.data) as { type?: string; size?: number };
        } catch {
          return;
        }
        if (message.type === 'meta' && typeof message.size === 'number') expected = message.size;
        if (message.type === 'done') {
          if (expected >= 0 && received === expected) finish(undefined, new Blob(parts));
          else finish(new Error('The direct download stopped early.'));
        }
        return;
      }
      const chunk = event.data as ArrayBuffer;
      parts.push(chunk);
      received += chunk.byteLength;
      if (expected > 0) options.onProgress?.(received, expected);
      if (channel.readyState === 'open' && (received - acked >= ACK_BYTES || (expected >= 0 && received === expected))) {
        acked = received;
        channel.send(ackMessage(received));
      }
    };
    channel.onclose = () => {
      if (!settled) finish(new Error('The direct connection closed.'));
    };
  });
}

function throwIfStopped(channel: RTCDataChannel, signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Direct download was canceled.');
  if (channel.readyState !== 'open') throw new Error('The direct connection closed.');
}

function waitUntil(ready: () => boolean, signal?: AbortSignal): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setInterval(() => {
      if (signal?.aborted) {
        window.clearInterval(timer);
        reject(new Error('Direct download was canceled.'));
        return;
      }
      if (ready()) {
        window.clearInterval(timer);
        resolve();
      }
    }, 20);
  });
}
