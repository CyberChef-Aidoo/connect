import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  addToCollection,
  ApiError,
  createCollection,
  createFolder,
  deleteCollection,
  deleteFiles,
  deleteFolder,
  deleteUpload,
  ensureFolder,
  getSession,
  heartbeat,
  listBin,
  listCollections,
  listFiles,
  listPeers,
  listTags,
  listUploads,
  login,
  logout,
  moveFiles,
  purgeFile,
  renameCollection,
  renameFolder,
  restoreFile,
  tagFiles,
  takeSignals,
  uploadFile,
  zipUrl,
  type BinFile,
  type Breadcrumb,
  type CollectionItem,
  type FileList,
  type FolderItem,
  type PortalFile,
  type Session,
  type TagItem,
  type UploadSession,
} from './api';
import { createDirectHub } from './directSend';
import { randomId } from './randomId';
import { ShareDesk } from './ShareDesk';
import { folderPlacement, readDataTransfer, type PlannedUpload } from './folderUpload';
import { rememberLocalFile } from './localFiles';
import { formatBytes, formatWhen } from './format';
import { FileCards, FileGrid, FileTable, LibraryToolbar, useMediaQuery } from './libraryView';
import { selectionMatchesSession } from './resumeMatch';
import { startBrowserDownload, type DownloadWatch } from './browserDownload';
import { TransferCards, type TransferCardModel } from './transferCards';
import { explainTransferFailure, formatRemaining, formatSpeed, rememberSample, shouldPaint, transferView, type TransferActivity, type TransferSample } from './transfer';

type SortValue = 'date:desc' | 'date:asc' | 'name:asc' | 'name:desc' | 'size:desc' | 'size:asc';

type UploadStatus = 'queued' | 'uploading' | 'finishing' | 'done' | 'error' | 'lost' | 'canceled';

type UploadItem = {
  id: string;
  attempt: number;
  file: File;
  sessionId: string | null;
  folderId: string | null;
  loaded: number;
  sentBytes: number;
  confirmedBytes: number;
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
  { value: 'name:asc', label: 'Name Aâ€“Z' },
  { value: 'name:desc', label: 'Name Zâ€“A' },
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
        <p className="status" role="status">Checking your sessionâ€¦</p>
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
        <p className="meta">Build {__PORTAL_BUILD__}</p>
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
        <button type="submit" disabled={busy}>{busy ? 'Signing inâ€¦' : 'Sign in'}</button>
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
  const compactList = useMediaQuery('(max-width: 899px)');
  const [bulkCollectionId, setBulkCollectionId] = useState('');
  const [previewing, setPreviewing] = useState<PortalFile | null>(null);
  const [binOpen, setBinOpen] = useState(false);
  const [binFiles, setBinFiles] = useState<BinFile[]>([]);
  const [binDays, setBinDays] = useState(30);
  const [browsers, setBrowsers] = useState<Array<{ userId: string; peerId: string }>>([]);
  const [selfPeerId, setSelfPeerId] = useState('');
  const [takingId, setTakingId] = useState<string | null>(null);
  const [desk, setDesk] = useState<'share' | 'library'>('share');
  const [concurrency, setConcurrency] = useState(() => readConcurrency(session.uploads.maxPerUser));
  const directSendEvents = useRef<(event: { id: string; filename: string; progress: { sentBytes: number; confirmedBytes: number; totalBytes: number }; status: 'sending' | 'finishing' | 'completed' | 'lost' }) => void>(() => undefined);
  const direct = useRef(createDirectHub({ onSend: (event) => directSendEvents.current(event) }));
  const paintAt = useRef(new Map<string, { at: number; status: string }>());
  const downloadCancels = useRef(new Map<string, () => void>());
  const downloadTargets = useRef(new Map<string, { href: string; filename: string }>());
  const [downloadCards, setDownloadCards] = useState<TransferCardModel[]>([]);
  directSendEvents.current = (event) => rememberDirect(event);
  const started = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());
  const csrf = session.csrfToken;
  const pageCap = Math.max(1, Math.min(3, session.uploads.maxPerUser));
  const statusSummary = uploads.map((item) => `${item.id}:${item.status}`).join('|');

  useEffect(() => {
    const hub = direct.current;
    let stop = false;
    let polling = false;
    const tick = () => {
      if (polling || stop) return;
      polling = true;
      void (async () => {
        try {
          const peerId = await heartbeat(csrf);
          const [people, inbox] = await Promise.all([listPeers(), takeSignals()]);
          if (stop) return;
          setBrowsers(people.browsers);
          if (peerId) setSelfPeerId(peerId);
          for (const signal of inbox.signals) {
            await hub.handle(signal, csrf);
          }
        } catch (caught) {
          if (!stop && caught instanceof ApiError && caught.status === 401) onSession(null);
        } finally {
          polling = false;
        }
      })();
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      hub.close();
    };
  }, [csrf, onSession]);

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
      if (!uploads.some((item) => item.status === 'uploading' || item.status === 'finishing' || item.status === 'queued')) return;
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

  async function loadBin() {
    try {
      const next = await listBin();
      setBinFiles(next.files);
      setBinDays(next.retentionDays);
      setListError('');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onSession(null);
        return;
      }
      setListError(caught instanceof ApiError ? caught.message : 'The bin could not be loaded.');
    }
  }

  useEffect(() => {
    if (!binOpen) return;
    void loadBin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binOpen, csrf]);

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
    if (!uploads.some((item) => item.status === 'uploading' || item.status === 'finishing')) return undefined;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setUploads((current) => current.map((entry) => {
        if (entry.status !== 'uploading' && entry.status !== 'finishing') return entry;
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
    const room = Math.min(concurrency, pageCap) - uploads.filter((item) => item.status === 'uploading' || item.status === 'finishing').length;
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
      const saved = await uploadFile(item.file, csrf, (tick) => {
        const now = Date.now();
        const previous = paintAt.current.get(item.id);
        const force = !previous || previous.status !== tick.phase;
        if (!shouldPaint(previous?.at ?? 0, now, force)) return;
        paintAt.current.set(item.id, { at: now, status: tick.phase });
        patchUpload(item.id, attempt, (entry) => {
          const samples = rememberSample(entry.samples, { at: now, loaded: tick.sentBytes });
          const view = transferView({ loaded: tick.sentBytes, total: tick.totalBytes, now, samples, active: true });
          return {
            ...entry,
            loaded: tick.confirmedBytes,
            sentBytes: tick.sentBytes,
            confirmedBytes: tick.confirmedBytes,
            total: tick.totalBytes,
            samples,
            progress: view.progress,
            bytesPerSecond: view.bytesPerSecond,
            remainingMs: view.remainingMs,
            stalled: view.stalled,
            status: tick.phase === 'finishing' ? 'finishing' : 'uploading',
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
      rememberLocalFile(saved.id, item.file);
      patchUpload(item.id, attempt, (entry) => ({
        ...entry,
        status: 'done',
        progress: 100,
        loaded: entry.total || entry.file.size,
        sentBytes: entry.total || entry.file.size,
        confirmedBytes: entry.total || entry.file.size,
        message: 'Uploaded',
        stalled: false,
        remainingMs: null,
      }));
      setBanner(`Uploaded ${item.file.name}`);
      await refresh();
      await loadPending();
    } catch (caught) {
      const canceled = caught instanceof ApiError && caught.message === 'Upload canceled.';
      const failure = explainTransferFailure(
        caught instanceof ApiError ? caught.status : 0,
        caught instanceof Error ? caught.message : 'The connection was lost. Try again.',
      );
      setUploads((current) => current.map((entry) => (
        entry.id === item.id && entry.attempt === attempt
          ? {
            ...entry,
            status: canceled ? 'canceled' : failure.status === 'lost' ? 'lost' : 'error',
            stalled: false,
            message: canceled ? 'Canceled' : failure.message,
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
        id: randomId(),
        attempt: 1,
        file,
        sessionId: null,
        folderId: target,
        loaded: 0,
        sentBytes: 0,
        confirmedBytes: 0,
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
      id: randomId(),
      attempt: 1,
      file,
      sessionId: upload.id,
      folderId: null,
      loaded: upload.receivedBytes,
      sentBytes: upload.receivedBytes,
      confirmedBytes: upload.receivedBytes,
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
      entry.id === id && (entry.status === 'queued' || entry.status === 'uploading' || entry.status === 'finishing')
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
        sentBytes: keep ? item.sentBytes : 0,
        confirmedBytes: keep ? item.confirmedBytes : 0,
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
        ? `Moved ${result.deleted.length} to the bin. Left ${left} that you did not upload.`
        : `Moved ${result.deleted.length} to the bin.`);
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

  async function makeCollection(name: string) {
    if (!name.trim()) return;
    setListError('');
    try {
      const created = await createCollection(name, csrf);
      setCollectionId(created.id);
      resetPage();
      setBanner(`Collection â€œ${created.name}â€ created.`);
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'The collection could not be created.');
    }
  }

  async function saveCollectionName(name: string) {
    if (!collectionId || !name.trim()) return;
    setListError('');
    try {
      await renameCollection(collectionId, name, csrf);
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

  function canDirect(file: PortalFile): boolean {
    return browsers.some((browser) => browser.userId === file.ownerId && browser.peerId !== selfPeerId);
  }

  function rememberCard(card: TransferCardModel) {
    const now = Date.now();
    const previous = paintAt.current.get(card.id);
    const force = !previous || previous.status !== card.status;
    if (!shouldPaint(previous?.at ?? 0, now, force)) return;
    paintAt.current.set(card.id, { at: now, status: card.status });
    setDownloadCards((current) => {
      const index = current.findIndex((item) => item.id === card.id);
      if (index < 0) return [card, ...current];
      const next = current.slice();
      next[index] = card;
      return next;
    });
  }

  function downloadCard(watch: DownloadWatch): TransferCardModel {
    const relay = watch.kind === 'relay' || watch.kind === 'relay-zip';
    const packed = watch.sourceTotal !== null && watch.kind.endsWith('zip')
      ? `Read ${formatBytes(watch.sourceBytes)} of ${formatBytes(watch.sourceTotal)} from the files.`
      : '';
    const saved = watch.status === 'completed'
      ? 'This page cannot confirm the file was saved.'
      : 'Saved: not confirmed.';
    return {
      id: watch.id,
      filename: watch.filename,
      direction: 'download',
      status: watch.status,
      totalBytes: watch.totalBytes,
      transferredBytes: watch.sentBytes,
      confirmedBytes: null,
      detail: [relay ? `Received from the other browser: ${formatBytes(watch.uploadBytes)}.` : '', `Sent ${formatBytes(watch.sentBytes)}. ${saved}`, packed].filter(Boolean).join(' '),
      error: watch.error,
      speed: '',
      remaining: '',
      canCancel: watch.status === 'sending' || watch.status === 'downloading' || watch.status === 'finishing',
      canRetry: watch.status === 'lost' || watch.status === 'retry',
    };
  }

  function rememberDirect(event: { id: string; filename: string; progress: { sentBytes: number; confirmedBytes: number; totalBytes: number }; status: 'sending' | 'finishing' | 'completed' | 'lost' }) {
    rememberCard({
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
    });
  }

  function beginDownload(href: string, filename: string) {
    const startedDownload = startBrowserDownload({
      href,
      filename,
      csrf,
      onUpdate: (watch) => rememberCard(downloadCard(watch)),
    });
    downloadCancels.current.set(startedDownload.id, startedDownload.cancel);
    downloadTargets.current.set(startedDownload.id, { href, filename });
  }

  function retryDownload(id: string) {
    const target = downloadTargets.current.get(id);
    if (!target) return;
    beginDownload(target.href, target.filename);
  }

  async function takeDirect(file: PortalFile) {
    setListError('');
    setTakingId(file.id);
    const cardId = `direct-${file.id}`;
    rememberCard({
      id: cardId,
      filename: file.originalName,
      direction: 'download',
      status: 'downloading',
      totalBytes: file.sizeBytes,
      transferredBytes: 0,
      confirmedBytes: 0,
      detail: 'Receiving from the other browser.',
      error: null,
      speed: '',
      remaining: '',
      canCancel: false,
      canRetry: false,
    });
    try {
      const blob = await direct.current.requestFile(file.id, file.ownerId, csrf, {
        onProgress: (received, total) => rememberCard({
          id: cardId,
          filename: file.originalName,
          direction: 'download',
          status: received >= total ? 'finishing' : 'downloading',
          totalBytes: total,
          transferredBytes: received,
          confirmedBytes: received,
          detail: 'These bytes have arrived in this tab.',
          error: null,
          speed: '',
          remaining: '',
          canCancel: false,
          canRetry: false,
        }),
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.originalName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      rememberCard({
        id: cardId,
        filename: file.originalName,
        direction: 'download',
        status: 'completed',
        totalBytes: file.sizeBytes,
        transferredBytes: file.sizeBytes,
        confirmedBytes: file.sizeBytes,
        detail: 'Received in this tab. Your browser was asked to save a copy. This page cannot confirm that save.',
        error: null,
        speed: '',
        remaining: '',
        canCancel: false,
        canRetry: false,
      });
    } catch (caught) {
      const failure = explainTransferFailure(0, caught instanceof Error ? caught.message : 'The connection was lost. Use Download.');
      rememberCard({
        id: cardId,
        filename: file.originalName,
        direction: 'download',
        status: failure.status,
        totalBytes: file.sizeBytes,
        transferredBytes: 0,
        confirmedBytes: null,
        detail: '',
        error: failure.message,
        speed: '',
        remaining: '',
        canCancel: false,
        canRetry: false,
      });
    } finally {
      setTakingId(null);
    }
  }

  async function signOut() {
    try {
      await logout(csrf);
    } finally {
      onSession(null);
    }
  }

  const fileListProps = {
    files: listing?.files ?? [],
    loading,
    searching: search.length > 0 || favoriteOnly || Boolean(tagId || collectionId),
    hasFolders: !search && !favoriteOnly && !tagId && !collectionId && (listing?.folders?.length ?? 0) > 0,
    selected,
    collectionId,
    onToggle: toggleSelected,
    csrfToken: csrf,
    onChanged: refresh,
    onError: setListError,
    onPreview: setPreviewing,
    canDirect,
    takingId,
    onDirect: (file: PortalFile) => void takeDirect(file),
    onDownload: (href: string, filename: string) => beginDownload(href, filename),
  };
  const storage = listing?.storage;
  const ratio = storage && storage.limitBytes > 0 ? Math.min(1, storage.usedBytes / storage.limitBytes) : 0;

  return (
    <div className="shell">
      <header className="top">
        <div>
          <p className="eyebrow">Local file portal</p>
          <p className="meta">Build {__PORTAL_BUILD__}</p>
          <h1>Shared files</h1>
        </div>
        <div className="who">
          {session.openAccess ? null : <span>{session.user.username}</span>}
          <ThemeButton theme={theme} />
          {session.openAccess ? null : (
            <button type="button" className="ghost" onClick={() => void signOut()}>Sign out</button>
          )}
        </div>
      </header>

      <div className="view-toggle section-toggle" role="tablist" aria-label="Sections">
        <button type="button" role="tab" aria-selected={desk === 'share'} onClick={() => setDesk('share')}>Share</button>
        <button type="button" role="tab" aria-selected={desk === 'library'} onClick={() => setDesk('library')}>Library</button>
      </div>
      <ShareDesk csrf={csrf} hidden={desk !== 'share'} />
      <TransferCards
        items={downloadCards}
        onCancel={(id) => downloadCancels.current.get(id)?.()}
        onRetry={retryDownload}
      />
      <div hidden={desk !== 'library'}>

      <section className="storage" aria-label="Storage">
        <div className="storage-copy">
          <strong>{storage ? `${formatBytes(storage.usedBytes)} of ${formatBytes(storage.limitBytes)} used` : 'Checking storageâ€¦'}</strong>
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

      <section className="panel library">
        <p className="meta">Direct asks the uploaderâ€™s open browser to send the file on this network. Download uses the copy stored on this computer. A direct send works only while that person still has the file from an upload in this visit, and only for files up to 256 MB.</p>
        <FolderBar
          breadcrumbs={listing?.breadcrumbs ?? []}
          draft={folderDraft}
          onDraft={setFolderDraft}
          onOpen={openFolder}
          onCreate={(name) => void makeFolder(name)}
        />
        {selected.length > 0 ? (
          <div className="bulk">
            <p className="bulk-count">{selected.length} selected</p>
            <div className="bulk-actions">
              <button type="button" onClick={() => void moveSelected()}>Move to this folder</button>
              {confirmBulkDelete ? (
                <>
                  <span className="bulk-note">Move the files you uploaded to the bin?</span>
                  <button type="button" className="danger" onClick={() => void deleteSelected()}>Delete</button>
                  <button type="button" className="ghost" onClick={() => setConfirmBulkDelete(false)}>Keep</button>
                </>
              ) : (
                <button type="button" className="danger" onClick={() => setConfirmBulkDelete(true)}>Delete selected</button>
              )}
              {selected.length <= 100 ? (
                <a className="button" href={zipUrl(selected)} onClick={(event) => { event.preventDefault(); beginDownload(zipUrl(selected), 'portal-files.zip'); }}>Download zip</a>
              ) : <span className="bulk-note">Choose 100 files or fewer for a zip.</span>}
            </div>
            <div className="bulk-actions">
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
          </div>
        ) : null}
        <LibraryToolbar
          favoriteOnly={favoriteOnly}
          binOpen={binOpen}
          view={view}
          sort={sort}
          sorts={SORTS}
          searchInput={searchInput}
          tagId={tagId}
          collectionId={collectionId}
          tags={tags}
          collections={collections}
          onSearch={setSearchInput}
          onSort={(value) => changeSort(value as SortValue)}
          onAll={() => { setBinOpen(false); chooseFavorite(false); }}
          onFavorites={() => { setBinOpen(false); chooseFavorite(true); }}
          onBin={() => { setFavoriteOnly(false); setBinOpen(true); }}
          onView={chooseView}
          onTag={chooseTag}
          onCollection={chooseCollection}
          onCreateCollection={makeCollection}
          onRenameCollection={saveCollectionName}
          onDeleteCollection={removeCollection}
        />
        <datalist id="portal-tags">
          {tags.map((tag) => <option key={tag.id} value={tag.name} />)}
        </datalist>
        {binOpen ? (
          <BinPanel
            files={binFiles}
            retentionDays={binDays}
            csrfToken={csrf}
            onChanged={async () => {
              await loadBin();
              await refresh();
            }}
            onError={setListError}
          />
        ) : (
          <>
        <FolderList
          folders={search || favoriteOnly || tagId || collectionId ? [] : (listing?.folders ?? [])}
          csrfToken={csrf}
          onOpen={openFolder}
          onChanged={refresh}
          onError={setListError}
        />
        {view === 'grid' ? (
          <FileGrid {...fileListProps} />
        ) : compactList ? (
          <FileCards {...fileListProps} onTogglePage={togglePage} />
        ) : (
          <FileTable {...fileListProps} onTogglePage={togglePage} />
        )}
        <PreviewDialog file={previewing} onClose={() => setPreviewing(null)} onDownload={beginDownload} />
        <div className="pager">
          <button type="button" className="ghost" disabled={cursorStack.length === 0} onClick={showPrevious}>Previous</button>
          <button type="button" className="ghost" disabled={!listing?.page?.nextCursor} onClick={showNext}>Next</button>
        </div>
          </>
        )}
      </section>
      </div>
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
          <TransferCards
            items={uploads.map((item) => ({
              id: item.id,
              filename: item.file.name,
              direction: 'upload' as const,
              status: uploadActivity(item.status),
              totalBytes: item.total,
              transferredBytes: item.sentBytes,
              confirmedBytes: item.confirmedBytes,
              detail: item.status === 'done'
                ? 'This computer has saved the file.'
                : item.sentBytes > item.confirmedBytes
                  ? 'Sent is ahead of the bytes this computer has saved.'
                  : '',
              error: item.status === 'error' || item.status === 'lost' ? item.message : null,
              speed: formatSpeed(item.bytesPerSecond),
              remaining: item.status === 'uploading' || item.status === 'finishing' ? formatRemaining(item.remainingMs, item.stalled) : '',
              canCancel: item.status === 'queued' || item.status === 'uploading' || item.status === 'finishing',
              canRetry: item.status === 'error' || item.status === 'lost' || item.status === 'canceled',
            }))}
            onCancel={onCancel}
            onRetry={onRetry}
          />
        </div>
      ) : null}
    </section>
  );
}

function uploadActivity(status: UploadStatus): TransferActivity {
  if (status === 'uploading') return 'sending';
  if (status === 'finishing') return 'finishing';
  if (status === 'done') return 'completed';
  if (status === 'lost') return 'lost';
  if (status === 'canceled') return 'canceled';
  if (status === 'error') return 'retry';
  return 'queued';
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

function BinPanel({
  files,
  retentionDays,
  csrfToken,
  onChanged,
  onError,
}: {
  files: BinFile[];
  retentionDays: number;
  csrfToken: string;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function restore(file: BinFile) {
    setBusy(file.id);
    onError('');
    try {
      await restoreFile(file.id, csrfToken);
      await onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'The file could not be restored.');
    } finally {
      setBusy(null);
    }
  }

  async function purge(file: BinFile) {
    setBusy(file.id);
    onError('');
    try {
      await purgeFile(file.id, csrfToken);
      setPending(null);
      await onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'The file could not be removed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bin">
      <p className="meta">
        Only you can see files you deleted. They stay for {retentionDays} days, still count toward the storage limit, and then are removed.
      </p>
      {files.length === 0 ? <p className="status">The bin is empty.</p> : (
        <ul className="folders">
          {files.map((file) => (
            <li key={file.id}>
              <span className="filename">{file.originalName}</span>
              <span className="meta">{formatBytes(file.sizeBytes)} Â· {formatWhen(file.deletedAt)}</span>
              <button type="button" disabled={busy === file.id} onClick={() => void restore(file)}>Restore</button>
              {pending !== file.id ? (
                <button type="button" className="ghost danger" onClick={() => setPending(file.id)}>Delete permanently</button>
              ) : (
                <>
                  <span>Remove this file from the portal?</span>
                  <button type="button" className="danger" disabled={busy === file.id} onClick={() => void purge(file)}>Delete</button>
                  <button type="button" className="ghost" onClick={() => setPending(null)}>Keep</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PreviewDialog({
  file,
  onClose,
  onDownload,
}: {
  file: PortalFile | null;
  onClose: () => void;
  onDownload: (href: string, filename: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (file && !dialog.open) dialog.showModal();
    if (!file && dialog.open) dialog.close();
  }, [file]);

  useEffect(() => {
    if (!file || file.preview !== 'text') return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setText('');
    setTruncated(false);
    void fetch(`/api/files/${encodeURIComponent(file.id)}/preview`, {
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.text();
      if (!response.ok) {
        let message = 'This file cannot be previewed. Download it instead.';
        try {
          const parsed = JSON.parse(body) as { error?: unknown };
          if (typeof parsed.error === 'string' && parsed.error.trim()) message = parsed.error;
        } catch {
          // The body was not JSON.
        }
        throw new Error(message);
      }
      if (!response.headers.get('content-type')?.startsWith('text/plain')) {
        throw new Error('This file cannot be previewed. Download it instead.');
      }
      setTruncated(response.headers.get('x-preview-truncated') === '1');
      setText(body);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : 'This file cannot be previewed. Download it instead.');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [file]);

  return (
    <dialog
      ref={dialogRef}
      className="preview"
      aria-labelledby="preview-title"
      onClose={onClose}
    >
      {file ? (
        <>
          <h2 id="preview-title">{file.originalName}</h2>
          {file.preview === 'image' ? (
            <img alt={file.originalName} src={`/api/files/${encodeURIComponent(file.id)}/preview`} />
          ) : null}
          {file.preview === 'text' && loading ? <p className="status" role="status">Loading previewâ€¦</p> : null}
          {file.preview === 'text' && error ? <p className="banner error" role="alert">{error}</p> : null}
          {file.preview === 'text' && !error ? <pre>{text}</pre> : null}
          {truncated ? <p className="meta">Showing the first 256 KB. Download the file for the rest.</p> : null}
          <div className="actions">
            <a
              href={`/api/files/${encodeURIComponent(file.id)}/download`}
              onClick={(event) => {
                event.preventDefault();
                onDownload(`/api/files/${encodeURIComponent(file.id)}/download`, file.originalName);
              }}
            >
              Download
            </a>
            <button type="button" className="ghost" onClick={onClose}>Close</button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
