const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ONLINE_MS = 20_000;
const TRANSFER_MS = 2 * 60_000;
const MAX_PAYLOAD = 12_000;
const MAX_INBOX = 40;
const MAX_TRANSFERS = 8;

export type SignalKind = 'request' | 'offer' | 'answer' | 'ice' | 'reject';

export type DirectSignal = {
  transferId: string;
  fromUserId: string;
  toUserId: string;
  fileId: string;
  kind: SignalKind;
  payload: string;
};

type Transfer = {
  id: string;
  fileId: string;
  ownerId: string;
  peerId: string;
  expiresAt: number;
};

type PostResult =
  | { ok: true; transferId: string }
  | { ok: false; status: number; error: string };

export type SignalInput = {
  fromUserId: string;
  fileOwnerId: string;
  fileId: string;
  toUserId: string;
  kind: string;
  transferId?: string;
  payload: unknown;
};

export function createPeerHub() {
  const seenAt = new Map<string, number>();
  const transfers = new Map<string, Transfer>();
  const inbox = new Map<string, DirectSignal[]>();

  function onlineIds(now = Date.now()): string[] {
    const ids: string[] = [];
    for (const [userId, at] of seenAt) {
      if (now - at <= ONLINE_MS) ids.push(userId);
      else seenAt.delete(userId);
    }
    return ids;
  }

  function beat(userId: string, now = Date.now()): void {
    seenAt.set(userId, now);
  }

  function post(input: SignalInput, now = Date.now()): PostResult {
    const kind = input.kind;
    if (kind !== 'request' && kind !== 'offer' && kind !== 'answer' && kind !== 'ice' && kind !== 'reject') {
      return { ok: false, status: 400, error: 'Choose a direct-send message type.' };
    }
    if (!ID_PATTERN.test(input.toUserId) || input.toUserId === input.fromUserId) {
      return { ok: false, status: 400, error: 'Choose who should receive this.' };
    }
    const payload = typeof input.payload === 'string' ? input.payload : '';
    if (payload.length > MAX_PAYLOAD) {
      return { ok: false, status: 400, error: 'That direct-send message is too large.' };
    }
    if (kind === 'request') {
      if (input.toUserId !== input.fileOwnerId) {
        return { ok: false, status: 403, error: 'Ask the person who uploaded the file.' };
      }
      if (!isOnline(input.toUserId, now)) {
        return { ok: false, status: 409, error: 'That person is not here.' };
      }
      if (openCount(input.fromUserId, now) >= MAX_TRANSFERS) {
        return { ok: false, status: 429, error: 'Too many direct sends are already open.' };
      }
      const transfer: Transfer = {
        id: crypto.randomUUID(),
        fileId: input.fileId,
        ownerId: input.fileOwnerId,
        peerId: input.fromUserId,
        expiresAt: now + TRANSFER_MS,
      };
      transfers.set(transfer.id, transfer);
      deliver({
        transferId: transfer.id,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        fileId: input.fileId,
        kind,
        payload,
      });
      return { ok: true, transferId: transfer.id };
    }

    const transferId = input.transferId ?? '';
    const transfer = transfers.get(transferId);
    if (!transfer || transfer.expiresAt <= now || transfer.fileId !== input.fileId) {
      return { ok: false, status: 404, error: 'That direct send is no longer open.' };
    }
    const party = input.fromUserId === transfer.ownerId || input.fromUserId === transfer.peerId;
    const other = input.fromUserId === transfer.ownerId ? transfer.peerId : transfer.ownerId;
    if (!party || input.toUserId !== other) {
      return { ok: false, status: 403, error: 'That direct send is for someone else.' };
    }
    if ((kind === 'offer' || kind === 'reject') && input.fromUserId !== transfer.ownerId) {
      return { ok: false, status: 403, error: 'Only the uploader can offer this file.' };
    }
    if (kind === 'answer' && input.fromUserId !== transfer.peerId) {
      return { ok: false, status: 403, error: 'Only the receiver can answer.' };
    }
    deliver({
      transferId: transfer.id,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      fileId: input.fileId,
      kind,
      payload,
    });
    return { ok: true, transferId: transfer.id };
  }

  function take(userId: string): DirectSignal[] {
    const queued = inbox.get(userId) ?? [];
    inbox.delete(userId);
    return queued;
  }

  function isOnline(userId: string, now: number): boolean {
    const at = seenAt.get(userId);
    return at !== undefined && now - at <= ONLINE_MS;
  }

  function openCount(userId: string, now: number): number {
    let count = 0;
    for (const [id, transfer] of transfers) {
      if (transfer.expiresAt <= now) transfers.delete(id);
      else if (transfer.peerId === userId || transfer.ownerId === userId) count += 1;
    }
    return count;
  }

  function deliver(signal: DirectSignal): void {
    const queued = inbox.get(signal.toUserId) ?? [];
    queued.push(signal);
    inbox.set(signal.toUserId, queued.slice(-MAX_INBOX));
  }

  return { beat, onlineIds, post, take };
}
