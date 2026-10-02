import { useEffect, useId, useRef, useState } from 'react';
import {
  ApiError,
  deleteFile,
  getSession,
  listFiles,
  login,
  logout,
  uploadFile,
  type FileList,
  type PortalFile,
  type Session,
} from './api';
import { formatBytes, formatWhen } from './format';

type SortValue = 'date:desc' | 'date:asc' | 'name:asc' | 'name:desc' | 'size:desc' | 'size:asc';

type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'canceled';

type UploadItem = {
  id: string;
  file: File;
  progress: number;
  status: UploadStatus;
  message: string;
};

const SORTS: Array<{ value: SortValue; label: string }> = [
  { value: 'date:desc', label: 'Newest' },
  { value: 'date:asc', label: 'Oldest' },
  { value: 'name:asc', label: 'Name A–Z' },
  { value: 'name:desc', label: 'Name Z–A' },
  { value: 'size:desc', label: 'Largest' },
  { value: 'size:asc', label: 'Smallest' },
];

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    getSession()
      .then((next) => {
        if (active) setSession(next);
      })
      .catch(() => {
        if (active) setSession(null);
      });
    return () => {
      active = false;
    };
  }, []);

  if (session === undefined) {
    return (
      <main className="gate">
        <p className="status" role="status">Checking your session…</p>
      </main>
    );
  }

  if (!session) return <Login onSuccess={setSession} />;
  return <Dashboard session={session} onSession={setSession} />;
}

function Login({ onSuccess }: { onSuccess: (session: Session) => void }) {
  const usernameId = useId();
  const passwordId = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSuccess(await login(username, password));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <form className="card login" onSubmit={submit}>
        <p className="eyebrow">Local file portal</p>
        <h1>Sign in</h1>
        <p className="lede">Files stay on this computer. Use the account created for you on the server.</p>
        {error ? <p className="banner error" role="alert">{error}</p> : null}
        <label htmlFor={usernameId}>Username</label>
        <input
          id={usernameId}
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
        <label htmlFor={passwordId}>Password</label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}

function Dashboard({
  session,
  onSession,
}: {
  session: Session;
  onSession: (session: Session | null) => void;
}) {
  const [sort, setSort] = useState<SortValue>('date:desc');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [listing, setListing] = useState<FileList | null>(null);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const started = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());
  const csrf = session.csrfToken;

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const block = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  async function refresh() {
    const [sortKey, order] = sort.split(':') as [string, string];
    setLoading(true);
    try {
      const next = await listFiles(search, sortKey, order);
      setListing(next);
      setListError('');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onSession(null);
        return;
      }
      setListError(caught instanceof ApiError ? caught.message : 'The file list could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // refresh is recreated each render; the query values are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sort, csrf]);

  useEffect(() => {
    const room = 3 - uploads.filter((item) => item.status === 'uploading').length;
    if (room <= 0) return;
    const waiting = uploads.filter((item) => item.status === 'queued' && !started.current.has(item.id)).slice(0, room);
    if (waiting.length === 0) return;
    for (const item of waiting) started.current.add(item.id);
    setUploads((current) => current.map((item) => (
      waiting.some((start) => start.id === item.id) ? { ...item, status: 'uploading' } : item
    )));
    for (const item of waiting) void runUpload(item);
  }, [uploads, csrf]);

  async function runUpload(item: UploadItem) {
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    try {
      await uploadFile(item.file, csrf, (loaded, total) => {
        const progress = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        setUploads((current) => current.map((entry) => (
          entry.id === item.id ? { ...entry, progress } : entry
        )));
      }, controller.signal);
      setUploads((current) => current.map((entry) => (
        entry.id === item.id ? { ...entry, status: 'done', progress: 100, message: 'Uploaded' } : entry
      )));
      setBanner(`Uploaded ${item.file.name}`);
      await refresh();
    } catch (caught) {
      const canceled = caught instanceof ApiError && caught.message === 'Upload canceled.';
      setUploads((current) => current.map((entry) => (
        entry.id === item.id
          ? {
            ...entry,
            status: canceled ? 'canceled' : 'error',
            message: canceled ? 'Canceled' : (caught instanceof Error ? caught.message : 'Upload failed.'),
          }
          : entry
      )));
    } finally {
      controllers.current.delete(item.id);
    }
  }

  function addFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList as ArrayLike<File>);
    if (incoming.length === 0) return;
    const next: UploadItem[] = incoming.map((file) => {
      const tooBig = file.size > session.limits.maxFileBytes;
      return {
        id: crypto.randomUUID(),
        file,
        progress: 0,
        status: tooBig ? 'error' : 'queued',
        message: tooBig ? `Each file must be ${formatBytes(session.limits.maxFileBytes)} or smaller.` : 'Waiting',
      };
    });
    setUploads((current) => [...next, ...current]);
    setBanner('');
  }

  function cancelUpload(id: string) {
    const controller = controllers.current.get(id);
    if (controller) controller.abort();
    setUploads((current) => current.map((item) => (
      item.id === id && (item.status === 'queued' || item.status === 'uploading')
        ? { ...item, status: 'canceled', message: 'Canceled' }
        : item
    )));
    started.current.add(id);
  }

  async function signOut() {
    try {
      await logout(csrf);
    } finally {
      onSession(null);
    }
  }

  const storage = listing?.storage;
  const ratio = storage && storage.limitBytes > 0 ? Math.min(1, storage.usedBytes / storage.limitBytes) : 0;

  return (
    <div className="shell">
      <header className="top">
        <div>
          <p className="eyebrow">Local file portal</p>
          <h1>Shared files</h1>
        </div>
        <div className="who">
          <span>{session.user.username}</span>
          <button type="button" className="ghost" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>

      <section className="storage" aria-label="Storage">
        <div className="storage-copy">
          <strong>{storage ? `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.limitBytes)} used` : 'Checking storage…'}</strong>
          <span>Up to {formatBytes(session.limits.maxFileBytes)} per file</span>
        </div>
        <progress max={100} value={Math.round(ratio * 100)} className={ratio >= 0.9 ? 'tight' : undefined} />
      </section>

      <UploadZone
        onFiles={addFiles}
        uploads={uploads}
        onCancel={cancelUpload}
        onClear={() => setUploads((current) => current.filter((item) => item.status === 'queued' || item.status === 'uploading'))}
      />

      {banner ? <p className="banner ok" role="status">{banner}</p> : null}
      {listError ? <p className="banner error" role="alert">{listError}</p> : null}

      <section className="panel">
        <div className="toolbar">
          <label>
            Search
            <input
              type="search"
              value={searchInput}
              placeholder="Filename"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </label>
          <label>
            Sort
            <select value={sort} onChange={(event) => setSort(event.target.value as SortValue)}>
              {SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <FileTable
          files={listing?.files ?? []}
          loading={loading}
          searching={search.length > 0}
          csrfToken={csrf}
          onChanged={refresh}
          onError={setListError}
        />
      </section>
    </div>
  );
}

function UploadZone({
  onFiles,
  uploads,
  onCancel,
  onClear,
}: {
  onFiles: (files: File[]) => void;
  uploads: UploadItem[];
  onCancel: (id: string) => void;
  onClear: () => void;
}) {
  const inputId = useId();
  const [hot, setHot] = useState(false);
  const finished = uploads.some((item) => item.status === 'done' || item.status === 'error' || item.status === 'canceled');

  return (
    <section className="panel">
      <div
        className={hot ? 'drop hot' : 'drop'}
        onDragOver={(event) => {
          event.preventDefault();
          setHot(true);
        }}
        onDragLeave={() => setHot(false)}
        onDrop={(event) => {
          event.preventDefault();
          setHot(false);
          onFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <div>
          <h2>Upload</h2>
          <p>Drop files here, or choose them. Folders are not uploaded.</p>
        </div>
        <label className="button" htmlFor={inputId}>Choose files</label>
        <input
          id={inputId}
          type="file"
          multiple
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>
      {uploads.length > 0 ? (
        <div className="queue">
          <div className="queue-head">
            <h3>Transfers</h3>
            {finished ? <button type="button" className="ghost" onClick={onClear}>Clear finished</button> : null}
          </div>
          <ul>
            {uploads.map((item) => (
              <li key={item.id}>
                <div className="queue-row">
                  <span className="filename">{item.file.name}</span>
                  <span className="meta">{formatBytes(item.file.size)}</span>
                  {item.status === 'queued' || item.status === 'uploading' ? (
                    <button type="button" className="ghost" onClick={() => onCancel(item.id)}>Cancel</button>
                  ) : (
                    <span className={`pill ${item.status}`}>{item.message}</span>
                  )}
                </div>
                {item.status === 'uploading' || item.status === 'queued' ? (
                  <div
                    className="bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={item.progress}
                    aria-label={`Upload progress for ${item.file.name}`}
                  >
                    <span style={{ width: `${item.status === 'queued' ? 0 : item.progress}%` }} />
                  </div>
                ) : null}
                {item.status === 'error' ? <p className="fail" role="alert">{item.message}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function FileTable({
  files,
  loading,
  searching,
  csrfToken,
  onChanged,
  onError,
}: {
  files: PortalFile[];
  loading: boolean;
  searching: boolean;
  csrfToken: string;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function confirmDelete(file: PortalFile) {
    setDeleting(file.id);
    onError('');
    try {
      await deleteFile(file.id, csrfToken);
      setPendingDelete(null);
      await onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'The file could not be deleted.');
    } finally {
      setDeleting(null);
    }
  }

  if (loading && files.length === 0) {
    return <p className="status" role="status">Loading files…</p>;
  }
  if (!loading && files.length === 0) {
    return (
      <p className="status">
        {searching ? 'No files match that search.' : 'No files yet. Upload the first one.'}
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <caption>You can delete files you uploaded. Anyone signed in can download.</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Size</th>
            <th scope="col">Uploaded</th>
            <th scope="col">By</th>
            <th scope="col"><span className="sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.id}>
              <td className="filename">{file.originalName}</td>
              <td>{formatBytes(file.sizeBytes)}</td>
              <td>{formatWhen(file.createdAt)}</td>
              <td>{file.ownerUsername}</td>
              <td className="actions">
                <a href={`/api/files/${encodeURIComponent(file.id)}/download`}>Download</a>
                {file.canDelete && pendingDelete !== file.id ? (
                  <button type="button" className="ghost danger" onClick={() => setPendingDelete(file.id)}>Delete</button>
                ) : null}
                {file.canDelete && pendingDelete === file.id ? (
                  <>
                    <span>Delete this file?</span>
                    <button type="button" className="danger" disabled={deleting === file.id} onClick={() => void confirmDelete(file)}>
                      {deleting === file.id ? 'Deleting…' : 'Delete'}
                    </button>
                    <button type="button" className="ghost" onClick={() => setPendingDelete(null)}>Keep</button>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
