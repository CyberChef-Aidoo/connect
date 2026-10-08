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

type BrowserPresence = { userId: string; peerId: string; seenAt: number };

type Transfer = {
  id: string;
  fileId: string;
  ownerUserId: string;
  requesterUserId: string;
  requesterPeerId: string;
  ownerPeerIds: string[];
  expiresAt: number;
};

type PostResult =
  | { ok: true; transferId: string }
  | { ok: false; status: number; error: string };

export type SignalInput = {
  fromUserId: string;
  fromPeerId: string;
  fileOwnerId: string;
  fileId: string;
  toUserId: string;
  kind: string;
  transferId?: string;
  payload: unknown;
};

export function createPeerHub() {
  const browsers = new Map<string, BrowserPresence>();
  const transfers = new Map<string, Transfer>();
  const inbox = new Map<string, DirectSignal[]>();

  function onlineBrowsers(now = Date.now()): BrowserPresence[] {
    const list: BrowserPresence[] = [];
    for (const [peerId, browser] of browsers) {
      if (now - browser.seenAt > ONLINE_MS) browsers.delete(peerId);
      else list.push(browser);
    }
    return list;
  }

  function onlineIds(now = Date.now()): string[] {
    return [...new Set(onlineBrowsers(now).map((browser) => browser.userId))];
  }

  function beat(userId: string, peerId: string, now = Date.now()): void {
    browsers.set(peerId, { userId, peerId, seenAt: now });
  }

  function browsersFor(userId: string, now: number): string[] {
    return onlineBrowsers(now).filter((browser) => browser.userId === userId).map((browser) => browser.peerId);
  }

  function post(input: SignalInput, now = Date.now()): PostResult {
    const kind = input.kind;
    if (kind !== 'request' && kind !== 'offer' && kind !== 'answer' && kind !== 'ice' && kind !== 'reject') {
      return { ok: false, status: 400, error: 'Choose a direct-send message type.' };
    }
    if (!ID_PATTERN.test(input.toUserId) || !ID_PATTERN.test(input.fromPeerId)) {
      return { ok: false, status: 400, error: 'Choose who should receive this.' };
    }
    const payload = typeof input.payload === 'string' ? input.payload : '';
    if (payload.length > MAX_PAYLOAD) {
      return { ok: false, status: 400, error: 'That direct-send message is too large.' };
    }
    if ((kind === 'offer' || kind === 'answer') && !payload.includes('"sdp"')) {
      return { ok: false, status: 400, error: 'That direct-send message is incomplete.' };
    }
    if (kind === 'request') {
      if (input.toUserId !== input.fileOwnerId) {
        return { ok: false, status: 403, error: 'Ask the person who uploaded the file.' };
      }
      const targets = browsersFor(input.fileOwnerId, now).filter((peerId) => peerId !== input.fromPeerId);
      if (targets.length === 0) {
        return { ok: false, status: 409, error: 'That person is not here.' };
      }
      if (openCount(input.fromPeerId, now) >= MAX_TRANSFERS) {
        return { ok: false, status: 429, error: 'Too many direct sends are already open.' };
      }
      const transfer: Transfer = {
        id: crypto.randomUUID(),
        fileId: input.fileId,
        ownerUserId: input.fileOwnerId,
        requesterUserId: input.fromUserId,
        requesterPeerId: input.fromPeerId,
        ownerPeerIds: targets,
        expiresAt: now + TRANSFER_MS,
      };
      transfers.set(transfer.id, transfer);
      const signal: DirectSignal = {
        transferId: transfer.id,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        fileId: input.fileId,
        kind,
        payload,
      };
      for (const peerId of targets) deliver(peerId, signal);
      return { ok: true, transferId: transfer.id };
    }

    const transferId = input.transferId ?? '';
    const transfer = transfers.get(transferId);
    if (!transfer || transfer.expiresAt <= now || transfer.fileId !== input.fileId) {
      return { ok: false, status: 404, error: 'That direct send is no longer open.' };
    }
    const fromOwner = transfer.ownerPeerIds.includes(input.fromPeerId);
    const fromRequester = input.fromPeerId === transfer.requesterPeerId;
    if (!fromOwner && !fromRequester) {
      return { ok: false, status: 403, error: 'That direct send is for someone else.' };
    }
    if ((kind === 'offer' || kind === 'reject') && !fromOwner) {
      return { ok: false, status: 403, error: 'Only the uploader can offer this file.' };
    }
    if (kind === 'answer' && !fromRequester) {
      return { ok: false, status: 403, error: 'Only the receiver can answer.' };
    }
    const targets = fromOwner
      ? [transfer.requesterPeerId]
      : transfer.ownerPeerIds.filter((peerId) => peerId !== input.fromPeerId);
    const signal: DirectSignal = {
      transferId: transfer.id,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      fileId: input.fileId,
      kind,
      payload,
    };
    for (const peerId of targets) deliver(peerId, signal);
    return { ok: true, transferId: transfer.id };
  }

  function take(peerId: string): DirectSignal[] {
    const queued = inbox.get(peerId) ?? [];
    inbox.delete(peerId);
    return queued;
  }

  function openCount(peerId: string, now: number): number {
    let count = 0;
    for (const [id, transfer] of transfers) {
      if (transfer.expiresAt <= now) transfers.delete(id);
      else if (transfer.requesterPeerId === peerId || transfer.ownerPeerIds.includes(peerId)) count += 1;
    }
    return count;
  }

  function deliver(peerId: string, signal: DirectSignal): void {
    const queued = inbox.get(peerId) ?? [];
    queued.push(signal);
    inbox.set(peerId, queued.slice(-MAX_INBOX));
  }

  return { beat, onlineIds, onlineBrowsers, post, take };
}
