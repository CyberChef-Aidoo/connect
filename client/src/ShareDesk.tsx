import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { randomId } from './randomId';
import { formatBytes } from './format';
import { createShareDirect, directShareAvailable } from './shareDirect';
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
  const direct = useRef(createShareDirect((id) => filesRef.current.get(id)));
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
  const [busy, setBusy] = useState('');
  const [selfId, setSelfId] = useState('');
  const [apiState, setApiState] = useState('Checking…');
  const [signalState, setSignalState] = useState('Connecting…');
  const [transferMode, setTransferMode] = useState('Idle');
  const [polledAt, setPolledAt] = useState<number | null>(null);
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
          setApiState('Reachable');
          setSignalState('HTTP connected');
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
            try {
              await sendSharedBytes(job.id, job.nextFileId, file, csrf);
            } catch {
              // The next poll retries while the download is still waiting.
            } finally {
              sending.current.delete(key);
            }
          }
        } catch (caught) {
          if (stop) return;
          const reason = caught instanceof Error ? caught.message : 'The portal could not be reached.';
          if (caught instanceof TypeError) {
            setApiState('Unreachable');
            setSignalState('Not connected');
          } else {
            setApiState('Reachable');
            setSignalState(caught instanceof ApiError && caught.status === 401 ? 'Session was not sent' : 'Not connected');
          }
          setError(reason);
          console.info('portal connection', { api: caught instanceof TypeError ? 'unreachable' : 'error', detail: reason });
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
      if (!stop) setError(caught instanceof Error ? caught.message : 'That share could not be opened.');
    });
    return () => { stop = true; };
  }, [openId, dir, query, shares]);

  useEffect(() => {
    setPicked([]);
  }, [openId, dir]);

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
      setError(caught instanceof Error ? caught.message : 'Those files could not be previewed.');
    }
  }

  async function confirmShare() {
    if (!preview || !drafts) return;
    setBusy('Publishing…');
    setError('');
    try {
      const published = await publishShare(shareName, chosenPeers, preview, csrf);
      for (const file of published.files) {
        const draft = drafts.find((item) => item.clientToken === file.clientToken);
        if (draft) filesRef.current.set(file.id, draft.file);
      }
      setDrafts(null);
      setPreview(null);
      setMessage(`“${published.share.name}” is visible to the people you chose. Keep this tab open. Reloading asks you to select the files again.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The share could not be published.');
    } finally {
      setBusy('');
    }
  }

  async function revoke(share: ShareSummary) {
    const agreed = window.confirm('Stop new downloads of this share? People who already received a file keep that copy. It cannot be recalled.');
    if (!agreed) return;
    try {
      const note = await revokeShare(share.id, csrf);
      if (openId === share.id) setOpenId(null);
      setMessage(note);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The share could not be revoked.');
    }
  }

  function cancelDirect() {
    directAbort.current?.abort();
  }

  async function takeDirect(share: ShareSummary, file: ListedFile) {
    directAbort.current?.abort();
    const controller = new AbortController();
    directAbort.current = controller;
    const label = file.relativePath.split('/').pop() ?? 'download';
    setBusy(`Receiving ${label}…`);
    setTransferMode('Direct');
    setError('');
    console.info('portal transfer', { share: share.id, file: file.id, mode: 'direct' });
    try {
      const blob = await direct.current.receive(share.id, file.id, share.ownerPeerId, csrf, {
        signal: controller.signal,
        onProgress: (received, total) => setBusy(`Receiving ${label}: ${formatBytes(received)} of ${formatBytes(total)}`),
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.relativePath.split('/').pop() ?? 'download';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage(`Received ${link.download} directly from their browser.`);
      setTransferMode('Idle');
    } catch (caught) {
      setTransferMode('Relay');
      setError(caught instanceof Error ? caught.message : 'Direct download is not available. Use Download through this computer.');
      console.info('portal transfer', { share: share.id, file: file.id, mode: 'direct', result: 'failed' });
    } finally {
      setBusy('');
    }
  }

  async function startRelay(event: { preventDefault: () => void; currentTarget: HTMLAnchorElement }) {
    event.preventDefault();
    const href = event.currentTarget.href;
    setTransferMode('Relay');
    setError('');
    try {
      await confirmRelay(href);
      console.info('portal transfer', { mode: 'relay', url: new URL(href).pathname });
      const link = document.createElement('a');
      link.href = href;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setMessage('Downloading through this computer. Progress is in the browser’s download list. Cancel it there to stop the transfer.');
    } catch (caught) {
      setTransferMode('Idle');
      setError(caught instanceof Error ? caught.message : 'That download is not available.');
    }
  }

  const mine = shares.filter((share) => share.mine && !share.revoked);
  const others = shares.filter((share) => !share.mine && !share.revoked);

  const sources = shares.filter((share) => share.available && !share.revoked).length;
  const status = (
    <dl className="connection-status">
      <div><dt>Build</dt><dd>{__PORTAL_BUILD__}</dd></div>
      <div><dt>API</dt><dd>{apiState}</dd></div>
      <div><dt>Signaling</dt><dd>{signalState}</dd></div>
      <div><dt>Session</dt><dd>{selfId ? 'Registered' : 'Not registered'}</dd></div>
      <div><dt>Last poll</dt><dd>{polledAt ? new Date(polledAt).toLocaleTimeString() : 'None'}</dd></div>
      <div><dt>Peers</dt><dd>{people.length}{people.length > 0 ? `: ${people.map((person) => person.displayName).join(', ')}` : ''}</dd></div>
      <div><dt>Sources</dt><dd>{sources} available</dd></div>
      <div><dt>Transfer</dt><dd>{transferMode}{typeof window !== 'undefined' && window.isSecureContext ? '' : ' · direct needs HTTPS'}</dd></div>
    </dl>
  );

  return (
    <>
    {hidden ? <section className="panel" aria-label="Connection">{status}</section> : null}
    <section className="panel share-desk" hidden={hidden}>
      <h2>Read-only shares</h2>
      <p>
        Share only the files you select. A folder is the selection at that moment, not a folder that is watched.
        Empty folders may be left out, and files added later are not included. Keep this browser tab open.
        Switching to Library does not stop a share. Reloading or closing the tab does, until you select the files again.
        Nothing here can be edited or deleted on the other computer. A copy someone already received cannot be recalled.
      </p>
      {hidden ? null : status}
      <label className="share-name">
        Your name on this network
        <input value={nameOnNetwork} onChange={(event) => rememberName(event.target.value)} />
      </label>
      <div className="share-actions">
        <label className="button">
          Share files
          <input type="file" multiple onChange={(event) => { void stage(event.target.files); event.target.value = ''; }} />
        </label>
        {folderOk ? (
          <label className="button">
            Share folder
            <input
              type="file"
              multiple
              ref={(node) => { if (node) node.setAttribute('webkitdirectory', ''); }}
              onChange={(event) => { void stage(event.target.files); event.target.value = ''; }}
            />
          </label>
        ) : (
          <p className="meta">This browser cannot select a folder. Share files chooses one or more files instead.</p>
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
          <h3>This is exactly what will be published</h3>
          <label>
            Share name
            <input value={shareName} onChange={(event) => setShareName(event.target.value)} />
          </label>
          <fieldset>
            <legend>People who may download</legend>
            <p className="meta">Only the people you tick can download. Someone who opens the portal later is not included until you publish again.</p>
            {people.length === 0 ? <p className="meta">Nobody else has this portal open right now.</p> : null}
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
          <p className="meta">Empty folders are left out. These paths are inside the share. The page does not show where they sit on your computer.</p>
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
                  <span className="meta">{item.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="share-actions">
            <button type="button" disabled={Boolean(busy)} onClick={() => void confirmShare()}>Publish share</button>
            <button type="button" className="ghost" onClick={() => { setPreview(null); setDrafts(null); }}>Cancel</button>
          </div>
        </div>
      ) : null}

      <h3>Your published shares</h3>
      {mine.length === 0 ? <p className="meta">Nothing is published from this tab.</p> : (
        <ul className="share-tree">
          {mine.map((share) => (
            <li key={share.id}>
              <button type="button" className="ghost" onClick={() => { setOpenId(share.id); setDir(''); setQuery(''); }}>{share.name}</button>
              <span className="meta">{share.fileCount} files · {formatBytes(share.sizeBytes)} · {share.available ? 'Open' : 'Unavailable'}</span>
              <button type="button" className="ghost danger" onClick={() => void revoke(share)}>Revoke</button>
            </li>
          ))}
        </ul>
      )}

      <h3>People here</h3>
      <p className="meta">{people.length === 0 ? 'No other browser is connected yet.' : `Connected: ${people.map((person) => person.displayName).join(', ')}.`}</p>
      {others.length === 0 ? <p className="meta">No one else is publishing a share you can open.</p> : (
        <ul className="share-tree">
          {others.map((share) => (
            <li key={share.id}>
              <button type="button" className="ghost" onClick={() => { setOpenId(share.id); setDir(''); setQuery(''); }}>{share.ownerName}: {share.name}</button>
              <span className={share.available ? 'meta' : 'unavailable'}>{share.available ? `${share.fileCount} files` : 'Unavailable. Their tab is closed.'}</span>
            </li>
          ))}
        </ul>
      )}

      {listing ? (
        <div>
          <h3>{listing.share.name}</h3>
          {!listing.share.available ? <p className="unavailable">This share is unavailable until the sender selects the files again in an open tab.</p> : null}
          <nav className="crumbs" aria-label="Folder">
            <button type="button" className="ghost" onClick={() => setDir('')}>Top</button>
            {listing.breadcrumbs.map((crumb) => (
              <button type="button" className="ghost" key={crumb.path} onClick={() => setDir(crumb.path)}>{crumb.name}</button>
            ))}
          </nav>
          <label>
            Search this share
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="File or folder name" />
          </label>
          {listing.share.available ? (
            <div className="share-actions">
              {listing.search ? null : (
                <a className="button" href={relayZipUrl(listing.share.id, dir)} onClick={(event) => void startRelay(event)}>Download this folder through this computer</a>
              )}
              {picked.length > 0 ? <a className="button" href={relayZipUrl(listing.share.id, '', picked)} onClick={(event) => void startRelay(event)}>Download selected through this computer</a> : null}
              <p className="meta">Download through this computer uses the browser’s download list. That list shows progress, and canceling it stops the transfer. A folder is packed as a zip as it is sent. The portal does not keep the zip.</p>
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
                  <button type="button" onClick={() => void takeDirect(listing.share, file)}>Direct download</button>
                ) : null}
                {listing.share.available ? (
                  <a href={relayFileUrl(listing.share.id, file.id)} onClick={(event) => void startRelay(event)}>Download through this computer</a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
    </>
  );
}

function chosenPath(file: File): string {
  const named = file as File & { webkitRelativePath?: string };
  return named.webkitRelativePath || file.name;
}
