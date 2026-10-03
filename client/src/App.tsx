import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  addToCollection,
  ApiError,
  createCollection,
  createFolder,
  deleteCollection,
  deleteFile,
  deleteFiles,
  deleteFolder,
  deleteUpload,
  detachTag,
  ensureFolder,
  getSession,
  listCollections,
  listFiles,
  listTags,
  listUploads,
  login,
  logout,
  moveFiles,
  removeFromCollection,
  renameCollection,
  renameFolder,
  setFavorite,
  tagFiles,
  uploadFile,
  zipUrl,
  type Breadcrumb,
  type CollectionItem,
  type FileList,
  type FolderItem,
  type PortalFile,
  type Session,
  type TagItem,
  type UploadSession,
} from './api';
import { folderPlacement, readDataTransfer, type PlannedUpload } from './folderUpload';
import { formatBytes, formatWhen } from './format';
import { selectionMatchesSession } from './resumeMatch';
import { formatRemaining, formatSpeed, rememberSample, transferView, type TransferSample } from './transfer';

type SortValue = 'date:desc' | 'date:asc' | 'name:asc' | 'name:desc' | 'size:desc' | 'size:asc';

type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'canceled';

type UploadItem = {
  id: string;
  attempt: number;
  file: File;
  sessionId: string | null;
  folderId: string | null;
  loaded: number;
  total: number;
  progress: number;
  status: UploadStatus;
  message: string;
  samples: TransferSample[];
  bytesPerSecond: number | null;
  remainingMs: number | null;
  stalled: boolean;
};

const ABANDONED_UPLOADS = 'portal-abandoned-uploads';
const THEME_KEY = 'portal-theme';
const CONCURRENCY_KEY = 'portal-upload-concurrency';
const VIEW_KEY = 'portal-view';
const PAGE_SIZE = 24;

const SORTS: Array<{ value: SortValue; label: string }> = [
  { value: 'date:desc', label: 'Newest' },
  { value: 'date:asc', label: 'Oldest' },
  { value: 'name:asc', label: 'Name A–Z' },
  { value: 'name:desc', label: 'Name Z–A' },
  { value: 'size:desc', label: 'Largest' },
  { value: 'size:asc', label: 'Smallest' },
];

export function App() {
  const theme = useTheme();
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
        <ThemeButton theme={theme} floating />
        <p className="status" role="status">Checking your session…</p>
      </main>
    );
  }

  if (!session) return <Login theme={theme} onSuccess={setSession} />;
  return <Dashboard theme={theme} session={session} onSession={setSession} />;
}

function useTheme(): { mode: 'light' | 'dark'; toggle: () => void } {
  const [mode, setMode] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    localStorage.setItem(THEME_KEY, mode);
  }, [mode]);
  return { mode, toggle: () => setMode((current) => (current === 'dark' ? 'light' : 'dark')) };
}

function ThemeButton({ theme, floating = false }: { theme: { mode: 'light' | 'dark'; toggle: () => void }; floating?: boolean }) {
  const next = theme.mode === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className={floating ? 'ghost theme-toggle' : 'ghost'} onClick={theme.toggle} aria-pressed={theme.mode === 'dark'}>
      {next === 'dark' ? 'Dark theme' : 'Light theme'}
    </button>
  );
}

function Login({ onSuccess, theme }: { onSuccess: (session: Session) => void; theme: { mode: 'light' | 'dark'; toggle: () => void } }) {
  const usernameId = useId();
  const passwordId = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
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
      <ThemeButton theme={theme} floating />
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
  theme,
}: {
  session: Session;
  onSession: (session: Session | null) => void;
  theme: { mode: 'light' | 'dark'; toggle: () => void };
}) {
  const [sort, setSort] = useState<SortValue>('date:desc');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [listing, setListing] = useState<FileList | null>(null);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState('');
  const [abandonedNote, setAbandonedNote] = useState('');
  const [pending, setPending] = useState<UploadSession[]>([]);
  const [resumeError, setResumeError] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [view, setView] = useState<'list' | 'grid'>(readView);
  const [folderDraft, setFolderDraft] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [tagId, setTagId] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [tags, setTags] = useState<TagItem[]>([]);
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [collectionDraft, setCollectionDraft] = useState('');
  const [bulkCollectionId, setBulkCollectionId] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [concurrency, setConcurrency] = useState(() => readConcurrency(session.uploads.maxPerUser));
  const started = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());
  const csrf = session.csrfToken;
  const pageCap = Math.max(1, Math.min(3, session.uploads.maxPerUser));
  const statusSummary = uploads.map((item) => `${item.id}:${item.status}`).join('|');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setCursor(null);
      setCursorStack([]);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (sessionStorage.getItem(ABANDONED_UPLOADS) === '1') {
      sessionStorage.removeItem(ABANDONED_UPLOADS);
      setAbandonedNote('An upload was still running when you left. Choose the same file below to continue it. Progress already saved on this computer is kept for 24 hours.');
    }
  }, []);

  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!uploads.some((item) => item.status === 'uploading' || item.status === 'queued')) return;
      sessionStorage.setItem(ABANDONED_UPLOADS, '1');
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [uploads]);

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
      const filters = {
        favorite: favoriteOnly,
        tagId: tagId || undefined,
        collectionId: collectionId || undefined,
      };
      const [next, tagList, collectionList] = await Promise.all([
        listFiles(search, sortKey, order, folderId, cursor, PAGE_SIZE, filters),
        listTags(),
        listCollections(),
      ]);
      setListing(next);
      setTags(tagList.tags);
      setCollections(collectionList.collections);
      setListError('');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onSession(null);
        return;
      }
      if (caught instanceof ApiError && caught.status === 404 && (folderId || tagId || collectionId)) {
        if (folderId) setFolderId(null);
        if (tagId) setTagId('');
        if (collectionId) setCollectionId('');
        setCursor(null);
        setCursorStack([]);
      }
      setListError(caught instanceof ApiError ? caught.message : 'The file list could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  async function loadPending() {
    try {
      const next = await listUploads();
      setPending(next.sessions);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) onSession(null);
    }
  }

  async function discardSession(sessionId: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await deleteUpload(sessionId, csrf);
        break;
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 404) break;
        if (caught instanceof ApiError && caught.status === 409 && attempt < 4) {
          await new Promise((resolve) => window.setTimeout(resolve, 150));
          continue;
        }
        break;
      }
    }
    await loadPending();
  }

  useEffect(() => {
    void refresh();
    // refresh is recreated each render; the query values are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sort, csrf, folderId, cursor, favoriteOnly, tagId, collectionId]);

  useEffect(() => {
    void loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csrf]);

  useEffect(() => {
    if (!uploads.some((item) => item.status === 'uploading')) return undefined;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setUploads((current) => current.map((entry) => {
        if (entry.status !== 'uploading') return entry;
        const view = transferView({
          loaded: entry.loaded,
          total: entry.total,
          now,
          samples: entry.samples,
          active: true,
        });
        return { ...entry, progress: view.progress, bytesPerSecond: view.bytesPerSecond, remainingMs: view.remainingMs, stalled: view.stalled };
      }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [statusSummary]);

  useEffect(() => {
    const room = Math.min(concurrency, pageCap) - uploads.filter((item) => item.status === 'uploading').length;
    if (room <= 0) return;
    const waiting = uploads.filter((item) => item.status === 'queued' && !started.current.has(item.id)).slice(0, room);
    if (waiting.length === 0) return;
    for (const item of waiting) started.current.add(item.id);
    setUploads((current) => current.map((item) => (
      waiting.some((start) => start.id === item.id) ? { ...item, status: 'uploading' } : item
    )));
    for (const item of waiting) void runUpload(item);
  }, [uploads, csrf, concurrency, pageCap]);

  function patchUpload(id: string, attempt: number, recipe: (entry: UploadItem) => UploadItem) {
    setUploads((current) => current.map((entry) => (
      entry.id === id && entry.attempt === attempt && entry.status !== 'canceled' ? recipe(entry) : entry
    )));
  }

  async function runUpload(item: UploadItem) {
    const attempt = item.attempt;
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    const startedAt = Date.now();
    patchUpload(item.id, attempt, (entry) => ({
      ...entry,
      samples: [{ at: startedAt, loaded: item.loaded }],
    }));
    try {
      await uploadFile(item.file, csrf, (loaded, total) => {
        const now = Date.now();
        patchUpload(item.id, attempt, (entry) => {
          const samples = rememberSample(entry.samples, { at: now, loaded });
          const view = transferView({ loaded, total, now, samples, active: true });
          return {
            ...entry,
            loaded,
            total,
            samples,
            progress: view.progress,
            bytesPerSecond: view.bytesPerSecond,
            remainingMs: view.remainingMs,
            stalled: view.stalled,
          };
        });
      }, controller.signal, {
        sessionId: item.sessionId,
        receivedBytes: item.sessionId ? item.loaded : 0,
        folderId: item.folderId,
        onSession: (sessionId) => {
          setUploads((current) => current.map((entry) => {
            if (entry.id !== item.id || entry.attempt !== attempt) return entry;
            if (entry.status === 'canceled') {
              void discardSession(sessionId);
              return entry;
            }
            return { ...entry, sessionId };
          }));
        },
      });
      patchUpload(item.id, attempt, (entry) => ({
        ...entry,
        status: 'done',
        progress: 100,
        loaded: entry.total || entry.file.size,
        message: 'Uploaded',
        stalled: false,
        remainingMs: null,
      }));
      setBanner(`Uploaded ${item.file.name}`);
      await refresh();
      await loadPending();
    } catch (caught) {
      const canceled = caught instanceof ApiError && caught.message === 'Upload canceled.';
      setUploads((current) => current.map((entry) => (
        entry.id === item.id && entry.attempt === attempt
          ? {
            ...entry,
            status: canceled ? 'canceled' : 'error',
            stalled: false,
            message: canceled ? 'Canceled' : (caught instanceof Error ? caught.message : 'Upload failed.'),
          }
          : entry
      )));
    } finally {
      controllers.current.delete(item.id);
    }
  }

  function addFiles(incoming: File[]) {
    queueUploads(incoming.map((file) => ({ file, folderId })));
  }

  async function addPlanned(incoming: PlannedUpload[]) {
    if (incoming.length === 0) return;
    const groups = new Map<string, { directories: string[]; files: File[] }>();
    for (const item of incoming) {
      const place = folderPlacement(item.relativePath || item.file.name);
      if (!place) continue;
      const key = place.directories.join('/');
      const group = groups.get(key) ?? { directories: place.directories, files: [] };
      group.files.push(item.file);
      groups.set(key, group);
    }
    const ready: Array<{ file: File; folderId: string | null }> = [];
    try {
      for (const group of groups.values()) {
        let target = folderId;
        if (group.directories.length > 0) {
          const ensured = await ensureFolder(group.directories.join('/'), folderId, csrf);
          target = ensured.folderId;
        }
        for (const file of group.files) ready.push({ file, folderId: target });
      }
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'The folders could not be created.');
      return;
    }
    queueUploads(ready);
    if (ready.length > 0) await refresh();
  }

  function queueUploads(incoming: Array<{ file: File; folderId: string | null }>) {
    if (incoming.length === 0) return;
    const next: UploadItem[] = incoming.map(({ file, folderId: target }) => {
      const tooBig = file.size > session.limits.maxFileBytes;
      return {
        id: crypto.randomUUID(),
        attempt: 1,
        file,
        sessionId: null,
        folderId: target,
        loaded: 0,
        total: file.size,
        progress: 0,
        status: tooBig ? 'error' : 'queued',
        message: tooBig ? `Each file must be ${formatBytes(session.limits.maxFileBytes)} or smaller.` : 'Waiting',
        samples: [],
        bytesPerSecond: null,
        remainingMs: null,
        stalled: false,
      };
    });
    setUploads((current) => [...next, ...current]);
    setBanner('');
  }

  function continueSession(upload: UploadSession, file: File) {
    const problem = selectionMatchesSession(file, upload);
    if (problem) {
      setResumeError(problem);
      return;
    }
    setResumeError('');
    const progress = file.size > 0 ? Math.min(100, Math.round((upload.receivedBytes / file.size) * 100)) : 0;
    setUploads((current) => [{
      id: crypto.randomUUID(),
      attempt: 1,
      file,
      sessionId: upload.id,
      folderId: null,
      loaded: upload.receivedBytes,
      total: file.size,
      progress,
      status: 'queued',
      message: 'Waiting',
      samples: [],
      bytesPerSecond: null,
      remainingMs: null,
      stalled: false,
    }, ...current]);
    setBanner('');
  }

  function cancelUpload(id: string) {
    const item = uploads.find((entry) => entry.id === id);
    const controller = controllers.current.get(id);
    if (controller) controller.abort();
    if (item?.sessionId) void discardSession(item.sessionId);
    setUploads((current) => current.map((entry) => (
      entry.id === id && (entry.status === 'queued' || entry.status === 'uploading')
        ? { ...entry, status: 'canceled', message: 'Canceled', sessionId: null }
        : entry
    )));
    started.current.add(id);
  }

  function retryUpload(id: string) {
    started.current.delete(id);
    controllers.current.get(id)?.abort();
    setUploads((current) => current.map((item) => {
      if (item.id !== id) return item;
      const keep = Boolean(item.sessionId);
      const progress = keep && item.total > 0 ? Math.min(100, Math.round((item.loaded / item.total) * 100)) : 0;
      return {
        ...item,
        attempt: item.attempt + 1,
        status: 'queued',
        message: 'Waiting',
        progress,
        loaded: keep ? item.loaded : 0,
        samples: [],
        bytesPerSecond: null,
        remainingMs: null,
        stalled: false,
      };
    }));
  }

  function openFolder(id: string | null) {
    setFolderId(id);
    setSearchInput('');
    setSearch('');
    setCursor(null);
    setCursorStack([]);
    setListError('');
  }

  function changeSort(value: SortValue) {
    setSort(value);
    resetPage();
  }

  function resetPage() {
    setCursor(null);
    setCursorStack([]);
  }

  function chooseFavorite(on: boolean) {
    setFavoriteOnly(on);
    resetPage();
  }

  function chooseTag(id: string) {
    setTagId(id);
    resetPage();
  }

  function chooseCollection(id: string) {
    setCollectionId(id);
    const match = collections.find((item) => item.id === id);
    setCollectionName(match?.name ?? '');
    resetPage();
  }

  function chooseView(next: 'list' | 'grid') {
    setView(next);
    localStorage.setItem(VIEW_KEY, next);
  }

  function showNext() {
    const next = listing?.page?.nextCursor;
    if (!next) return;
    setCursorStack((stack) => [...stack, cursor]);
    setCursor(next);
  }

  function showPrevious() {
    setCursorStack((stack) => {
      if (stack.length === 0) return stack;
      setCursor(stack[stack.length - 1] ?? null);
      return stack.slice(0, -1);
    });
  }

  function toggleSelected(id: string, checked: boolean) {
    setConfirmBulkDelete(false);
    setSelected((current) => (checked ? [...new Set([...current, id])] : current.filter((item) => item !== id)));
  }

  function togglePage(ids: string[], checked: boolean) {
    setConfirmBulkDelete(false);
    setSelected((current) => {
      if (checked) return [...new Set([...current, ...ids])];
      const drop = new Set(ids);
      return current.filter((id) => !drop.has(id));
    });
  }

  async function moveSelected() {
    if (selected.length === 0) return;
    if (selected.length > 100) {
      setListError('Choose 100 files or fewer at a time.');
      return;
    }
    setListError('');
    try {
      const result = await moveFiles(selected, folderId, csrf);
      setSelected((current) => current.filter((id) => !result.moved.includes(id)));
      const left = result.skipped.length;
      setBanner(left > 0
        ? `Moved ${result.moved.length}. Left ${left} that you did not upload.`
        : `Moved ${result.moved.length}.`);
      await refresh();
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'The files could not be moved.');
    }
  }

  async function deleteSelected() {
    if (selected.length === 0) return;
    if (selected.length > 100) {
      setListError('Choose 100 files or fewer at a time.');
      return;
    }
    setListError('');
    try {
      const result = await deleteFiles(selected, csrf);
      setSelected((current) => current.filter((id) => !result.deleted.includes(id)));
      setConfirmBulkDelete(false);
      const left = result.skipped.length;
      setBanner(left > 0
        ? `Deleted ${result.deleted.length}. Left ${left} that you did not upload.`
        : `Deleted ${result.deleted.length}.`);
      await refresh();
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'The files could not be deleted.');
    }
  }

  async function tagSelected() {
    if (selected.length === 0 || !tagDraft.trim()) return;
    if (selected.length > 100) {
      setListError('Choose 100 files or fewer at a time.');
      return;
    }
    setListError('');
    try {
      await tagFiles(selected, tagDraft, csrf);
      setTagDraft('');
      setBanner('Tag saved.');
      await refresh();
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'The tag could not be saved.');
    }
  }

  async function collectSelected() {
    if (selected.length === 0 || !bulkCollectionId) return;
    if (selected.length > 100) {
      setListError('Choose 100 files or fewer at a time.');
      return;
    }
    setListError('');
    try {
      await addToCollection(bulkCollectionId, selected, csrf);
      setBanner('Added to the collection.');
      await refresh();
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'The files could not be added to the collection.');
    }
  }

  async function makeCollection(event: FormEvent) {
    event.preventDefault();
    if (!collectionDraft.trim()) return;
    setListError('');
    try {
      const created = await createCollection(collectionDraft, csrf);
      setCollectionDraft('');
      setCollectionId(created.id);
      setCollectionName(created.name);
      resetPage();
      setBanner(`Collection “${created.name}” created.`);
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'The collection could not be created.');
    }
  }

  async function saveCollectionName(event: FormEvent) {
    event.preventDefault();
    if (!collectionId || !collectionName.trim()) return;
    setListError('');
    try {
      await renameCollection(collectionId, collectionName, csrf);
      setBanner('Collection renamed.');
      await refresh();
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'The collection could not be renamed.');
    }
  }

  async function removeCollection() {
    if (!collectionId) return;
    setListError('');
    try {
      await deleteCollection(collectionId, csrf);
      setCollectionId('');
      setCollectionName('');
      resetPage();
      setBanner('Collection deleted. The files are still in the portal.');
      await refresh();
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'The collection could not be deleted.');
    }
  }

  async function makeFolder(name: string) {
    setListError('');
    try {
      await createFolder(name, folderId, csrf);
      setFolderDraft('');
      setBanner(`Created folder ${name.trim()}`);
      await refresh();
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'The folder could not be created.');
    }
  }

  function changeConcurrency(value: number) {
    const next = Math.max(1, Math.min(pageCap, value));
    setConcurrency(next);
    localStorage.setItem(CONCURRENCY_KEY, String(next));
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
          <ThemeButton theme={theme} />
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

      <ResumeList
        sessions={pending.filter((upload) => !uploads.some((item) => (
          item.sessionId === upload.id && item.status !== 'done' && item.status !== 'canceled'
        )))}
        error={resumeError}
        onPick={continueSession}
      />

      <UploadZone
        onFiles={addFiles}
        onPlanned={(items) => void addPlanned(items)}
        uploads={uploads}
        concurrency={Math.min(concurrency, pageCap)}
        pageCap={pageCap}
        onConcurrency={changeConcurrency}
        onCancel={cancelUpload}
        onRetry={retryUpload}
        onClear={() => setUploads((current) => current.filter((item) => item.status === 'queued' || item.status === 'uploading'))}
        statusSummary={statusSummary}
      />

      {abandonedNote ? <p className="banner error" role="status">{abandonedNote}</p> : null}
      {banner ? <p className="banner ok" role="status">{banner}</p> : null}
      {listError ? <p className="banner error" role="alert">{listError}</p> : null}

      <section className="panel">
        <FolderBar
          breadcrumbs={listing?.breadcrumbs ?? []}
          draft={folderDraft}
          onDraft={setFolderDraft}
          onOpen={openFolder}
          onCreate={(name) => void makeFolder(name)}
        />
        {selected.length > 0 ? (
          <div className="bulk">
            <span>{selected.length} selected</span>
            <button type="button" onClick={() => void moveSelected()}>Move to this folder</button>
            {confirmBulkDelete ? (
              <>
                <span>Delete the files you uploaded?</span>
                <button type="button" className="danger" onClick={() => void deleteSelected()}>Delete</button>
                <button type="button" className="ghost" onClick={() => setConfirmBulkDelete(false)}>Keep</button>
              </>
            ) : (
              <button type="button" className="danger" onClick={() => setConfirmBulkDelete(true)}>Delete selected</button>
            )}
            {selected.length <= 100 ? <a className="button" href={zipUrl(selected)}>Download zip</a> : null}
            <input
              aria-label="Tag for selected files"
              value={tagDraft}
              placeholder="Tag"
              list="portal-tags"
              onChange={(event) => setTagDraft(event.target.value)}
            />
            <button type="button" onClick={() => void tagSelected()}>Tag selected</button>
            <label className="sr" htmlFor="bulk-collection">Collection for selected files</label>
            <select id="bulk-collection" value={bulkCollectionId} onChange={(event) => setBulkCollectionId(event.target.value)}>
              <option value="">Add to collection</option>
              {collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button type="button" disabled={!bulkCollectionId} onClick={() => void collectSelected()}>Add to collection</button>
            <button type="button" className="ghost" onClick={() => { setSelected([]); setConfirmBulkDelete(false); }}>Clear</button>
          </div>
        ) : null}
        <div className="toolbar">
          <label>
            Search
            <input
              type="search"
              value={searchInput}
              placeholder="Filename in every folder"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </label>
          <label>
            Sort
            <select value={sort} onChange={(event) => changeSort(event.target.value as SortValue)}>
              {SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button type="button" className="ghost" aria-pressed={favoriteOnly} onClick={() => chooseFavorite(!favoriteOnly)}>Favorites</button>
          <label>
            Tag
            <select value={tagId} onChange={(event) => chooseTag(event.target.value)}>
              <option value="">Every file</option>
              {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
          </label>
          <label>
            Collection
            <select value={collectionId} onChange={(event) => chooseCollection(event.target.value)}>
              <option value="">Every file</option>
              {collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <form className="inline-rename" onSubmit={(event) => void makeCollection(event)}>
            <label>
              New collection
              <input value={collectionDraft} onChange={(event) => setCollectionDraft(event.target.value)} />
            </label>
            <button type="submit">Create</button>
          </form>
          {collections.find((item) => item.id === collectionId)?.canRename ? (
            <form className="inline-rename" onSubmit={(event) => void saveCollectionName(event)}>
              <label>
                Rename collection
                <input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} />
              </label>
              <button type="submit">Save</button>
            </form>
          ) : null}
          {collections.find((item) => item.id === collectionId)?.canDelete ? (
            <button type="button" className="ghost danger" onClick={() => void removeCollection()}>Delete collection</button>
          ) : null}
          <div className="view-toggle" role="group" aria-label="Layout">
            <button type="button" className="ghost" aria-pressed={view === 'list'} onClick={() => chooseView('list')}>List</button>
            <button type="button" className="ghost" aria-pressed={view === 'grid'} onClick={() => chooseView('grid')}>Grid</button>
          </div>
        </div>
        <datalist id="portal-tags">
          {tags.map((tag) => <option key={tag.id} value={tag.name} />)}
        </datalist>
        <FolderList
          folders={search || favoriteOnly || tagId || collectionId ? [] : (listing?.folders ?? [])}
          csrfToken={csrf}
          onOpen={openFolder}
          onChanged={refresh}
          onError={setListError}
        />
        {view === 'grid' ? (
          <FileGrid
            files={listing?.files ?? []}
            loading={loading}
            searching={search.length > 0 || favoriteOnly || Boolean(tagId || collectionId)}
            hasFolders={!search && !favoriteOnly && !tagId && !collectionId && (listing?.folders?.length ?? 0) > 0}
            selected={selected}
            collectionId={collectionId}
            onToggle={toggleSelected}
            csrfToken={csrf}
            onChanged={refresh}
            onError={setListError}
          />
        ) : (
          <FileTable
            files={listing?.files ?? []}
            loading={loading}
            searching={search.length > 0 || favoriteOnly || Boolean(tagId || collectionId)}
            hasFolders={!search && !favoriteOnly && !tagId && !collectionId && (listing?.folders?.length ?? 0) > 0}
            selected={selected}
            collectionId={collectionId}
            onToggle={toggleSelected}
            onTogglePage={togglePage}
            csrfToken={csrf}
            onChanged={refresh}
            onError={setListError}
          />
        )}
        <div className="pager">
          <button type="button" className="ghost" disabled={cursorStack.length === 0} onClick={showPrevious}>Previous</button>
          <button type="button" className="ghost" disabled={!listing?.page?.nextCursor} onClick={showNext}>Next</button>
        </div>
      </section>
    </div>
  );
}

function ResumeList({
  sessions,
  error,
  onPick,
}: {
  sessions: UploadSession[];
  error: string;
  onPick: (session: UploadSession, file: File) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <section className="panel resume">
      <h2>Continue an upload</h2>
      <p>
        The browser cannot keep a file selected after you leave this page. Choose the same file to continue.
        A different name or size is rejected. Saved progress expires after 24 hours. This is not a backup.
      </p>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      <ul>
        {sessions.map((upload) => (
          <ResumeRow key={upload.id} session={upload} onPick={onPick} />
        ))}
      </ul>
    </section>
  );
}

function ResumeRow({
  session,
  onPick,
}: {
  session: UploadSession;
  onPick: (session: UploadSession, file: File) => void;
}) {
  const inputId = useId();
  return (
    <li>
      <div className="queue-row">
        <span className="filename">{session.originalName}</span>
        <span className="meta">{formatBytes(session.receivedBytes)} of {formatBytes(session.sizeBytes)} saved</span>
        <label className="button" htmlFor={inputId}>Choose file</label>
        <input
          id={inputId}
          type="file"
          aria-label={`Choose ${session.originalName} to continue`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onPick(session, file);
          }}
        />
      </div>
    </li>
  );
}

function UploadZone({
  onFiles,
  onPlanned,
  uploads,
  concurrency,
  pageCap,
  onConcurrency,
  onCancel,
  onRetry,
  onClear,
  statusSummary,
}: {
  onFiles: (files: File[]) => void;
  onPlanned: (items: PlannedUpload[]) => void;
  uploads: UploadItem[];
  concurrency: number;
  pageCap: number;
  onConcurrency: (value: number) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onClear: () => void;
  statusSummary: string;
}) {
  const inputId = useId();
  const folderInputId = useId();
  const folderPicker = typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input');
  const [hot, setHot] = useState(false);
  const [live, setLive] = useState('');
  const finished = uploads.some((item) => item.status === 'done' || item.status === 'error' || item.status === 'canceled');

  useEffect(() => {
    if (uploads.length === 0) return;
    const active = uploads.filter((item) => item.status === 'uploading').length;
    const waiting = uploads.filter((item) => item.status === 'queued').length;
    const done = uploads.filter((item) => item.status === 'done').length;
    const failed = uploads.filter((item) => item.status === 'error').length;
    const canceled = uploads.filter((item) => item.status === 'canceled').length;
    setLive(`${active} uploading, ${waiting} waiting, ${done} finished, ${canceled} canceled, ${failed} failed.`);
  }, [statusSummary, uploads]);

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
          void readDataTransfer(event.dataTransfer).then(onPlanned);
        }}
      >
        <div>
          <h2>Upload</h2>
          <p>Drop files here, or choose them. New files go in the open folder. Choose a folder when this browser allows it. Otherwise choose the files. If you leave this page, choose the same file again to continue. Saved progress is kept for 24 hours.</p>
        </div>
        <div className="drop-actions">
          <label className="button" htmlFor={inputId}>Choose files</label>
          {folderPicker ? <label className="button" htmlFor={folderInputId}>Choose folder</label> : null}
        </div>
        <input
          id={inputId}
          type="file"
          multiple
          onChange={(event) => {
            onFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        {folderPicker ? (
          <input
            id={folderInputId}
            type="file"
            multiple
            ref={(node) => { if (node) node.setAttribute('webkitdirectory', ''); }}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              onPlanned(files.map((file) => ({
                file,
                relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
              })));
              event.target.value = '';
            }}
          />
        ) : null}
      </div>
      <p className="sr" role="status" aria-live="polite">{live}</p>
      {uploads.length > 0 ? (
        <div className="queue">
          <div className="queue-head">
            <h3>Transfers</h3>
            <label className="concurrency">
              At once
              <select
                value={String(concurrency)}
                onChange={(event) => onConcurrency(Number(event.target.value))}
              >
                {Array.from({ length: pageCap }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            {finished ? <button type="button" className="ghost" onClick={onClear}>Clear finished</button> : null}
          </div>
          <ul>
            {uploads.map((item) => {
              const speed = formatSpeed(item.bytesPerSecond);
              const remaining = item.status === 'uploading' ? formatRemaining(item.remainingMs, item.stalled) : '';
              const amount = item.status === 'uploading' || (item.sessionId && item.loaded > 0)
                ? `${formatBytes(item.loaded)} of ${formatBytes(item.total)}`
                : formatBytes(item.file.size);
              const detail = [amount, speed, remaining]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={item.id}>
                  <div className="queue-row">
                    <span className="filename">{item.file.name}</span>
                    <span className="meta">{detail}</span>
                    {item.status === 'queued' || item.status === 'uploading' ? (
                      <button type="button" className="ghost" onClick={() => onCancel(item.id)}>Cancel</button>
                    ) : (
                      <span className={`pill ${item.status}`}>{item.message}</span>
                    )}
                    {item.status === 'error' || item.status === 'canceled' ? (
                      <button type="button" className="ghost" onClick={() => onRetry(item.id)}>Retry</button>
                    ) : null}
                  </div>
                  {item.status === 'uploading' || item.status === 'queued' ? (
                    <div
                      className="bar"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={item.progress}
                      aria-valuetext={detail}
                      aria-label={`Upload progress for ${item.file.name}`}
                    >
                      <span style={{ width: `${item.status === 'queued' ? 0 : item.progress}%` }} />
                    </div>
                  ) : null}
                  {item.status === 'error' ? <p className="fail" role="alert">{item.message}</p> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function readConcurrency(serverCap: number): number {
  const pageCap = Math.max(1, Math.min(3, serverCap));
  const saved = Number(localStorage.getItem(CONCURRENCY_KEY));
  if (Number.isInteger(saved) && saved >= 1 && saved <= pageCap) return saved;
  return pageCap;
}

function readView(): 'list' | 'grid' {
  return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
}

function FolderBar({
  breadcrumbs,
  draft,
  onDraft,
  onOpen,
  onCreate,
}: {
  breadcrumbs: Breadcrumb[];
  draft: string;
  onDraft: (value: string) => void;
  onOpen: (id: string | null) => void;
  onCreate: (name: string) => void;
}) {
  return (
    <div className="folder-bar">
      <nav className="crumbs" aria-label="Folders">
        <ol>
          <li>
            <button type="button" className="ghost" onClick={() => onOpen(null)} aria-current={breadcrumbs.length === 0 ? 'page' : undefined}>
              Shared files
            </button>
          </li>
          {breadcrumbs.map((crumb, index) => (
            <li key={crumb.id}>
              <button
                type="button"
                className="ghost"
                onClick={() => onOpen(crumb.id)}
                aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
              >
                {crumb.name}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <form
        className="folder-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) onCreate(draft);
        }}
      >
        <label>
          New folder
          <input value={draft} onChange={(event) => onDraft(event.target.value)} />
        </label>
        <button type="submit">Create</button>
      </form>
    </div>
  );
}

function FolderList({
  folders,
  csrfToken,
  onOpen,
  onChanged,
  onError,
}: {
  folders: FolderItem[];
  csrfToken: string;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  async function saveName(folder: FolderItem) {
    onError('');
    try {
      await renameFolder(folder.id, draft, csrfToken);
      setRenaming(null);
      await onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'The folder could not be renamed.');
    }
  }

  async function remove(folder: FolderItem) {
    onError('');
    try {
      await deleteFolder(folder.id, csrfToken);
      setPendingDelete(null);
      await onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'The folder could not be deleted.');
    }
  }

  if (folders.length === 0) return null;
  return (
    <ul className="folders">
      {folders.map((folder) => (
        <li key={folder.id}>
          <button type="button" className="ghost folder-open" onClick={() => onOpen(folder.id)}>{folder.name}</button>
          <span className="meta">Folder</span>
          {folder.canRename && renaming !== folder.id ? (
            <button type="button" className="ghost" onClick={() => { setRenaming(folder.id); setDraft(folder.name); }}>Rename</button>
          ) : null}
          {renaming === folder.id ? (
            <form className="inline-rename" onSubmit={(event) => { event.preventDefault(); void saveName(folder); }}>
              <label className="sr" htmlFor={`rename-${folder.id}`}>New name for {folder.name}</label>
              <input id={`rename-${folder.id}`} value={draft} onChange={(event) => setDraft(event.target.value)} />
              <button type="submit">Save</button>
              <button type="button" className="ghost" onClick={() => setRenaming(null)}>Cancel</button>
            </form>
          ) : null}
          {folder.canDelete && pendingDelete !== folder.id ? (
            <button type="button" className="ghost danger" onClick={() => setPendingDelete(folder.id)}>Delete</button>
          ) : null}
          {folder.canDelete && pendingDelete === folder.id ? (
            <>
              <span>Delete this empty folder?</span>
              <button type="button" className="danger" onClick={() => void remove(folder)}>Delete</button>
              <button type="button" className="ghost" onClick={() => setPendingDelete(null)}>Keep</button>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function FileTable({
  files,
  loading,
  searching,
  hasFolders,
  selected,
  collectionId,
  onToggle,
  onTogglePage,
  csrfToken,
  onChanged,
  onError,
}: {
  files: PortalFile[];
  loading: boolean;
  searching: boolean;
  hasFolders: boolean;
  selected: string[];
  collectionId: string;
  onToggle: (id: string, checked: boolean) => void;
  onTogglePage: (ids: string[], checked: boolean) => void;
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
    if (hasFolders) return <p className="status">No files in this folder.</p>;
    return (
      <p className="status">
        {searching ? 'No files match.' : 'No files yet. Upload the first one.'}
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <caption>You can delete files you uploaded. Anyone signed in can download.</caption>
        <thead>
          <tr>
            <th scope="col">
              <input
                type="checkbox"
                aria-label="Select every file on this page"
                checked={files.length > 0 && files.every((file) => selected.includes(file.id))}
                onChange={(event) => onTogglePage(files.map((file) => file.id), event.target.checked)}
              />
            </th>
            <th scope="col"><span className="sr">Favorite</span></th>
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
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${file.originalName}`}
                  checked={selected.includes(file.id)}
                  onChange={(event) => onToggle(file.id, event.target.checked)}
                />
              </td>
              <td>
                <FileMarks
                  file={file}
                  collectionId={collectionId}
                  csrfToken={csrfToken}
                  onChanged={onChanged}
                  onError={onError}
                />
              </td>
              <td className="filename">
                {file.originalName}
                {searching && file.folderName ? <span className="meta"> In {file.folderName}</span> : null}
              </td>
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

function FileGrid({
  files,
  loading,
  searching,
  hasFolders,
  selected,
  collectionId,
  onToggle,
  csrfToken,
  onChanged,
  onError,
}: {
  files: PortalFile[];
  loading: boolean;
  searching: boolean;
  hasFolders: boolean;
  selected: string[];
  collectionId: string;
  onToggle: (id: string, checked: boolean) => void;
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

  if (loading && files.length === 0) return <p className="status" role="status">Loading files…</p>;
  if (!loading && files.length === 0) {
    if (hasFolders) return <p className="status">No files in this folder.</p>;
    return <p className="status">{searching ? 'No files match.' : 'No files yet. Upload the first one.'}</p>;
  }

  return (
    <ul className="grid">
      {files.map((file) => (
        <li key={file.id} className="tile">
          <label className="pick">
            <input
              type="checkbox"
              aria-label={`Select ${file.originalName}`}
              checked={selected.includes(file.id)}
              onChange={(event) => onToggle(file.id, event.target.checked)}
            />
            Select
          </label>
          <FileMarks
            file={file}
            collectionId={collectionId}
            csrfToken={csrfToken}
            onChanged={onChanged}
            onError={onError}
          />
          <strong className="filename">{file.originalName}</strong>
          <span className="meta">{formatBytes(file.sizeBytes)} · {file.ownerUsername}</span>
          {searching && file.folderName ? <span className="meta">In {file.folderName}</span> : null}
          <span className="meta">{formatWhen(file.createdAt)}</span>
          <div className="actions">
            <a href={`/api/files/${encodeURIComponent(file.id)}/download`}>Download</a>
            {file.canDelete && pendingDelete !== file.id ? (
              <button type="button" className="ghost danger" onClick={() => setPendingDelete(file.id)}>Delete</button>
            ) : null}
            {file.canDelete && pendingDelete === file.id ? (
              <button type="button" className="danger" disabled={deleting === file.id} onClick={() => void confirmDelete(file)}>
                {deleting === file.id ? 'Deleting…' : 'Delete'}
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
