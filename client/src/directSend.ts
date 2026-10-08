import { postSignal, type DirectSignal } from './api';
import { localFile } from './localFiles';

const DIRECT_MAX_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024;
const WAIT_MS = 20_000;

type Link = {
  pc: RTCPeerConnection;
  remoteReady: boolean;
  ice: RTCIceCandidateInit[];
  fail: (message: string) => void;
};

export function createDirectHub() {
  const links = new Map<string, Link>();

  async function handle(signal: DirectSignal, csrf: string): Promise<void> {
    try {
      if (signal.kind === 'request') {
        await answerRequest(signal, csrf);
        return;
      }
      const link = links.get(signal.transferId);
      if (!link) return;
      if (signal.kind === 'reject') {
        link.fail(rejectMessage(signal.payload));
        closeLink(signal.transferId);
        return;
      }
      if (signal.kind === 'offer' || signal.kind === 'answer') {
        const description = JSON.parse(signal.payload) as RTCSessionDescriptionInit;
        await link.pc.setRemoteDescription(description);
        link.remoteReady = true;
        await flushIce(link);
        if (signal.kind === 'offer') {
          const answer = await link.pc.createAnswer();
          await link.pc.setLocalDescription(answer);
          await postSignal({
            fileId: signal.fileId,
            toUserId: signal.fromUserId,
            kind: 'answer',
            transferId: signal.transferId,
            payload: JSON.stringify(link.pc.localDescription),
          }, csrf);
        }
        return;
      }
      if (signal.kind === 'ice' && signal.payload) {
        const candidate = JSON.parse(signal.payload) as RTCIceCandidateInit | null;
        if (!candidate) return;
        if (!link.remoteReady) link.ice.push(candidate);
        else await link.pc.addIceCandidate(candidate);
      }
    } catch {
      links.get(signal.transferId)?.fail('The direct transfer stopped. Use Download.');
      closeLink(signal.transferId);
    }
  }

  function requestFile(fileId: string, ownerId: string, csrf: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let transferId = '';
      let timer = 0;
      const pc = new RTCPeerConnection({ iceServers: [] });
      const finish = (error?: Error, blob?: Blob) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        closeLink(transferId);
        if (!transferId) pc.close();
        if (error) reject(error);
        else if (blob) resolve(blob);
      };
      timer = window.setTimeout(() => {
        finish(new Error('The uploader did not answer. Use Download.'));
      }, WAIT_MS);
      const link: Link = {
        pc,
        remoteReady: false,
        ice: [],
        fail: (message) => finish(new Error(message)),
      };
      pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.binaryType = 'arraybuffer';
        receiveFile(channel).then((blob) => finish(undefined, blob)).catch((caught: unknown) => {
          finish(caught instanceof Error ? caught : new Error('The direct transfer stopped. Use Download.'));
        });
      };
      void postSignal({
        fileId,
        toUserId: ownerId,
        kind: 'request',
        payload: '',
      }, csrf).then((result) => {
        if (settled) {
          pc.close();
          return;
        }
        transferId = result.transferId;
        links.set(transferId, link);
        pc.onicecandidate = (event) => {
          if (!event.candidate) return;
          void postSignal({
            fileId,
            toUserId: ownerId,
            kind: 'ice',
            transferId,
            payload: JSON.stringify(event.candidate.toJSON()),
          }, csrf);
        };
      }).catch((caught: unknown) => {
        finish(caught instanceof Error ? caught : new Error('Direct send is not available. Use Download.'));
      });
    });
  }

  async function answerRequest(signal: DirectSignal, csrf: string): Promise<void> {
    const file = localFile(signal.fileId);
    if (!file) return;
    if (file.size > DIRECT_MAX_BYTES) {
      await postSignal({
        fileId: signal.fileId,
        toUserId: signal.fromUserId,
        kind: 'reject',
        transferId: signal.transferId,
        payload: JSON.stringify({ reason: 'too-large' }),
      }, csrf);
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: [] });
    const channel = pc.createDataChannel('file');
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 256 * 1024;
    const link: Link = { pc, remoteReady: false, ice: [], fail: () => undefined };
    links.set(signal.transferId, link);
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void postSignal({
        fileId: signal.fileId,
        toUserId: signal.fromUserId,
        kind: 'ice',
        transferId: signal.transferId,
        payload: JSON.stringify(event.candidate.toJSON()),
      }, csrf);
    };
    channel.onopen = () => {
      void sendFile(channel, file).catch(() => closeLink(signal.transferId));
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await postSignal({
      fileId: signal.fileId,
      toUserId: signal.fromUserId,
      kind: 'offer',
      transferId: signal.transferId,
      payload: JSON.stringify(pc.localDescription),
    }, csrf);
  }

  function closeLink(transferId: string): void {
    const link = links.get(transferId);
    link?.pc.close();
    links.delete(transferId);
  }

  function close(): void {
    for (const id of [...links.keys()]) closeLink(id);
  }

  return { handle, requestFile, close };
}

async function flushIce(link: Link): Promise<void> {
  const waiting = link.ice.splice(0);
  for (const candidate of waiting) await link.pc.addIceCandidate(candidate);
}

function rejectMessage(payload: string): string {
  try {
    const reason = (JSON.parse(payload) as { reason?: string }).reason;
    if (reason === 'too-large') return 'This file is too large to send directly. Use Download.';
  } catch {
    // A missing reason still means the sender cannot hand the file over.
  }
  return 'The uploader does not have this file in the open browser. Use Download.';
}

async function sendFile(channel: RTCDataChannel, file: File): Promise<void> {
  channel.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size }));
  let offset = 0;
  while (offset < file.size) {
    if (channel.bufferedAmount > 1024 * 1024) {
      await new Promise<void>((resolve) => {
        channel.addEventListener('bufferedamountlow', () => resolve(), { once: true });
      });
    }
    const end = Math.min(offset + CHUNK_BYTES, file.size);
    channel.send(await file.slice(offset, end).arrayBuffer());
    offset = end;
  }
  channel.send(JSON.stringify({ type: 'done' }));
}

function receiveFile(channel: RTCDataChannel): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const parts: BlobPart[] = [];
    let expected = -1;
    let received = 0;
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data) as { type?: string; size?: number };
        if (message.type === 'meta' && typeof message.size === 'number') expected = message.size;
        if (message.type === 'done') {
          if (expected >= 0 && received === expected) resolve(new Blob(parts));
          else reject(new Error('The direct transfer stopped early. Use Download.'));
        }
        return;
      }
      const chunk = event.data as ArrayBuffer;
      parts.push(chunk);
      received += chunk.byteLength;
    };
    channel.onclose = () => {
      if (expected < 0 || received !== expected) {
        reject(new Error('The direct transfer stopped. Use Download.'));
      }
    };
  });
}
