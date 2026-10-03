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

export function rememberSample(samples: TransferSample[], sample: TransferSample): TransferSample[] {
  const last = samples.at(-1);
  if (last && last.at === sample.at && last.loaded === sample.loaded) return samples;
  const next = samples.length > 0 && samples[samples.length - 1].loaded > sample.loaded
    ? [sample]
    : [...samples, sample];
  return next.filter((item) => sample.at - item.at <= SPEED_WINDOW_MS).slice(-20);
}
