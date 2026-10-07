import { PassThrough } from 'node:stream';
import {
  childListing,
  filesUnder,
  prepareShareFiles,
  sanitizeDisplayName,
  sanitizeShareName,
  sanitizeSharePath,
  type PreparedFile,
} from './sharePaths.js';

const ONLINE_MS = 20_000;
const MAX_FILES = 400;
const MAX_JOBS = 4;
const JOB_MS = 60_000;

export type ShareRecord = {
  id: string;
  name: string;
  ownerPeerId: string;
  createdAt: number;
  revoked: boolean;
  held: boolean;
  lastSeen: number;
  files: PreparedFile[];
  allowed: Set<string>;
};

type Person = { peerId: string; displayName: string; seenAt: number };

type Job = {
  id: string;
  kind: 'file' | 'zip';
  shareId: string;
  ownerPeerId: string;
  requesterPeerId: string;
  files: PreparedFile[];
  cursor: number;
  cancelled: boolean;
  createdAt: number;
  waiter: ((stream: PassThrough) => void) | null;
  rejecter: ((error: Error) => void) | null;
};

export function createShareHub(maxFileBytes: number) {
  const people = new Map<string, Person>();
  const shares = new Map<string, ShareRecord>();
  const jobs = new Map<string, Job>();
  const transfers = new Map<string, ShareTransfer>();
  const signals = new Map<string, ShareSignal[]>();

  function beat(peerId: string, displayName: unknown, now = Date.now()): void {
    const previous = people.get(peerId);
    const name = typeof displayName === 'string'
      ? sanitizeDisplayName(displayName)
      : previous?.displayName ?? 'This browser';
    people.set(peerId, { peerId, displayName: name, seenAt: now });
    for (const share of shares.values()) {
      if (share.ownerPeerId === peerId && share.held && !share.revoked) share.lastSeen = now;
    }
    sweep(now);
  }

  function online(now = Date.now()): Person[] {
    const list: Person[] = [];
    for (const [id, person] of people) {
      if (now - person.seenAt > ONLINE_MS) people.delete(id);
      else list.push(person);
    }
    return list;
  }

  function isOnline(peerId: string, now = Date.now()): boolean {
    const person = people.get(peerId);
    return Boolean(person && now - person.seenAt <= ONLINE_MS);
  }

  function preview(inputs: unknown) {
    return prepareShareFiles(inputs, MAX_FILES, maxFileBytes);
  }

  function publish(input: {
    ownerPeerId: string;
    name: unknown;
    peerIds: unknown;
    files: unknown;
  }, now = Date.now()) {
    const name = sanitizeShareName(input.name);
    if (!name) return { ok: false, status: 400, error: 'Name this share.' };
    const prepared = prepareShareFiles(input.files, MAX_FILES, maxFileBytes);
    if (prepared.files.length === 0) {
      return { ok: false, status: 400, error: 'Choose at least one file with a safe path.' };
    }
    const allowed = new Set<string>();
    const requested = Array.isArray(input.peerIds) ? input.peerIds : [];
    for (const peerId of requested) {
      if (typeof peerId !== 'string' || peerId === input.ownerPeerId) continue;
      if (!isOnline(peerId, now)) return { ok: false, status: 400, error: 'Choose people who are here.' };
      allowed.add(peerId);
    }
    const share: ShareRecord = {
      id: crypto.randomUUID(),
      name,
      ownerPeerId: input.ownerPeerId,
      createdAt: now,
      revoked: false,
      held: true,
      lastSeen: now,
      files: prepared.files,
      allowed,
    };
    shares.set(share.id, share);
    return { ok: true, share: view(share, input.ownerPeerId, now), files: prepared.files };
  }

  function release(ownerPeerId: string): void {
    for (const share of shares.values()) {
      if (share.ownerPeerId === ownerPeerId) revoke(share.id, ownerPeerId);
    }
  }

  function revoke(shareId: string, ownerPeerId: string): boolean {
    const share = shares.get(shareId);
    if (!share || share.ownerPeerId !== ownerPeerId) return false;
    share.revoked = true;
    share.held = false;
    for (const job of jobs.values()) {
      if (job.shareId === shareId) cancelJob(job, 'This share was revoked.');
    }
    return true;
  }

  function list(peerId: string, now = Date.now()) {
    sweep(now);
    return [...shares.values()]
      .filter((share) => share.ownerPeerId === peerId || share.allowed.has(peerId))
      .map((share) => view(share, peerId, now));
  }

  function browse(shareId: string, peerId: string, dirInput: unknown, query: unknown, now = Date.now()) {
    const share = visible(shareId, peerId, now);
    if (!share) return null;
    const queryText = typeof query === 'string' ? query.trim().toLowerCase().slice(0, 80) : '';
    if (queryText) {
      const files = share.files.filter((file) => file.relativePath.toLowerCase().includes(queryText));
      return { share: view(share, peerId, now), dir: '', breadcrumbs: [], folders: [], files, search: queryText };
    }
    const dir = typeof dirInput === 'string' && dirInput ? sanitizeSharePath(dirInput) : '';
    if (dirInput && !dir) return { error: 'That folder path cannot be opened.' as const };
    const listing = childListing(share.files, dir ?? '');
    return {
      share: view(share, peerId, now),
      dir: dir ?? '',
      breadcrumbs: breadcrumbs(dir ?? ''),
      folders: listing.folders,
      files: listing.files,
      search: '',
    };
  }

  function beginFile(shareId: string, fileId: string, requesterPeerId: string, now = Date.now()) {
    const share = allowedShare(shareId, requesterPeerId, now);
    if ('error' in share) return share;
    const file = share.files.find((item) => item.id === fileId);
    if (!file) return { error: 'missing' as const };
    if (activeCount() >= MAX_JOBS) return { error: 'busy' as const };
    const job = makeJob('file', share, requesterPeerId, [file], now);
    jobs.set(job.id, job);
    return { job, file };
  }

  function beginZip(shareId: string, dirInput: unknown, fileIds: unknown, requesterPeerId: string, now = Date.now()) {
    const share = allowedShare(shareId, requesterPeerId, now);
    if ('error' in share) return share;
    let selected = share.files;
    if (Array.isArray(fileIds) && fileIds.length > 0) {
      const wanted = new Set(fileIds.filter((id): id is string => typeof id === 'string'));
      selected = share.files.filter((file) => wanted.has(file.id));
    } else {
      const dir = typeof dirInput === 'string' && dirInput ? sanitizeSharePath(dirInput) : '';
      if (dirInput && !dir) return { error: 'path' as const };
      selected = filesUnder(share.files, dir ?? '');
    }
    if (selected.length === 0) return { error: 'missing' as const };
    if (activeCount() >= MAX_JOBS) return { error: 'busy' as const };
    const job = makeJob('zip', share, requesterPeerId, selected, now);
    jobs.set(job.id, job);
    return { job, files: selected };
  }

  function outbox(ownerPeerId: string, now = Date.now()) {
    sweep(now);
    return [...jobs.values()]
      .filter((job) => job.ownerPeerId === ownerPeerId && !job.cancelled)
      .map((job) => ({
        id: job.id,
        kind: job.kind,
        shareId: job.shareId,
        files: job.files.map((file) => ({
          fileId: file.id,
          relativePath: file.relativePath,
          size: file.size,
        })),
        nextFileId: job.files[job.cursor]?.id ?? null,
        ready: job.waiter !== null,
      }));
  }

  function takeBytes(jobId: string, fileId: string, ownerPeerId: string): { stream: PassThrough; size: number } | { error: string } {
    const job = jobs.get(jobId);
    if (!job || job.cancelled || job.ownerPeerId !== ownerPeerId) return { error: 'That download is no longer waiting.' };
    const expected = job.files[job.cursor];
    if (!expected || expected.id !== fileId) return { error: 'Send the next requested file.' };
    if (!job.waiter) return { error: 'The download is not ready for this file yet.' };
    const stream = new PassThrough({ highWaterMark: 64 * 1024 });
    const resolve = job.waiter;
    job.waiter = null;
    job.rejecter = null;
    job.cursor += 1;
    resolve(stream);
    return { stream, size: expected.size };
  }

  function waitForFile(job: Job, fileId: string): Promise<PassThrough> {
    const index = job.files.findIndex((file) => file.id === fileId);
    if (index !== job.cursor) return Promise.reject(new Error('The files arrived out of order.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cancelJob(job, 'The sender did not provide this file.');
        reject(new Error('The sender did not provide this file.'));
      }, JOB_MS);
      job.waiter = (stream) => {
        clearTimeout(timer);
        resolve(stream);
      };
      job.rejecter = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  function cancelDownload(jobId: string): void {
    const job = jobs.get(jobId);
    if (job) cancelJob(job, 'The download was cancelled.');
  }

  function finish(jobId: string): void {
    jobs.delete(jobId);
  }

  function view(share: ShareRecord, peerId: string, now: number) {
    const person = people.get(share.ownerPeerId);
    return {
      id: share.id,
      name: share.name,
      ownerPeerId: share.ownerPeerId,
      ownerName: person?.displayName ?? 'This browser',
      mine: share.ownerPeerId === peerId,
      available: share.held && !share.revoked && now - share.lastSeen <= ONLINE_MS,
      revoked: share.revoked,
      fileCount: share.files.length,
      sizeBytes: share.files.reduce((sum, file) => sum + file.size, 0),
      createdAt: new Date(share.createdAt).toISOString(),
    };
  }

  function visible(shareId: string, peerId: string, now: number): ShareRecord | null {
    sweep(now);
    const share = shares.get(shareId);
    if (!share) return null;
    if (share.ownerPeerId !== peerId && !share.allowed.has(peerId)) return null;
    return share;
  }

  function allowedShare(shareId: string, peerId: string, now: number) {
    const share = visible(shareId, peerId, now);
    if (!share || share.revoked) return { error: 'forbidden' as const };
    if (!share.held || now - share.lastSeen > ONLINE_MS) return { error: 'offline' as const };
    return share;
  }

  function makeJob(kind: Job['kind'], share: ShareRecord, requesterPeerId: string, files: PreparedFile[], now: number): Job {
    return {
      id: crypto.randomUUID(),
      kind,
      shareId: share.id,
      ownerPeerId: share.ownerPeerId,
      requesterPeerId,
      files,
      cursor: 0,
      cancelled: false,
      createdAt: now,
      waiter: null,
      rejecter: null,
    };
  }

  function cancelJob(job: Job, message: string): void {
    job.cancelled = true;
    job.rejecter?.(new Error(message));
    job.waiter = null;
    job.rejecter = null;
    jobs.delete(job.id);
  }

  function activeCount(): number {
    let count = 0;
    for (const job of jobs.values()) if (!job.cancelled) count += 1;
    return count;
  }

  function sweep(now: number): void {
    for (const [id, share] of shares) {
      const quiet = now - share.lastSeen > 2 * 60 * 1000;
      if ((share.revoked || !share.held) && quiet) shares.delete(id);
      else if (quiet) shares.delete(id);
    }
    for (const job of [...jobs.values()]) {
      if (now - job.createdAt > JOB_MS) cancelJob(job, 'The download timed out.');
    }
  }

  function postSignal(input: {
    fromPeerId: string;
    shareId: string;
    fileId: string;
    toPeerId: string;
    kind: string;
    transferId?: string;
    payload: unknown;
  }, now = Date.now()): { ok: true; transferId: string } | { ok: false; status: number; error: string } {
    const share = shares.get(input.shareId);
    const file = share?.files.find((item) => item.id === input.fileId);
    if (!share || !file || share.revoked) return { ok: false, status: 404, error: 'That shared file is not available.' };
    const kind = input.kind;
    const payload = typeof input.payload === 'string' ? input.payload.slice(0, 12_000) : '';
    if (typeof input.payload === 'string' && input.payload.length > 12_000) {
      return { ok: false, status: 400, error: 'That direct-send message is too large.' };
    }
    if (kind === 'request') {
      if (input.fromPeerId === share.ownerPeerId || !share.allowed.has(input.fromPeerId) || input.toPeerId !== share.ownerPeerId) {
        return { ok: false, status: 403, error: 'You cannot ask for this file.' };
      }
      if (now - share.lastSeen > ONLINE_MS) return { ok: false, status: 409, error: 'That person is not here.' };
      const transfer = {
        id: crypto.randomUUID(),
        shareId: share.id,
        fileId: file.id,
        ownerPeerId: share.ownerPeerId,
        peerId: input.fromPeerId,
        expiresAt: now + 2 * 60_000,
      };
      transfers.set(transfer.id, transfer);
      deliver(input.toPeerId, { ...transferFields(transfer), fromPeerId: input.fromPeerId, toPeerId: input.toPeerId, kind, payload });
      return { ok: true, transferId: transfer.id };
    }
    const transfer = transfers.get(input.transferId ?? '');
    if (!transfer || transfer.expiresAt <= now || transfer.fileId !== file.id) {
      return { ok: false, status: 404, error: 'That direct send is no longer open.' };
    }
    const fromOwner = input.fromPeerId === transfer.ownerPeerId;
    const fromPeer = input.fromPeerId === transfer.peerId;
    const other = fromOwner ? transfer.peerId : transfer.ownerPeerId;
    if ((!fromOwner && !fromPeer) || input.toPeerId !== other) {
      return { ok: false, status: 403, error: 'That direct send is for someone else.' };
    }
    if ((kind === 'offer' || kind === 'reject') && !fromOwner) return { ok: false, status: 403, error: 'Only the sender can offer this file.' };
    if (kind === 'answer' && !fromPeer) return { ok: false, status: 403, error: 'Only the receiver can answer.' };
    deliver(input.toPeerId, { ...transferFields(transfer), fromPeerId: input.fromPeerId, toPeerId: input.toPeerId, kind, payload });
    return { ok: true, transferId: transfer.id };
  }

  function takeSignals(peerId: string) {
    const queued = signals.get(peerId) ?? [];
    signals.delete(peerId);
    return queued;
  }

  function deliver(peerId: string, signal: ShareSignal): void {
    const queued = signals.get(peerId) ?? [];
    queued.push(signal);
    signals.set(peerId, queued.slice(-40));
  }

  return {
    beat,
    online,
    isOnline,
    preview,
    publish,
    release,
    revoke,
    list,
    browse,
    beginFile,
    beginZip,
    outbox,
    takeBytes,
    waitForFile,
    cancelDownload,
    finish,
    postSignal,
    takeSignals,
  };
}

type ShareTransfer = {
  id: string;
  shareId: string;
  fileId: string;
  ownerPeerId: string;
  peerId: string;
  expiresAt: number;
};

type ShareSignal = {
  transferId: string;
  shareId: string;
  fileId: string;
  fromPeerId: string;
  toPeerId: string;
  kind: string;
  payload: string;
};

function transferFields(transfer: ShareTransfer): Pick<ShareSignal, 'transferId' | 'shareId' | 'fileId'> {
  return { transferId: transfer.id, shareId: transfer.shareId, fileId: transfer.fileId };
}

export type ShareHub = ReturnType<typeof createShareHub>;

function breadcrumbs(dir: string): Array<{ name: string; path: string }> {
  if (!dir) return [];
  const parts = dir.split('/');
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
}
