import { formatBytes } from './format';

export const STALL_AFTER_MS = 4_000;
const SPEED_WINDOW_MS = 5_000;
const MIN_SAMPLE_SPAN_MS = 500;

export type TransferSample = {
  at: number;
  loaded: number;
};

export type TransferView = {
  progress: number;
  bytesPerSecond: number | null;
  remainingMs: number | null;
  stalled: boolean;
};

export function transferView(input: {
  loaded: number;
  total: number;
  now: number;
  samples: TransferSample[];
  active: boolean;
}): TransferView {
  const total = Number.isFinite(input.total) ? Math.max(0, input.total) : 0;
  const loaded = Number.isFinite(input.loaded) ? Math.max(0, input.loaded) : 0;
  const progress = total > 0 ? Math.min(100, Math.round((Math.min(loaded, total) / total) * 100)) : 0;
  if (!input.active) {
    return { progress, bytesPerSecond: null, remainingMs: null, stalled: false };
  }

  const last = input.samples.at(-1);
  const stalled = last !== undefined && input.now - last.at >= STALL_AFTER_MS && loaded < total;
  const recent = input.samples.filter((sample) => input.now - sample.at <= SPEED_WINDOW_MS);
  if (recent.length < 2) {
    return { progress, bytesPerSecond: null, remainingMs: null, stalled };
  }

  const first = recent[0];
  const end = recent[recent.length - 1];
  const elapsed = end.at - first.at;
  const delta = end.loaded - first.loaded;
  if (elapsed < MIN_SAMPLE_SPAN_MS || delta <= 0) {
    return { progress, bytesPerSecond: null, remainingMs: null, stalled };
  }

  const bytesPerSecond = (delta / elapsed) * 1000;
  if (stalled) {
    return { progress, bytesPerSecond: null, remainingMs: null, stalled: true };
  }
  const remainingMs = total > loaded ? ((total - loaded) / bytesPerSecond) * 1000 : 0;
  return { progress, bytesPerSecond, remainingMs, stalled: false };
}

export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatRemaining(remainingMs: number | null, stalled: boolean): string {
  if (stalled) return 'Stalled';
  if (remainingMs === null || !Number.isFinite(remainingMs)) return '';
  if (remainingMs <= 0) return 'Finishing';
  const seconds = Math.ceil(remainingMs / 1000);
  if (seconds < 5) return 'A few seconds left';
  if (seconds < 90) return `About ${seconds} seconds left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `About ${minutes} min left`;
  return `About ${Math.round(minutes / 60)} hr left`;
}

export const PAINT_INTERVAL_MS = 250;

export type TransferActivity =
  | 'queued'
  | 'sending'
  | 'downloading'
  | 'finishing'
  | 'completed'
  | 'lost'
  | 'retry'
  | 'canceled';

export function shouldPaint(lastAt: number, now: number, force: boolean): boolean {
  return force || now - lastAt >= PAINT_INTERVAL_MS;
}

export function transferStatusLabel(status: TransferActivity): string {
  if (status === 'queued') return 'Waiting';
  if (status === 'sending') return 'Sending';
  if (status === 'downloading') return 'Downloading';
  if (status === 'finishing') return 'Finishing up';
  if (status === 'completed') return 'Completed';
  if (status === 'lost') return 'Connection lost';
  if (status === 'canceled') return 'Canceled';
  return 'Try again';
}

export function displayPercent(transferredBytes: number, totalBytes: number | null, complete: boolean): number | null {
  if (totalBytes === null || !Number.isFinite(totalBytes) || totalBytes <= 0) return complete ? 100 : null;
  if (complete) return 100;
  const raw = Math.min(100, Math.round((Math.min(Math.max(0, transferredBytes), totalBytes) / totalBytes) * 100));
  return raw >= 100 ? 99 : raw;
}

export function overallBytes(rows: Array<{ transferredBytes: number; totalBytes: number | null }>): {
  transferredBytes: number;
  totalBytes: number | null;
  percent: number | null;
} {
  let transferredBytes = 0;
  let totalBytes = 0;
  let known = true;
  for (const row of rows) {
    transferredBytes += Number.isFinite(row.transferredBytes) ? Math.max(0, row.transferredBytes) : 0;
    if (row.totalBytes === null || !Number.isFinite(row.totalBytes) || row.totalBytes < 0) known = false;
    else totalBytes += row.totalBytes;
  }
  if (!known || totalBytes <= 0) return { transferredBytes, totalBytes: known ? totalBytes : null, percent: null };
  return {
    transferredBytes,
    totalBytes,
    percent: Math.min(100, Math.round((Math.min(transferredBytes, totalBytes) / totalBytes) * 100)),
  };
}

export function explainTransferFailure(status: number, message: string): { status: 'lost' | 'retry'; message: string } {
  if (status === 0 || /failed to fetch|network|econnreset/i.test(message)) {
    return { status: 'lost', message: 'The connection was lost. Try again.' };
  }
  if (/password|csrf|cookie|authorization|secret/i.test(message)) {
    return { status: 'retry', message: 'The transfer did not finish. Try again.' };
  }
  const cleaned = message.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 180);
  return { status: 'retry', message: cleaned || 'The transfer did not finish. Try again.' };
}

export function directReadyToFinish(confirmedBytes: number, totalBytes: number): boolean {
  return totalBytes >= 0 && confirmedBytes === totalBytes;
}

export function rememberSample(samples: TransferSample[], sample: TransferSample): TransferSample[] {
  const last = samples.at(-1);
  if (last && last.at === sample.at && last.loaded === sample.loaded) return samples;
  const next = samples.length > 0 && samples[samples.length - 1].loaded > sample.loaded
    ? [sample]
    : [...samples, sample];
  return next.filter((item) => sample.at - item.at <= SPEED_WINDOW_MS).slice(-20);
}
