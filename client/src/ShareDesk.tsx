import { useEffect, useRef, useState } from 'react';
import { randomId } from './randomId';
import { browsersHere, connectionPlain, explainRejected, explainShareError, supportDetails, transferLabel } from './shareCopy';
import { startBrowserDownload, type DownloadWatch } from './browserDownload';
import { formatBytes } from './format';
import { createShareDirect, directShareAvailable } from './shareDirect';
import { shouldPaint } from './transfer';
import { TransferCards, type TransferCardModel } from './transferCards';
import {
  abortOutbox,
  browseShare,
  confirmRelay,
  folderSelectionAvailable,
  listSharePeers,
  listShares,
  previewShare,
  publishShare,
  relayFileUrl,
  relayZipUrl,
  releaseShares,
  revokeShare,
  sendSharedBytes,
  shareOutbox,
  takeShareSignals,
  type ListedFile,
  type ShareFileDraft,
  type ShareListing,
  type SharePerson,
  type ShareSummary,
} from './shareClient';

type Draft = ShareFileDraft & { file: File };

const NAME_KEY = 'portal-share-name';

export function ShareDesk({ csrf, hidden }: { csrf: string; hidden: boolean }) {
  const folderOk = folderSelectionAvailable();
  const filesRef = useRef(new Map<string, File>());
  const sending = useRef(new Set<string>());
  const onDirectSend = useRef<(event: { id: string; filename: string; progress: { sentBytes: number; confirmedBytes: number; totalBytes: number }; status: 'sending' | 'finishing' | 'completed' | 'lost' }) => void>(() => undefined);
  const direct = useRef(createShareDirect((id) => filesRef.current.get(id), { onSend: (event) => onDirectSend.current(event) }));
  const paintAt = useRef(new Map<string, { at: number; status: string }>());
  const downloadCancels = useRef(new Map<string, () => void>());
  const [cards, setCards] = useState<TransferCardModel[]>([]);
  onDirectSend.current = (event) => rememberCard(directSendCard(event));
  const directAbort = useRef<AbortController | null>(null);
  const [nameOnNetwork, setNameOnNetwork] = useState(() => localStorage.getItem(NAME_KEY) || 'This browser');
  const [people, setPeople] = useState<SharePerson[]>([]);
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [preview, setPreview] = useState<ShareFileDraft[] | null>(null);
  const [rejected, setRejected] = useState<Array<{ relativePath: string; reason: string }>>([]);
  const [shareName, setShareName] = useState('');
  const [chosenPeers, setChosenPeers] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dir, setDir] = useState('');
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<ShareListing | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [connectionProblem, setConnectionProblem] = useState('');
  const [lastStatus, setLastStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [selfId, setSelfId] = useState('');
  const [link, setLink] = useState<'checking' | 'reachable' | 'unreachable' | 'signed-out'>('checking');
  const [transferMode, setTransferMode] = useState<'idle' | 'download' | 'direct'>('idle');
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [copyNote, setCopyNote] = useState('');
  const helpRef = useRef<HTMLDialogElement>(null);
  const detailsRef = useRef<HTMLTextAreaElement>(null);
  const reported = useRef('');
  const missingJobs = useRef(new Set<string>());

  useEffect(() => {
    let stop = false;
    let polling = false;
    void releaseShares(csrf).catch(() => undefined);
    const tick = () => {
      if (polling || stop) return;
      polling = true;
      void (async () => {
        try {
          const [peerList, shareList, jobs, signals] = await Promise.all([
            listSharePeers(),
            listShares(),
            shareOutbox(),
            takeShareSignals(),
          ]);
          if (stop) return;
          setLink('reachable');
          setConnectionProblem('');
          setPolledAt(Date.now());
          setSelfId(peerList.self);
          setPeople(peerList.people);
          setShares(shareList);
          const summary = `${peerList.self}:${peerList.people.length}`;
          if (reported.current !== summary) {
            reported.current = summary;
            console.info('portal connection', {
              api: 'reachable',
              signaling: 'http',
              session: peerList.self,
              peers: peerList.people.length,
            });
          }
          for (const signal of signals) {
            console.info('portal signal', { transfer: signal.transferId, kind: signal.kind });
            await direct.current.handle(signal, csrf);
          }
          for (const job of jobs) {
            if (!job.ready || !job.nextFileId) continue;
            const key = `${job.id}:${job.nextFileId}`;
            if (sending.current.has(key)) continue;
            const file = filesRef.current.get(job.nextFileId);
            if (!file) {
              if (!missingJobs.current.has(job.id)) {
                missingJobs.current.add(job.id);
                console.info('portal transfer', { transfer: job.id, mode: 'relay', result: 'source-missing' });
                void abortOutbox(job.id, csrf).catch(() => undefined);
              }
              continue;
            }
            sending.current.add(key);
            console.info('portal transfer', { transfer: job.id, file: job.nextFileId, mode: 'relay', bytes: file.size });
            const cardId = `relay-send-${job.id}-${job.nextFileId}`;
            try {
              await sendSharedBytes(job.id, job.nextFileId, file, csrf, (sent, total) => {
                rememberCard({
                  id: cardId,
                  filename: file.name,
                  direction: 'upload',
                  status: sent >= total ? 'finishing' : 'sending',
                  totalBytes: total,
                  transferredBytes: sent,
                  confirmedBytes: 0,
                  detail: 'Sending to this computer. The other browser has not confirmed a saved copy.',
                  error: null,
                  speed: '',
                  remaining: '',
                  canCancel: false,
                  canRetry: false,
                });
              });
              rememberCard({
                id: cardId,
                filename: file.name,
                direction: 'upload',
                status: 'completed',
                totalBytes: file.size,
                transferredBytes: file.size,
                confirmedBytes: file.size,
                detail: 'This computer accepted the file. A copy saved by the other browser cannot be confirmed here.',
                error: null,
                speed: '',
                remaining: '',
                canCancel: false,
                canRetry: false,
              });
            } catch {
              // The next poll retries while the download is still waiting.
            } finally {
              sending.current.delete(key);
            }
          }
        } catch (caught) {
          if (stop) return;
          const signedOut = caught instanceof Error && 'status' in caught && (caught as { status?: number }).status === 401;
          setLink(caught instanceof TypeError ? 'unreachable' : signedOut ? 'signed-out' : 'reachable');
          setConnectionProblem(explainShareError('check', caught));
          setLastStatus(caught instanceof Error && 'status' in caught ? Number((caught as { status?: number }).status) || null : null);
          console.info('portal connection', { api: caught instanceof TypeError ? 'unreachable' : 'error', status: signedOut ? 401 : 0 });
        } finally {
          polling = false;
        }
      })();
    };
    tick();
    const timer = window.setInterval(tick, 1500);
    return () => {
      stop = true;
      window.clearInterval(timer);
      direct.current.closeAll();
    };
  }, [csrf]);

  useEffect(() => {
    if (!openId) {
      setListing(null);
      return;
    }
    let stop = false;
    void browseShare(openId, dir, query).then((next) => {
      if (!stop) setListing(next);
    }).catch((caught: unknown) => {
      if (!stop) fail('open', caught);
    });
    return () => { stop = true; };
  }, [openId, dir, query, shares]);

  useEffect(() => {
    setPicked([]);
  }, [openId, dir]);

  useEffect(() => {
    const dialog = helpRef.current;
    if (!dialog) return;
    if (helpOpen && !dialog.open) dialog.showModal();
    if (!helpOpen && dialog.open) dialog.close();
  }, [helpOpen]);

  function fail(action: 'open' | 'preview' | 'publish' | 'stop' | 'download' | 'direct', caught: unknown) {
    setError(explainShareError(action, caught));
    setLastStatus(caught instanceof Error && 'status' in caught ? Number((caught as { status?: number }).status) || null : null);
  }

  function rememberName(value: string) {
    setNameOnNetwork(value);
    localStorage.setItem(NAME_KEY, value.trim() || 'This browser');
  }

  async function stage(list: FileList | null) {
    const incoming = [...(list ?? [])];
    if (incoming.length === 0) return;
    setError('');
    const rows: Draft[] = incoming.map((file) => ({
      clientToken: randomId(),
      relativePath: chosenPath(file),
      size: file.size,
      modifiedAt: file.lastModified,
      file,
    }));
    try {
      const result = await previewShare(rows, csrf);
      const byToken = new Map(rows.map((row) => [row.clientToken, row.file]));
      setDrafts(result.files.flatMap((file) => {
        const matched = byToken.get(file.clientToken);
        return matched ? [{ ...file, file: matched }] : [];
      }));
      setPreview(result.files);
      setRejected(result.rejected);
      setShareName(chosenPath(rows[0].file).split('/')[0] || 'Shared files');
      setChosenPeers([]);
      setMessage('');
    } catch (caught) {
      fail('preview', caught);
    }
  }

  async function confirmShare() {
    if (!preview || !drafts) return;
    setBusy('Starting share…');
    setError('');
    try {
      const published = await publishShare(shareName, chosenPeers, preview, csrf);
      for (const file of published.files) {
        const draft = drafts.find((item) => item.clientToken === file.clientToken);
        if (draft) filesRef.current.set(file.id, draft.file);
      }
      setDrafts(null);
      setPreview(null);
      setMessage(`“${published.share.name}” is shared with the people you chose. Keep this tab open. If you reload, choose the files again.`);
    } catch (caught) {
      fail('publish', caught);
    } finally {
      setBusy('');
    }
  }

  async function revoke(share: ShareSummary) {
    const agreed = window.confirm('Stop sharing these files? People who already downloaded a copy keep that copy. You cannot take it back. New downloads will be refused.');
    if (!agreed) return;
    try {
      await revokeShare(share.id, csrf);
      if (openId === share.id) setOpenId(null);
      setMessage('Sharing has stopped. Copies already downloaded stay with the people who received them.');
    } catch (caught) {
      fail('stop', caught);
    }
  }

  function rememberCard(card: TransferCardModel) {
    const now = Date.now();
    const previous = paintAt.current.get(card.id);
    const force = !previous || previous.status !== card.status;
    if (!shouldPaint(previous?.at ?? 0, now, force)) return;
    paintAt.current.set(card.id, { at: now, status: card.status });
    setCards((current) => {
      const index = current.findIndex((item) => item.id === card.id);
      if (index < 0) return [card, ...current];
      const next = current.slice();
      next[index] = card;
      return next;
    });
  }

  function directSendCard(event: { id: string; filename: string; progress: { sentBytes: number; confirmedBytes: number; totalBytes: number }; status: 'sending' | 'finishing' | 'completed' | 'lost' }): TransferCardModel {
    return {
      id: event.id,
      filename: event.filename,
      direction: 'upload',
      status: event.status,
      totalBytes: event.progress.totalBytes,
      transferredBytes: event.progress.sentBytes,
      confirmedBytes: event.progress.confirmedBytes,
      detail: 'Confirmed means the other browser has received these bytes.',
      error: event.status === 'lost' ? 'The connection was lost. Use Download.' : null,
      speed: '',
      remaining: '',
      canCancel: false,
      canRetry: false,
    };
  }

  function shareDownloadCard(watch: DownloadWatch): TransferCardModel {
    const relay = watch.kind === 'relay' || watch.kind === 'relay-zip';
    const packed = watch.sourceTotal !== null && watch.kind.endsWith('zip')
      ? `Read ${formatBytes(watch.sourceBytes)} of ${formatBytes(watch.sourceTotal)} from the files.`
      : '';
    return {
      id: watch.id,
      filename: watch.filename,
      direction: 'download',
      status: watch.status,
      totalBytes: watch.totalBytes,
      transferredBytes: watch.sentBytes,
      confirmedBytes: null,
      detail: [
        relay ? `Received from the other browser: ${formatBytes(watch.uploadBytes)}.` : '',
        `Sent ${formatBytes(watch.sentBytes)}. Saved: not confirmed.`,
        packed,
        watch.status === 'completed' ? 'This page cannot confirm the file was saved.' : '',
      ].filter(Boolean).join(' '),
      error: watch.error,
      speed: '',
      remaining: '',
      canCancel: watch.status === 'sending' || watch.status === 'downloading' || watch.status === 'finishing',
      canRetry: false,
    };
  }

  function cancelDirect() {
    directAbort.current?.abort();
  }

  async function takeDirect(share: ShareSummary, file: ListedFile) {
    directAbort.current?.abort();
    const controller = new AbortController();
    directAbort.current = controller;
    const label = file.relativePath.split('/').pop() ?? 'download';
    const cardId = `direct-${file.id}`;
    setTransferMode('direct');
    setError('');
    console.info('portal transfer', { share: share.id, file: file.id, mode: 'direct' });
    rememberCard({
      id: cardId,
      filename: label,
      direction: 'download',
      status: 'downloading',
      totalBytes: file.size,
      transferredBytes: 0,
      confirmedBytes: 0,
      detail: 'Receiving from the other browser.',
      error: null,
      speed: '',
      remaining: '',
      canCancel: true,
      canRetry: false,
    });
    try {
      const blob = await direct.current.receive(share.id, file.id, share.ownerPeerId, csrf, {
        signal: controller.signal,
        onProgress: (received, total) => rememberCard({
          id: cardId,
          filename: label,
          direction: 'download',
          status: received >= total ? 'finishing' : 'downloading',
          totalBytes: total,
          transferredBytes: received,
          confirmedBytes: received,
          detail: 'These bytes have arrived in this tab.',
          error: null,
          speed: '',
          remaining: '',
          canCancel: true,
          canRetry: false,
        }),
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.relativePath.split('/').pop() ?? 'download';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage(`Received ${link.download} in this tab. Your browser was asked to save a copy. This page cannot confirm that save.`);
      rememberCard({
        id: cardId,
        filename: label,
        direction: 'download',
        status: 'completed',
        totalBytes: file.size,
        transferredBytes: file.size,
        confirmedBytes: file.size,
        detail: 'Received in this tab. Your browser was asked to save a copy. This page cannot confirm that save.',
        error: null,
        speed: '',
        remaining: '',
        canCancel: false,
        canRetry: false,
      });
      setTransferMode('idle');
    } catch (caught) {
      setTransferMode('idle');
      fail('direct', caught);
      console.info('portal transfer', { share: share.id, file: file.id, mode: 'direct', result: 'failed' });
    } finally {
      setBusy('');
    }
  }

  async function startRelay(event: { preventDefault: () => void; currentTarget: HTMLAnchorElement }) {
    event.preventDefault();
    const href = event.currentTarget.href;
    setTransferMode('download');
    setError('');
    try {
      await confirmRelay(href);
      console.info('portal transfer', { mode: 'download', url: new URL(href).pathname });
      const started = startBrowserDownload({
        href,
        filename: 'Download',
        csrf,
        onUpdate: (watch) => rememberCard(shareDownloadCard(watch)),
      });
      downloadCancels.current.set(started.id, started.cancel);
      setMessage('The download has started. Sent bytes are shown here. This page cannot confirm the file was saved.');
    } catch (caught) {
      setTransferMode('idle');
      fail('download', caught);
    }
  }

  const mine = shares.filter((share) => share.mine && !share.revoked);
  const others = shares.filter((share) => !share.mine && !share.revoked);
  const sharesReady = shares.filter((share) => share.available && !share.revoked).length;
  const plain = connectionPlain({
    checking: link === 'checking',
    reachable: link === 'reachable',
    signedOut: link === 'signed-out',
  });
  const directAvailable = typeof window !== 'undefined' && window.isSecureContext;
  const folderChosen = Boolean(preview?.some((file) => file.relativePath.includes('/')));
  const details = supportDetails({
    build: __PORTAL_BUILD__,
    origin: typeof window === 'undefined' ? '' : window.location.origin,
    reachable: link === 'reachable',
    signedOut: link === 'signed-out',
    registered: Boolean(selfId),
    lastCheck: polledAt ? new Date(polledAt).toLocaleString() : '',
    browsers: people.map((person) => person.displayName),
    sharesReady,
    directAvailable,
    transfer: transferLabel(transferMode),
    lastProblem: connectionProblem || error,
    lastStatus,
  });

  function copyDetails() {
    const node = detailsRef.current;
    if (!node) return;
    node.focus();
    node.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    setCopyNote(copied
      ? 'Copied. Paste this into a message for support.'
      : 'Copy did not work. Select the details and copy them yourself.');
  }

  const status = (
    <div className="connection-plain">
      <p><strong>{plain.title}</strong></p>
      <p>{link === 'reachable' && connectionProblem ? connectionProblem : plain.detail}</p>
      <p>{browsersHere(people.map((person) => person.displayName))}</p>
      <button type="button" className="ghost" onClick={() => { setCopyNote(''); setHelpOpen(true); }}>Help</button>
    </div>
  );

  return (
    <>
    <TransferCards items={cards} onCancel={(id) => {
      if (id.startsWith('direct-')) cancelDirect();
      downloadCancels.current.get(id)?.();
    }} onRetry={() => undefined} />
    {hidden ? <section className="panel" aria-label="Connection">{status}</section> : null}
    <section className="panel share-desk" hidden={hidden}>
      <h2>Share files and folders</h2>
      <p>Choose files or a folder for other people to download. They cannot change or delete those files, and the files are not added to the library.</p>
      <p><strong>Keep this tab open.</strong> Reloading or closing it stops sharing until you choose the files again. Switching to Library does not.</p>
      {hidden ? null : status}
      <label className="share-name">
        Your name
        <input value={nameOnNetwork} aria-describedby="share-name-help" onChange={(event) => rememberName(event.target.value)} />
      </label>
      <p id="share-name-help" className="meta">Other people see this name. It applies to this browser only.</p>
      <div className="share-actions">
        <label className="button">
          Choose files
          <input type="file" multiple onChange={(event) => { void stage(event.target.files); event.target.value = ''; }} />
        </label>
        {folderOk ? (
          <label className="button">
            Choose folder
            <input
              type="file"
              multiple
              ref={(node) => { if (node) node.setAttribute('webkitdirectory', ''); }}
              onChange={(event) => { void stage(event.target.files); event.target.value = ''; }}
            />
          </label>
        ) : (
          <p className="meta">This browser cannot choose a whole folder. Use Choose files instead.</p>
        )}
      </div>
      {message ? <p className="banner ok" role="status">{message}</p> : null}
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {busy ? (
        <p className="status" role="status">
          {busy}{' '}
          {busy.startsWith('Receiving ') ? <button type="button" className="ghost" onClick={cancelDirect}>Cancel</button> : null}
        </p>
      ) : null}

      {preview ? (
        <div className="share-preview">
          <h3>Check before sharing</h3>
          <label>
            Share name
            <input value={shareName} onChange={(event) => setShareName(event.target.value)} />
          </label>
          <fieldset>
            <legend>People who can download</legend>
            <p className="meta">Only the people you tick can download. These files stay in this browser and are not saved in the library. Someone who opens this page later is not included until you share again.</p>
            {people.length === 0 ? <p className="meta">No other browser has this page open right now.</p> : null}
            {people.map((person) => (
              <label key={person.peerId} className="check">
                <input
                  type="checkbox"
                  checked={chosenPeers.includes(person.peerId)}
                  onChange={(event) => {
                    setChosenPeers((current) => event.target.checked
                      ? [...current, person.peerId]
                      : current.filter((id) => id !== person.peerId));
                  }}
                />
                {person.displayName}
              </label>
            ))}
          </fieldset>
          {folderChosen ? <p className="meta">This is the folder as it is right now. Empty folders are left out. Files you add later are not included. The list shows names inside the share, not where they sit on your computer.</p> : <p className="meta">The list shows names inside the share, not where they sit on your computer.</p>}
          <ul className="share-tree">
            {preview.map((file) => (
              <li key={file.clientToken}>
                <span>{file.relativePath}</span>
                <span className="meta">{formatBytes(file.size)}{file.modifiedAt > 0 ? ` · ${new Date(file.modifiedAt).toLocaleString()}` : ''}</span>
              </li>
            ))}
          </ul>
          {rejected.length > 0 ? (
            <ul className="share-tree">
              {rejected.map((item) => (
                <li key={`${item.relativePath}:${item.reason}`}>
                  <span>{item.relativePath || 'A selected path'}</span>
                  <span className="meta">{explainRejected(item.reason)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="share-actions">
            <button type="button" disabled={Boolean(busy)} onClick={() => void confirmShare()}>Start sharing</button>
            <button type="button" className="ghost" onClick={() => { setPreview(null); setDrafts(null); }}>Cancel</button>
          </div>
        </div>
      ) : null}

      <h3>You are sharing</h3>
      {mine.length === 0 ? <p className="meta">You are not sharing anything from this tab.</p> : (
        <ul className="share-tree">
          {mine.map((share) => (
            <li key={share.id}>
              <button type="button" className="ghost" onClick={() => { setOpenId(share.id); setDir(''); setQuery(''); }}>{share.name}</button>
              <span className="meta">{share.fileCount} files · {formatBytes(share.sizeBytes)} · {share.available ? 'Ready' : 'Choose the files again'}</span>
              <button type="button" className="ghost danger" onClick={() => void revoke(share)}>Stop sharing</button>
            </li>
          ))}
        </ul>
      )}

      <h3>Who is here</h3>
      <p className="meta">{browsersHere(people.map((person) => person.displayName))}</p>
      {others.length === 0 ? <p className="meta">Nobody else is sharing files you can open.</p> : (
        <ul className="share-tree">
          {others.map((share) => (
            <li key={share.id}>
              <button type="button" className="ghost" onClick={() => { setOpenId(share.id); setDir(''); setQuery(''); }}>{share.ownerName}: {share.name}</button>
              <span className={share.available ? 'meta' : 'unavailable'}>{share.available ? `${share.fileCount} files` : 'Not available. Ask them to open the files again.'}</span>
            </li>
          ))}
        </ul>
      )}

      {listing ? (
        <div>
          <h3>{listing.share.name}</h3>
          {!listing.share.available ? <p className="unavailable">These files are not available until the sender chooses them again in an open tab.</p> : null}
          <nav className="crumbs" aria-label="Folder">
            <button type="button" className="ghost" onClick={() => setDir('')}>Top</button>
            {listing.breadcrumbs.map((crumb) => (
              <button type="button" className="ghost" key={crumb.path} onClick={() => setDir(crumb.path)}>{crumb.name}</button>
            ))}
          </nav>
          <label>
            Search this share
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search file names" />
          </label>
          {listing.share.available ? (
            <div className="share-actions">
              {listing.search ? null : (
                <a className="button" href={relayZipUrl(listing.share.id, dir)} onClick={(event) => void startRelay(event)}>Download this folder</a>
              )}
              {picked.length > 0 ? <a className="button" href={relayZipUrl(listing.share.id, '', picked)} onClick={(event) => void startRelay(event)}>Download selected</a> : null}
              <p className="meta">A folder is sent as a zip and is not kept on this computer. This page shows bytes sent, not a saved file.</p>
            </div>
          ) : null}
          <ul className="share-tree">
            {listing.folders.map((folder) => (
              <li key={folder.path}>
                <button type="button" className="ghost" onClick={() => { setDir(folder.path); setQuery(''); }}>{folder.name}</button>
                <span className="meta">{folder.fileCount} items</span>
              </li>
            ))}
            {listing.files.map((file) => (
              <li key={file.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={picked.includes(file.id)}
                    onChange={(event) => setPicked((current) => event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id))}
                  />
                  {file.relativePath.split('/').pop()}
                </label>
                <span className="meta">{formatBytes(file.size)}</span>
                {listing.share.available && !listing.share.mine && directShareAvailable(file.size) ? (
                  <button type="button" onClick={() => void takeDirect(listing.share, file)}>Download from their browser</button>
                ) : null}
                {listing.share.available ? (
                  <a href={relayFileUrl(listing.share.id, file.id)} onClick={(event) => void startRelay(event)}>Download</a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
    <dialog
      ref={helpRef}
      className="library-dialog"
      aria-labelledby="connection-help-title"
      onClose={() => setHelpOpen(false)}
    >
      <h2 id="connection-help-title">Connection details</h2>
      <p>This page checks for other browsers about every couple of seconds. A successful check does not mean a file is being shared. These details do not include passwords or file contents.</p>
      <dl className="connection-status">
        <div><dt>Build</dt><dd>{__PORTAL_BUILD__}</dd></div>
        <div><dt>Last successful check</dt><dd>{polledAt ? new Date(polledAt).toLocaleString() : 'None'}</dd></div>
        <div><dt>This browser</dt><dd>{selfId ? 'Checked in' : 'Not checked in'}</dd></div>
        <div><dt>Other browsers</dt><dd>{people.length === 0 ? 'None' : people.map((person) => person.displayName).join(', ')}</dd></div>
        <div><dt>Shares with files still open</dt><dd>{sharesReady}. This counts shares, not files or computers.</dd></div>
        <div><dt>Browser-to-browser download</dt><dd>{directAvailable ? 'Available for a single file up to 32 MB when you choose it.' : 'Not available on this address. A secure address (https) is required. Use Download.'}</dd></div>
        <div><dt>Transfer</dt><dd>{transferLabel(transferMode)}</dd></div>
      </dl>
      <label>
        Details for support
        <textarea ref={detailsRef} readOnly value={details} rows={8} />
      </label>
      <div className="actions">
        <button type="button" onClick={copyDetails}>Copy details for support</button>
        <button type="button" className="ghost" onClick={() => helpRef.current?.close()}>Close</button>
      </div>
      {copyNote ? <p className="meta" role="status">{copyNote}</p> : null}
    </dialog>
    </>
  );
}

function chosenPath(file: File): string {
  const named = file as File & { webkitRelativePath?: string };
  return named.webkitRelativePath || file.name;
}
