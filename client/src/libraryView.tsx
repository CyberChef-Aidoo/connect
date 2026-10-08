import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  deleteFile,
  deleteVersion,
  detachTag,
  listVersions,
  removeFromCollection,
  replaceFile,
  setFavorite,
  tagFiles,
  type CollectionItem,
  type FileVersion,
  type PortalFile,
  type TagItem,
} from './api';
import { formatBytes, formatCompactWhen, formatWhen } from './format';

export type LibrarySort = { value: string; label: string };

export type FileActionProps = {
  file: PortalFile;
  collectionId: string;
  csrfToken: string;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onPreview: (file: PortalFile) => void;
  canDirect: (file: PortalFile) => boolean;
  takingId: string | null;
  onDirect: (file: PortalFile) => void;
  onDownload: (href: string, filename: string) => void;
};

type FileListProps = Omit<FileActionProps, 'file'> & {
  files: PortalFile[];
  loading: boolean;
  searching: boolean;
  hasFolders: boolean;
  selected: string[];
  onToggle: (id: string, checked: boolean) => void;
  onTogglePage?: (ids: string[], checked: boolean) => void;
};

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const apply = () => setMatches(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [query]);
  return matches;
}

export function LibraryToolbar({
  favoriteOnly,
  binOpen,
  view,
  sort,
  sorts,
  searchInput,
  tagId,
  collectionId,
  tags,
  collections,
  onSearch,
  onSort,
  onAll,
  onFavorites,
  onBin,
  onView,
  onTag,
  onCollection,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
}: {
  favoriteOnly: boolean;
  binOpen: boolean;
  view: 'list' | 'grid';
  sort: string;
  sorts: LibrarySort[];
  searchInput: string;
  tagId: string;
  collectionId: string;
  tags: TagItem[];
  collections: CollectionItem[];
  onSearch: (value: string) => void;
  onSort: (value: string) => void;
  onAll: () => void;
  onFavorites: () => void;
  onBin: () => void;
  onView: (view: 'list' | 'grid') => void;
  onTag: (id: string) => void;
  onCollection: (id: string) => void;
  onCreateCollection: (name: string) => Promise<void>;
  onRenameCollection: (name: string) => Promise<void>;
  onDeleteCollection: () => Promise<void>;
}) {
  const [collectionMode, setCollectionMode] = useState<null | 'create' | 'edit'>(null);
  const searchId = useId();
  const sortId = useId();
  const tag = tags.find((item) => item.id === tagId);
  const collection = collections.find((item) => item.id === collectionId);
  const filterCount = Number(Boolean(tagId)) + Number(Boolean(collectionId));

  return (
    <div className="library-bar">
      <div className="library-head">
        <h2>Files</h2>
        <div className="library-nav" role="group" aria-label="File lists">
          <button type="button" className="ghost" aria-pressed={!favoriteOnly && !binOpen} onClick={onAll}>All files</button>
          <button type="button" className="ghost" aria-pressed={favoriteOnly && !binOpen} onClick={onFavorites}>Favorites</button>
          <button type="button" className="ghost" aria-pressed={binOpen} onClick={onBin}>Bin</button>
        </div>
        <button type="button" className="ghost" onClick={() => setCollectionMode('create')}>+ Collection</button>
        <div className="segment" role="group" aria-label="Layout">
          <button type="button" aria-pressed={view === 'list'} onClick={() => onView('list')}>List</button>
          <button type="button" aria-pressed={view === 'grid'} onClick={() => onView('grid')}>Grid</button>
        </div>
      </div>
      <div className="library-tools">
        <label className="library-search" htmlFor={searchId}>
          <span className="sr">Search filenames</span>
          <input
            id={searchId}
            type="search"
            value={searchInput}
            placeholder="Search filenames"
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
        <label className="library-sort" htmlFor={sortId}>
          Sort
          <select id={sortId} value={sort} onChange={(event) => onSort(event.target.value)}>
            {sorts.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <FilterControl
          count={filterCount}
          tagId={tagId}
          collectionId={collectionId}
          tags={tags}
          collections={collections}
          onTag={onTag}
          onCollection={onCollection}
        />
      </div>
      {tag || collection ? (
        <ul className="filter-chips">
          {tag ? (
            <li className="chip">
              Tag: {tag.name}
              <button type="button" className="ghost" aria-label={`Remove tag filter ${tag.name}`} onClick={() => onTag('')}>×</button>
            </li>
          ) : null}
          {collection ? (
            <li className="chip">
              Collection: {collection.name}
              <button type="button" className="ghost" aria-label={`Remove collection filter ${collection.name}`} onClick={() => onCollection('')}>×</button>
              {collection.canRename || collection.canDelete ? (
                <button type="button" className="ghost" onClick={() => setCollectionMode('edit')}>Edit</button>
              ) : null}
            </li>
          ) : null}
        </ul>
      ) : null}
      <CollectionDialog
        mode={collectionMode}
        name={collection?.name ?? ''}
        canRename={Boolean(collection?.canRename)}
        canDelete={Boolean(collection?.canDelete)}
        onCreate={onCreateCollection}
        onRename={onRenameCollection}
        onDelete={onDeleteCollection}
        onClose={() => setCollectionMode(null)}
      />
    </div>
  );
}

function FilterControl({
  count,
  tagId,
  collectionId,
  tags,
  collections,
  onTag,
  onCollection,
}: {
  count: number;
  tagId: string;
  collectionId: string;
  tags: TagItem[];
  collections: CollectionItem[];
  onTag: (id: string) => void;
  onCollection: (id: string) => void;
}) {
  const sheet = useMediaQuery('(max-width: 699px)');
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  function close(restore = true) {
    setOpen(false);
    if (restore) buttonRef.current?.focus();
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && sheet && !dialog.open) {
      dialog.showModal();
      dialog.querySelector('select')?.focus();
    }
    if ((!open || !sheet) && dialog.open) dialog.close();
  }, [open, sheet]);

  useEffect(() => {
    if (!open || sheet) return undefined;
    panelRef.current?.querySelector('select')?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    }
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, sheet]);

  const fields = (
    <FilterFields
      tagId={tagId}
      collectionId={collectionId}
      tags={tags}
      collections={collections}
      onTag={onTag}
      onCollection={onCollection}
    />
  );

  return (
    <div className="filter-anchor">
      <button
        ref={buttonRef}
        type="button"
        className="ghost"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        {count > 0 ? `Filters (${count})` : 'Filters'}
      </button>
      {open && !sheet ? (
        <div ref={panelRef} className="filter-popover" role="dialog" aria-label="Filters">
          {fields}
          <button type="button" className="ghost" onClick={() => close()}>Done</button>
        </div>
      ) : null}
      <dialog
        ref={dialogRef}
        className="library-sheet"
        aria-label="Filters"
        onClose={() => close()}
      >
        <h3>Filters</h3>
        {fields}
        <button type="button" className="ghost" onClick={() => dialogRef.current?.close()}>Done</button>
      </dialog>
    </div>
  );
}

function FilterFields({
  tagId,
  collectionId,
  tags,
  collections,
  onTag,
  onCollection,
}: {
  tagId: string;
  collectionId: string;
  tags: TagItem[];
  collections: CollectionItem[];
  onTag: (id: string) => void;
  onCollection: (id: string) => void;
}) {
  const tagField = useId();
  const collectionField = useId();
  return (
    <div className="filter-fields">
      <label htmlFor={tagField}>
        Tag
        <select id={tagField} value={tagId} onChange={(event) => onTag(event.target.value)}>
          <option value="">Every file</option>
          {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
        </select>
      </label>
      <label htmlFor={collectionField}>
        Collection
        <select id={collectionField} value={collectionId} onChange={(event) => onCollection(event.target.value)}>
          <option value="">Every file</option>
          {collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
    </div>
  );
}

function CollectionDialog({
  mode,
  name,
  canRename,
  canDelete,
  onCreate,
  onRename,
  onDelete,
  onClose,
}: {
  mode: null | 'create' | 'edit';
  name: string;
  canRename: boolean;
  canDelete: boolean;
  onCreate: (name: string) => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (mode && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDraft(name);
      dialog.showModal();
      dialog.querySelector('input')?.focus();
    }
    if (!mode && dialog.open) dialog.close();
  }, [mode, name]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      if (mode === 'create') await onCreate(draft);
      if (mode === 'edit' && canRename) await onRename(draft);
      dialogRef.current?.close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="library-dialog"
      aria-labelledby="collection-dialog-title"
      onClose={() => {
        onClose();
        opener.current?.focus();
      }}
    >
      <h2 id="collection-dialog-title">{mode === 'edit' ? 'Collection' : 'New collection'}</h2>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor={fieldId}>{mode === 'edit' ? 'Name' : 'Collection name'}</label>
        <input
          id={fieldId}
          value={draft}
          disabled={mode === 'edit' && !canRename}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="actions">
          {mode === 'edit' && canRename ? <button type="submit" disabled={busy}>Save</button> : null}
          {mode === 'create' ? <button type="submit" disabled={busy || !draft.trim()}>Create</button> : null}
          {mode === 'edit' && canDelete ? (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onDelete().finally(() => {
                  setBusy(false);
                  dialogRef.current?.close();
                });
              }}
            >
              Delete collection
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={() => dialogRef.current?.close()}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}

function fileStatus(loading: boolean, count: number, searching: boolean, hasFolders: boolean): string | null {
  if (loading && count === 0) return 'Loading files…';
  if (!loading && count === 0) {
    if (hasFolders) return 'No files in this folder.';
    return searching ? 'No files match.' : 'No files yet. Upload the first one.';
  }
  return null;
}

export function FileTable(props: FileListProps) {
  const status = fileStatus(props.loading, props.files.length, props.searching, props.hasFolders);
  if (status) return <p className="status" role="status">{status}</p>;
  const pageIds = props.files.map((file) => file.id);
  return (
    <div className="library-table-wrap">
      <table className="library-table">
        <caption>Download is available for every file. Delete, replace, and earlier versions stay with the person who uploaded the file.</caption>
        <thead>
          <tr>
            <th className="col-check" scope="col">
              <input
                type="checkbox"
                aria-label="Select every file on this page"
                checked={props.files.every((file) => props.selected.includes(file.id))}
                onChange={(event) => props.onTogglePage?.(pageIds, event.target.checked)}
              />
            </th>
            <th className="col-star" scope="col"><span className="sr">Favorite</span></th>
            <th className="col-name" scope="col">Name</th>
            <th className="col-size" scope="col">Size</th>
            <th className="col-when" scope="col">Uploaded</th>
            <th className="col-who" scope="col">By</th>
            <th className="col-actions" scope="col"><span className="sr">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {props.files.map((file) => (
            <tr key={file.id}>
              <td className="col-check">
                <input
                  type="checkbox"
                  aria-label={`Select ${file.originalName}`}
                  checked={props.selected.includes(file.id)}
                  onChange={(event) => props.onToggle(file.id, event.target.checked)}
                />
              </td>
              <td className="col-star"><FavoriteButton {...props} file={file} /></td>
              <td className="col-name"><FileName file={file} searching={props.searching} /></td>
              <td className="col-size">{formatBytes(file.sizeBytes)}</td>
              <td className="col-when"><UploadedAt iso={file.createdAt} /></td>
              <td className="col-who">{file.ownerUsername}</td>
              <td className="col-actions"><FileActions {...props} file={file} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FileCards(props: FileListProps) {
  const status = fileStatus(props.loading, props.files.length, props.searching, props.hasFolders);
  if (status) return <p className="status" role="status">{status}</p>;
  const pageIds = props.files.map((file) => file.id);
  return (
    <div className="file-card-list">
      <label className="pick">
        <input
          type="checkbox"
          aria-label="Select every file on this page"
          checked={props.files.every((file) => props.selected.includes(file.id))}
          onChange={(event) => props.onTogglePage?.(pageIds, event.target.checked)}
        />
        Select page
      </label>
      <ul className="file-cards">
        {props.files.map((file) => (
          <li key={file.id} className="file-card">
            <input
              type="checkbox"
              aria-label={`Select ${file.originalName}`}
              checked={props.selected.includes(file.id)}
              onChange={(event) => props.onToggle(file.id, event.target.checked)}
            />
            <FavoriteButton {...props} file={file} />
            <div className="file-card-main">
              <FileName file={file} searching={props.searching} />
              <p className="meta">
                {formatBytes(file.sizeBytes)}
                {' · '}
                <UploadedAt iso={file.createdAt} />
                {' · '}
                {file.ownerUsername}
              </p>
            </div>
            <FileActions {...props} file={file} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FileGrid(props: FileListProps) {
  const status = fileStatus(props.loading, props.files.length, props.searching, props.hasFolders);
  if (status) return <p className="status" role="status">{status}</p>;
  return (
    <ul className="grid">
      {props.files.map((file) => (
        <li key={file.id} className="tile">
          <label className="pick">
            <input
              type="checkbox"
              aria-label={`Select ${file.originalName}`}
              checked={props.selected.includes(file.id)}
              onChange={(event) => props.onToggle(file.id, event.target.checked)}
            />
            Select
          </label>
          <FavoriteButton {...props} file={file} />
          {file.preview === 'image' ? (
            <img className="thumb" alt="" src={`/api/files/${encodeURIComponent(file.id)}/thumbnail`} />
          ) : null}
          <FileName file={file} searching={props.searching} />
          <p className="meta">{formatBytes(file.sizeBytes)} · {file.ownerUsername}</p>
          <p className="meta"><UploadedAt iso={file.createdAt} /></p>
          <FileActions {...props} file={file} />
        </li>
      ))}
    </ul>
  );
}

function FileName({ file, searching }: { file: PortalFile; searching: boolean }) {
  const tags = file.tags ?? [];
  return (
    <div className="file-name">
      <span className="filename" title={file.originalName}>{file.originalName}</span>
      {searching && file.folderName ? <span className="meta">In {file.folderName}</span> : null}
      {tags.length > 0 ? (
        <ul className="file-tags">
          {tags.map((tag) => <li key={tag.id} className="chip">{tag.name}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function UploadedAt({ iso }: { iso: string }) {
  return <time dateTime={iso} aria-label={formatWhen(iso)} title={formatWhen(iso)}>{formatCompactWhen(iso)}</time>;
}

function FavoriteButton({ file, csrfToken, onChanged, onError }: FileActionProps) {
  async function star() {
    onError('');
    try {
      await setFavorite(file.id, !file.favorite, csrfToken);
      await onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'The favorite could not be saved.');
    }
  }

  return (
    <button
      type="button"
      className="ghost icon-button"
      aria-pressed={Boolean(file.favorite)}
      aria-label={file.favorite ? `Remove ${file.originalName} from favorites` : `Add ${file.originalName} to favorites`}
      onClick={() => void star()}
    >
      {file.favorite ? '★' : '☆'}
    </button>
  );
}

function FileActions(props: FileActionProps) {
  return (
    <div className="file-actions">
      <a
        className="button file-download"
        href={`/api/files/${encodeURIComponent(props.file.id)}/download`}
        onClick={(event) => {
          event.preventDefault();
          props.onDownload(`/api/files/${encodeURIComponent(props.file.id)}/download`, props.file.originalName);
        }}
      >
        Download
      </a>
      <FileMenu {...props} />
    </div>
  );
}

function FileMenu(props: FileActionProps) {
  const { file } = props;
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  function closeMenu(restore = true) {
    setOpen(false);
    setConfirming(false);
    if (restore) buttonRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'ArrowDown' ? (current + 1) % items.length : (current <= 0 ? items.length - 1 : current - 1);
      items[next]?.focus();
    }
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
      setConfirming(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  async function chooseReplacement(chosen: FileList | null) {
    const next = chosen?.item(0);
    if (!next) return;
    setBusy(true);
    props.onError('');
    try {
      await replaceFile(file.id, next, props.csrfToken);
      closeMenu(false);
      await props.onChanged();
    } catch (caught) {
      props.onError(caught instanceof ApiError ? caught.message : 'The file could not be replaced.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    props.onError('');
    try {
      await deleteFile(file.id, props.csrfToken);
      closeMenu(false);
      await props.onChanged();
    } catch (caught) {
      props.onError(caught instanceof ApiError ? caught.message : 'The file could not be deleted.');
    } finally {
      setDeleting(false);
    }
  }

  async function leaveCollection() {
    props.onError('');
    try {
      await removeFromCollection(props.collectionId, file.id, props.csrfToken);
      closeMenu(false);
      await props.onChanged();
    } catch (caught) {
      props.onError(caught instanceof ApiError ? caught.message : 'The file could not be removed from the collection.');
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="ghost icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${file.originalName}`}
        onClick={() => setOpen((current) => !current)}
      >
        ⋯
      </button>
      {open ? (
        <div ref={menuRef} className="file-menu" role="menu" aria-label={`Actions for ${file.originalName}`}>
          <p className="meta">Uploaded {formatWhen(file.createdAt)}</p>
          {confirming ? (
            <>
              <p>Move this file to the bin?</p>
              <button type="button" role="menuitem" className="danger" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? 'Moving…' : 'Move to bin'}
              </button>
              <button type="button" role="menuitem" className="ghost" onClick={() => setConfirming(false)}>Keep</button>
            </>
          ) : (
            <>
              {file.preview === 'image' || file.preview === 'text' ? (
                <button type="button" role="menuitem" className="ghost" onClick={() => { closeMenu(false); props.onPreview(file); }}>Preview</button>
              ) : null}
              {props.canDirect(file) ? (
                <button type="button" role="menuitem" className="ghost" disabled={props.takingId === file.id} onClick={() => { closeMenu(false); props.onDirect(file); }}>
                  {props.takingId === file.id ? 'Receiving…' : 'Direct'}
                </button>
              ) : null}
              {file.canDelete ? (
                <button type="button" role="menuitem" className="ghost" disabled={busy} onClick={() => inputRef.current?.click()}>
                  {busy ? 'Replacing…' : 'Replace'}
                </button>
              ) : null}
              {(file.versionCount ?? 0) > 0 ? (
                <button type="button" role="menuitem" className="ghost" onClick={() => { setVersionsOpen(true); closeMenu(false); }}>
                  {file.versionCount === 1 ? '1 earlier version' : `${file.versionCount} earlier versions`}
                </button>
              ) : null}
              <button type="button" role="menuitem" className="ghost" onClick={() => { setTagsOpen(true); closeMenu(false); }}>Edit tags</button>
              {props.collectionId ? (
                <button type="button" role="menuitem" className="ghost" onClick={() => void leaveCollection()}>Remove from collection</button>
              ) : null}
              {file.canDelete ? (
                <button type="button" role="menuitem" className="ghost danger" onClick={() => setConfirming(true)}>Delete</button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {file.canDelete ? (
        <input
          ref={inputRef}
          className="sr-input"
          type="file"
          aria-label={`Replace ${file.originalName}`}
          onChange={(event) => {
            const chosen = event.target.files;
            event.target.value = '';
            void chooseReplacement(chosen);
          }}
        />
      ) : null}
      <TagDialog {...props} open={tagsOpen} onClose={() => { setTagsOpen(false); buttonRef.current?.focus(); }} />
      <VersionDialog {...props} open={versionsOpen} onClose={() => { setVersionsOpen(false); buttonRef.current?.focus(); }} />
    </>
  );
}

function TagDialog({
  file,
  csrfToken,
  open,
  onClose,
  onChanged,
  onError,
}: FileActionProps & { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState('');
  const fieldId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector('input')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  async function addTag(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    onError('');
    try {
      await tagFiles([file.id], draft, csrfToken);
      setDraft('');
      await onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'The tag could not be saved.');
    }
  }

  async function removeTag(id: string) {
    onError('');
    try {
      await detachTag(file.id, id, csrfToken);
      await onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'The tag could not be removed.');
    }
  }

  return (
    <dialog ref={dialogRef} className="library-dialog" aria-labelledby={`tags-${file.id}`} onClose={onClose}>
      <h2 id={`tags-${file.id}`}>Tags for {file.originalName}</h2>
      {(file.tags ?? []).length === 0 ? <p className="meta">No tags yet.</p> : (
        <ul className="file-tags">
          {(file.tags ?? []).map((tag) => (
            <li key={tag.id} className="chip">
              {tag.name}
              <button type="button" className="ghost" aria-label={`Remove tag ${tag.name} from ${file.originalName}`} onClick={() => void removeTag(tag.id)}>×</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void addTag(event)}>
        <label htmlFor={fieldId}>Add tag</label>
        <input id={fieldId} list="portal-tags" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <div className="actions">
          <button type="submit" disabled={!draft.trim()}>Add</button>
          <button type="button" className="ghost" onClick={() => dialogRef.current?.close()}>Close</button>
        </div>
      </form>
    </dialog>
  );
}

function VersionDialog({
  file,
  csrfToken,
  open,
  onClose,
  onChanged,
  onError,
  onDownload,
}: FileActionProps & { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let stop = false;
    void listVersions(file.id).then((next) => {
      if (!stop) setVersions(next.versions);
    }).catch((caught: unknown) => {
      if (!stop) onError(caught instanceof ApiError ? caught.message : 'The earlier versions could not be loaded.');
    });
    return () => { stop = true; };
  }, [open, file.id, onError]);

  async function removeVersion(versionId: string) {
    setBusy(true);
    onError('');
    try {
      await deleteVersion(file.id, versionId, csrfToken);
      const next = await listVersions(file.id);
      setVersions(next.versions);
      await onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'The version could not be removed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="library-dialog" aria-labelledby={`versions-${file.id}`} onClose={onClose}>
      <h2 id={`versions-${file.id}`}>Earlier versions of {file.originalName}</h2>
      {versions.length === 0 ? <p className="meta">No earlier versions are available.</p> : (
        <ul className="versions">
          {versions.map((version) => (
            <li key={version.id}>
              <span className="filename">{version.originalName}</span>
              <span className="meta">{formatBytes(version.sizeBytes)} · {formatWhen(version.createdAt)}</span>
              <a
                href={`/api/files/${encodeURIComponent(file.id)}/versions/${encodeURIComponent(version.id)}/download`}
                onClick={(event) => {
                  event.preventDefault();
                  onDownload(`/api/files/${encodeURIComponent(file.id)}/versions/${encodeURIComponent(version.id)}/download`, version.originalName);
                }}
              >
                Download
              </a>
              {file.canDelete ? (
                <button type="button" className="ghost danger" disabled={busy} onClick={() => void removeVersion(version.id)}>Remove</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="ghost" onClick={() => dialogRef.current?.close()}>Close</button>
      </div>
    </dialog>
  );
}
