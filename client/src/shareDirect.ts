import { postShareSignal, type ShareSignal } from './shareClient';

const DIRECT_MAX_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024;

type Link = {
  pc: RTCPeerConnection;
  remoteReady: boolean;
  ice: RTCIceCandidateInit[];
  fail: (message: string) => void;
};

export function directShareAvailable(size: number): boolean {
  return typeof RTCPeerConnection !== 'undefined' && size > 0 && size <= DIRECT_MAX_BYTES;
}

export function createShareDirect(lookup: (fileId: string) => File | undefined) {
  const links = new Map<string, Link>();

  async function handle(signal: ShareSignal, csrf: string): Promise<void> {
    if (signal.kind !== 'request') {
      const link = links.get(signal.transferId);
      if (!link) return;
      if (signal.kind === 'reject') {
        link.fail('The sender does not still have this file open. Use Download through this computer.');
        close(signal.transferId);
        return;
      }
      if (signal.kind === 'offer') {
        const description = JSON.parse(signal.payload) as RTCSessionDescriptionInit;
        await link.pc.setRemoteDescription(description);
        link.remoteReady = true;
        for (const candidate of link.ice.splice(0)) await link.pc.addIceCandidate(candidate);
        const answer = await link.pc.createAnswer();
        await link.pc.setLocalDescription(answer);
        await postShareSignal({
          shareId: signal.shareId,
          fileId: signal.fileId,
          toPeerId: signal.fromPeerId,
          kind: 'answer',
          transferId: signal.transferId,
          payload: JSON.stringify(link.pc.localDescription),
        }, csrf);
      }
      if (signal.kind === 'answer') {
        await link.pc.setRemoteDescription(JSON.parse(signal.payload) as RTCSessionDescriptionInit);
        link.remoteReady = true;
        for (const candidate of link.ice.splice(0)) await link.pc.addIceCandidate(candidate);
      }
      if (signal.kind === 'ice' && signal.payload) {
        const candidate = JSON.parse(signal.payload) as RTCIceCandidateInit;
        if (!link.remoteReady) link.ice.push(candidate);
        else await link.pc.addIceCandidate(candidate);
      }
      return;
    }
    const file = lookup(signal.fileId);
    if (!file || !directShareAvailable(file.size)) {
      await postShareSignal({
        shareId: signal.shareId,
        fileId: signal.fileId,
        toPeerId: signal.fromPeerId,
        kind: 'reject',
        transferId: signal.transferId,
        payload: JSON.stringify({ reason: file ? 'too-large' : 'away' }),
      }, csrf);
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: [] });
    const channel = pc.createDataChannel('file');
    channel.binaryType = 'arraybuffer';
    links.set(signal.transferId, { pc, remoteReady: false, ice: [], fail: () => undefined });
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void postShareSignal({
        shareId: signal.shareId,
        fileId: signal.fileId,
        toPeerId: signal.fromPeerId,
        kind: 'ice',
        transferId: signal.transferId,
        payload: JSON.stringify(event.candidate.toJSON()),
      }, csrf);
    };
    channel.onopen = () => {
      void sendFile(channel, file).catch(() => close(signal.transferId));
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await postShareSignal({
      shareId: signal.shareId,
      fileId: signal.fileId,
      toPeerId: signal.fromPeerId,
      kind: 'offer',
      transferId: signal.transferId,
      payload: JSON.stringify(pc.localDescription),
    }, csrf);
  }

  function receive(
    shareId: string,
    fileId: string,
    ownerPeerId: string,
    csrf: string,
    options: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {},
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let transferId = '';
      let timer = 0;
      const pc = new RTCPeerConnection({ iceServers: [] });
      const finish = (error?: Error, blob?: Blob) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        close(transferId);
        if (!transferId) pc.close();
        if (error) reject(error);
        else if (blob) resolve(blob);
      };
      const onAbort = () => finish(new Error('Direct download was canceled.'));
      if (options.signal?.aborted) {
        pc.close();
        reject(new Error('Direct download was canceled.'));
        return;
      }
      options.signal?.addEventListener('abort', onAbort);
      timer = window.setTimeout(() => finish(new Error('Direct download did not start. Use Download through this computer.')), 20_000);
      const link: Link = { pc, remoteReady: false, ice: [], fail: (message) => finish(new Error(message)) };
      pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.binaryType = 'arraybuffer';
        const parts: BlobPart[] = [];
        let expected = -1;
        let received = 0;
        channel.onmessage = (message) => {
          if (typeof message.data === 'string') {
            const parsed = JSON.parse(message.data) as { type?: string; size?: number };
            if (parsed.type === 'meta' && typeof parsed.size === 'number') expected = parsed.size;
            if (parsed.type === 'done') {
              if (expected >= 0 && received === expected) finish(undefined, new Blob(parts));
              else finish(new Error('The direct download stopped early.'));
            }
            return;
          }
          const chunk = message.data as ArrayBuffer;
          parts.push(chunk);
          received += chunk.byteLength;
          if (expected > 0) options.onProgress?.(received, expected);
        };
      };
      void postShareSignal({ shareId, fileId, toPeerId: ownerPeerId, kind: 'request', payload: '' }, csrf).then((result) => {
        transferId = result.transferId;
        links.set(transferId, link);
        pc.onicecandidate = (event) => {
          if (!event.candidate) return;
          void postShareSignal({
            shareId,
            fileId,
            toPeerId: ownerPeerId,
            kind: 'ice',
            transferId,
            payload: JSON.stringify(event.candidate.toJSON()),
          }, csrf);
        };
      }).catch((caught: unknown) => {
        finish(caught instanceof Error ? caught : new Error('Direct download is not available.'));
      });
    });
  }

  function close(transferId: string): void {
    links.get(transferId)?.pc.close();
    links.delete(transferId);
  }

  return { handle, receive, closeAll() { for (const id of [...links.keys()]) close(id); } };
}

async function sendFile(channel: RTCDataChannel, file: File): Promise<void> {
  channel.send(JSON.stringify({ type: 'meta', size: file.size }));
  let offset = 0;
  while (offset < file.size) {
    if (channel.readyState !== 'open') throw new Error('The direct connection closed.');
    while (channel.bufferedAmount > 1024 * 1024) {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      if (channel.readyState !== 'open') throw new Error('The direct connection closed.');
    }
    const end = Math.min(offset + CHUNK_BYTES, file.size);
    channel.send(await file.slice(offset, end).arrayBuffer());
    offset = end;
  }
  channel.send(JSON.stringify({ type: 'done' }));
}
