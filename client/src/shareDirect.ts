import { receiveDirectFile, sendDirectFile, type DirectSendProgress } from './directChannel';
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
  const secure = typeof window === 'undefined' ? false : window.isSecureContext;
  return secure && typeof RTCPeerConnection !== 'undefined' && size > 0 && size <= DIRECT_MAX_BYTES;
}

export function createShareDirect(
  lookup: (fileId: string) => File | undefined,
  hooks: { onSend?: (event: { id: string; filename: string; progress: DirectSendProgress; status: 'sending' | 'finishing' | 'completed' | 'lost' }) => void } = {},
) {
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
      hooks.onSend?.({
        id: signal.transferId,
        filename: file.name,
        progress: { sentBytes: 0, confirmedBytes: 0, totalBytes: file.size },
        status: 'sending',
      });
      void sendDirectFile(channel, file, CHUNK_BYTES, {
        onProgress: (progress) => hooks.onSend?.({
          id: signal.transferId,
          filename: file.name,
          progress,
          status: progress.confirmedBytes >= file.size ? 'finishing' : 'sending',
        }),
      }).then(() => {
        hooks.onSend?.({
          id: signal.transferId,
          filename: file.name,
          progress: { sentBytes: file.size, confirmedBytes: file.size, totalBytes: file.size },
          status: 'completed',
        });
      }).catch(() => {
        hooks.onSend?.({
          id: signal.transferId,
          filename: file.name,
          progress: { sentBytes: 0, confirmedBytes: 0, totalBytes: file.size },
          status: 'lost',
        });
        close(signal.transferId);
      });
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
        receiveDirectFile(channel, options).then((blob) => finish(undefined, blob)).catch((caught: unknown) => {
          finish(caught instanceof Error ? caught : new Error('The direct download stopped early.'));
        });
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
