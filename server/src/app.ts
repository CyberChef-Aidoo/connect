import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from './config.js';
import { openDatabase } from './db.js';
import {
  deleteOwnedFile,
  deleteOwnedFiles,
  getReadyFile,
  commitReplacement,
  deleteOwnedVersion,
  listBin,
  listFileVersions,
  listFiles,
  purgeOwnedBinFile,
  replacementTarget,
  restoreOwnedFile,
  takeExpiredBinIds,
  versionIdsForFile,
  DEFAULT_PAGE_SIZE,
  displayedUsedBytes,
  MAX_PAGE_SIZE,
  markReady,
  moveOwnedFiles,
  removeFileRecord,
  reservedBytes,
  stageFile,
} from './files.js';
import {
  breadcrumbs,
  createFolder,
  deleteFolder,
  ensureFolderPath,
  listChildFolders,
  renameFolder,
  resolveFolder,
  splitFolderPath,
} from './folders.js';
import { uniqueZipName, writeStoredZip } from './zip.js';
import { createTransferTracker, readProgressId, safeTransferName, writeChunks, type TransferTracker } from './transferTrack.js';
import {
  addToCollection,
  attachTag,
  collectionExists,
  createCollection,
  deleteCollection,
  detachTag,
  listCollections,
  listTags,
  removeFromCollection,
  removeUnusedTags,
  renameCollection,
  setFavorite,
  tagExists,
} from './catalog.js';
import { formatBytes } from './format.js';
import { createPeerHub } from './peers.js';
import { registerShareRoutes } from './shareHttp.js';
import { createShareHub } from './shares.js';
import { scheduleThumbnail } from './jobs.js';
import { imageContentType, previewKind, readTextSample, TEXT_PREVIEW_MAX_BYTES } from './preview.js';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.js';
import { SqliteSessionStore } from './session-store.js';
import { UploadSlots } from './slots.js';
import {
  attachmentDisposition,
  ensureStorage,
  fileSize,
  mapFsError,
  objectPath,
  sanitizeOriginalName,
  syncFile,
  tempPath,
  thumbPath,
} from './storage.js';
import type { Limits } from './types.js';
import {
  CHUNK_BYTES,
  advanceSession,
  createUploadSession,
  deleteOwnedSession,
  getOwnedSession,
  listOpenSessions,
  sweepExpired,
  takeForPublish,
  tryLockSession,
  unlockSession,
  writeChunk,
} from './resume.js';
import { createUser, findUserById, findUserByUsername } from './users.js';
import { discardTemp, receiveUpload, type TempWriter } from './uploads.js';

export type AppOptions = {
  passwordCost?: number;
  openTemp?: TempWriter;
};

export type AppHandle = {
  app: express.Express;
  db: DatabaseSync;
  config: AppConfig;
  close: () => void;
};

const GENERIC_LOGIN_ERROR = 'Invalid username or password.';

export async function createApp(config: AppConfig, options: AppOptions = {}): Promise<AppHandle> {
  await ensureStorage(config.storageDir);
  const db = openDatabase(config.databasePath);
  const sessions = new SqliteSessionStore(db);
  sessions.clearExpired();
  const passwordCost = options.passwordCost ?? 12;
  const dummyHash = await hashPassword('not-a-real-password', passwordCost);
  const slots = new UploadSlots(config.maxUploadsPerUser, config.maxUploadsGlobal);
  const peers = createPeerHub();
  const shareHub = createShareHub(config.maxFileBytes);
  const transfers = createTransferTracker();
  const limits = publicLimits(config);

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.https ? [] : null,
      },
    },
    // A locally trusted certificate should not be pinned with HSTS.
    strictTransportSecurity: false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/shares', express.json({ limit: '512kb' }));
  app.use(express.json({ limit: '20kb' }));
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const origin = req.get('origin');
    if (!origin) {
      next();
      return;
    }
    try {
      const url = new URL(origin);
      if (url.host !== req.get('host')) {
        res.status(403).json({ error: 'This action must come from this portal.' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'This action must come from this portal.' });
      return;
    }
    next();
  });
  app.use(session({
    name: 'portal.sid',
    secret: config.sessionSecret,
    store: sessions,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: Boolean(config.https),
      maxAge: config.sessionTtlMs,
      path: '/',
    },
  }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.loginRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many sign-in attempts. Wait and try again.' },
  });

  app.get('/api/auth/me', (req, res, next) => {
    void (async () => {
      let user = currentUser(db, req);
      if (!user && config.openAccess) {
        user = await ensureOpenUser(db, passwordCost);
        await regenerateSession(req);
        req.session.userId = user.id;
        req.session.csrfToken = randomBytes(32).toString('base64url');
        await saveSession(req);
      }
      if (!user) {
        res.status(401).json({ error: 'Sign in required.' });
        return;
      }
      res.json(sessionBody(user, req.session.csrfToken ?? '', config));
    })().catch(next);
  });

  app.post('/api/auth/login', loginLimiter, (req, res, next) => {
    void (async () => {
      const credentials = readCredentials(req.body);
      if (!credentials) {
        res.status(401).json({ error: GENERIC_LOGIN_ERROR });
        return;
      }
      const user = findUserByUsername(db, credentials.username);
      const accepted = await verifyPassword(credentials.password, user?.passwordHash, dummyHash);
      if (!user || !accepted) {
        res.status(401).json({ error: GENERIC_LOGIN_ERROR });
        return;
      }
      await regenerateSession(req);
      req.session.userId = user.id;
      req.session.csrfToken = randomBytes(32).toString('base64url');
      await saveSession(req);
      res.json(sessionBody(user, req.session.csrfToken ?? '', config));
    })().catch(next);
  });

  app.post('/api/peers/heartbeat', requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const peerId = await ensurePeerId(req);
      peers.beat(req.session.userId!, peerId);
      shareHub.beat(peerId, req.body?.displayName);
      res.json({ ok: true, peerId });
    } catch (error) {
      next(error);
    }
  });

  registerShareRoutes(app, shareHub, requireAuth, requireCsrf, ensurePeerId, transfers);

  app.get('/api/transfers/:id', requireAuth, (req, res) => {
    const viewed = transfers.view(req.session.userId!, routeId(req));
    if (!viewed) {
      res.status(404).json({ error: 'That transfer is not available.' });
      return;
    }
    res.json(viewed);
  });

  app.delete('/api/transfers/:id', requireAuth, requireCsrf, (req, res) => {
    if (!transfers.cancel(req.session.userId!, routeId(req))) {
      res.status(404).json({ error: 'That transfer is not available.' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/peers', requireAuth, async (req, res, next) => {
    try {
      const self = await ensurePeerId(req);
      const browsers = peers.onlineBrowsers()
        .filter((browser) => browser.peerId !== self)
        .map((browser) => ({ userId: browser.userId, peerId: browser.peerId }));
      res.json({
        online: [...new Set(browsers.map((browser) => browser.userId))],
        browsers,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/signals', requireAuth, async (req, res, next) => {
    try {
      res.json({ signals: peers.take(await ensurePeerId(req)) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/signals', requireAuth, requireCsrf, async (req, res, next) => {
    try {
    const body = req.body ?? {};
    const fileId = typeof body.fileId === 'string' ? body.fileId : '';
    const record = getReadyFile(db, fileId, req.session.userId!);
    if (!record) {
      res.status(404).json({ error: 'That file is not available.' });
      return;
    }
    const result = peers.post({
      fromUserId: req.session.userId!,
      fromPeerId: await ensurePeerId(req),
      fileOwnerId: record.ownerId,
      fileId: record.id,
      toUserId: typeof body.toUserId === 'string' ? body.toUserId : '',
      kind: typeof body.kind === 'string' ? body.kind : '',
      transferId: typeof body.transferId === 'string' ? body.transferId : undefined,
      payload: body.payload,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ transferId: result.transferId });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout', requireAuth, requireCsrf, (req, res, next) => {
    const cookie = sessionCookieOptions(config);
    req.session.destroy((error) => {
      if (error) {
        next(error);
        return;
      }
      res.clearCookie('portal.sid', cookie);
      res.json({ ok: true });
    });
  });

  app.get('/api/files', requireAuth, (req, res, next) => {
    void (async () => {
    await sweepBin(db, config);
    const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 255) : '';
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'date';
    const order = typeof req.query.order === 'string' ? req.query.order : 'desc';
    const limit = readPageLimit(req.query.limit);
    if (limit === null) {
      res.status(400).json({ error: 'Ask for 1 to 100 files per page.' });
      return;
    }
    const requestedFolder = typeof req.query.folderId === 'string' ? req.query.folderId : '';
    const folder = requestedFolder ? resolveFolder(db, requestedFolder) : { ok: true as const, folderId: null };
    if (!folder.ok) {
      res.status(404).json({ error: 'That folder is not in the portal.' });
      return;
    }
    const trail = folder.folderId ? breadcrumbs(db, folder.folderId) : [];
    if (!trail) {
      res.status(404).json({ error: 'That folder is not in the portal.' });
      return;
    }
    const favoriteOnly = req.query.favorite === '1';
    const tagId = typeof req.query.tagId === 'string' ? req.query.tagId : '';
    const collectionId = typeof req.query.collectionId === 'string' ? req.query.collectionId : '';
    if (tagId && !tagExists(db, tagId)) {
      res.status(404).json({ error: 'That tag is not in the portal.' });
      return;
    }
    if (collectionId && !collectionExists(db, collectionId)) {
      res.status(404).json({ error: 'That collection is not in the portal.' });
      return;
    }
    const wide = Boolean(query || favoriteOnly || tagId || collectionId);
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null;
    const page = listFiles(db, {
      query,
      sort,
      order,
      userId: req.session.userId!,
      folderId: wide ? null : folder.folderId,
      limit,
      cursor,
      favoriteOnly,
      tagId: tagId || null,
      collectionId: collectionId || null,
    });
    if (page === 'bad-sort') {
      res.status(400).json({ error: 'Sort by name, size, or date, in ascending or descending order.' });
      return;
    }
    if (page === 'bad-cursor') {
      res.status(400).json({ error: 'That page is no longer valid. Go back to the first page.' });
      return;
    }
    res.json({
      files: page.files,
      folders: wide ? [] : listChildFolders(db, folder.folderId, req.session.userId!),
      breadcrumbs: trail,
      page: { limit, nextCursor: page.nextCursor },
      storage: { usedBytes: displayedUsedBytes(db), limitBytes: config.maxStorageBytes },
      limits,
    });
    })().catch(next);
  });

  app.get('/api/bin', requireAuth, (req, res, next) => {
    void handleBin(req, res, db, config).catch(next);
  });

  app.post('/api/folders', requireAuth, requireCsrf, (req, res) => {
    const userId = req.session.userId!;
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const parentRaw = req.body?.parentId;
    const parentId = parentRaw == null || parentRaw === '' ? null : typeof parentRaw === 'string' ? parentRaw : null;
    if (parentRaw != null && parentRaw !== '' && typeof parentRaw !== 'string') {
      res.status(400).json({ error: 'That folder is not in the portal.' });
      return;
    }
    if (parentId) {
      const parent = resolveFolder(db, parentId);
      if (!parent.ok) {
        res.status(404).json({ error: 'That folder is not in the portal.' });
        return;
      }
    }
    const created = createFolder(db, { parentId, name, createdBy: userId });
    if (!created.ok) {
      sendFolderFailure(res, created.reason);
      return;
    }
    res.status(201).json({ folder: created.folder });
  });

  app.patch('/api/folders/:id', requireAuth, requireCsrf, (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const renamed = renameFolder(db, routeId(req), req.session.userId!, name);
    if (!renamed.ok) {
      sendFolderFailure(res, renamed.reason);
      return;
    }
    res.json({ folder: renamed.folder });
  });

  app.post('/api/folders/ensure', requireAuth, requireCsrf, (req, res) => {
    const parentRaw = req.body?.parentId;
    if (parentRaw != null && parentRaw !== '' && typeof parentRaw !== 'string') {
      res.status(400).json({ error: 'That folder is not in the portal.' });
      return;
    }
    const parentId = typeof parentRaw === 'string' && parentRaw ? parentRaw : null;
    if (parentId && !resolveFolder(db, parentId).ok) {
      res.status(404).json({ error: 'That folder is not in the portal.' });
      return;
    }
    const segments = splitFolderPath(typeof req.body?.path === 'string' ? req.body.path : '');
    if (!segments) {
      res.status(400).json({ error: 'That folder name cannot be used.' });
      return;
    }
    const ensured = ensureFolderPath(db, parentId, segments, req.session.userId!);
    if (!ensured.ok) {
      sendFolderFailure(res, ensured.reason);
      return;
    }
    res.status(201).json({ folderId: ensured.folderId, created: ensured.created });
  });

  app.delete('/api/folders/:id', requireAuth, requireCsrf, (req, res) => {
    const removed = deleteFolder(db, routeId(req), req.session.userId!);
    if (!removed.ok) {
      sendFolderFailure(res, removed.reason);
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/uploads', requireAuth, requireCsrf, (req, res, next) => {
    void handleCreateUpload(req, res, { db, config }).catch(next);
  });

  app.get('/api/uploads', requireAuth, (req, res, next) => {
    void handleListUploads(req, res, { db, config }).catch(next);
  });

  app.patch('/api/uploads/:id', requireAuth, requireCsrf, (req, res, next) => {
    void handleAppendUpload(req, res, { db, config, slots }).catch(next);
  });

  app.delete('/api/uploads/:id', requireAuth, requireCsrf, (req, res, next) => {
    void handleCancelUpload(req, res, { db, config }).catch(next);
  });

  app.post('/api/files', requireAuth, requireCsrf, (req, res, next) => {
    void handleUpload(req, res, {
      db,
      config,
      slots,
      openTemp: options.openTemp,
    }).catch(next);
  });

  app.post('/api/files/move', requireAuth, requireCsrf, (req, res) => {
    const ids = readIds(req.body?.ids);
    if (!ids) {
      res.status(400).json({ error: 'Choose 1 to 100 files.' });
      return;
    }
    const folderRaw = req.body?.folderId;
    if (folderRaw != null && typeof folderRaw !== 'string') {
      res.status(400).json({ error: 'That folder is not in the portal.' });
      return;
    }
    const folder = resolveFolder(db, typeof folderRaw === 'string' && folderRaw ? folderRaw : null);
    if (!folder.ok) {
      res.status(404).json({ error: 'That folder is not in the portal.' });
      return;
    }
    res.json(moveOwnedFiles(db, req.session.userId!, ids, folder.folderId));
  });

  app.post('/api/files/delete-many', requireAuth, requireCsrf, (req, res, next) => {
    void handleDeleteMany(req, res, db, config).catch(next);
  });

  app.get('/api/tags', requireAuth, (_req, res) => {
    res.json({ tags: listTags(db) });
  });

  app.post('/api/files/tags', requireAuth, requireCsrf, (req, res) => {
    const ids = readIds(req.body?.ids);
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    if (!ids) {
      res.status(400).json({ error: 'Choose 1 to 100 files.' });
      return;
    }
    const tagged = attachTag(db, req.session.userId!, ids, name);
    if (!tagged.ok) {
      res.status(400).json({ error: 'That tag name cannot be used.' });
      return;
    }
    res.status(201).json(tagged);
  });

  app.post('/api/files/:id/favorite', requireAuth, requireCsrf, (req, res) => {
    if (!setFavorite(db, req.session.userId!, routeId(req), true)) {
      res.status(404).json({ error: 'That file is not in the portal.' });
      return;
    }
    res.json({ favorite: true });
  });

  app.delete('/api/files/:id/favorite', requireAuth, requireCsrf, (req, res) => {
    if (!setFavorite(db, req.session.userId!, routeId(req), false)) {
      res.status(404).json({ error: 'That file is not in the portal.' });
      return;
    }
    res.json({ favorite: false });
  });

  app.delete('/api/files/:id/tags/:tagId', requireAuth, requireCsrf, (req, res) => {
    const tagId = typeof req.params.tagId === 'string' ? req.params.tagId : '';
    if (!detachTag(db, routeId(req), tagId)) {
      res.status(404).json({ error: 'That tag is not on the file.' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/collections', requireAuth, (req, res) => {
    res.json({ collections: listCollections(db, req.session.userId!) });
  });

  app.post('/api/collections', requireAuth, requireCsrf, (req, res) => {
    const created = createCollection(db, req.session.userId!, typeof req.body?.name === 'string' ? req.body.name : '');
    if (!created.ok) {
      sendCatalogFailure(res, created.reason);
      return;
    }
    res.status(201).json({ collection: created.collection });
  });

  app.patch('/api/collections/:id', requireAuth, requireCsrf, (req, res) => {
    const renamed = renameCollection(
      db,
      routeId(req),
      req.session.userId!,
      typeof req.body?.name === 'string' ? req.body.name : '',
    );
    if (!renamed.ok) {
      sendCatalogFailure(res, renamed.reason);
      return;
    }
    res.json({ collection: renamed.collection });
  });

  app.delete('/api/collections/:id', requireAuth, requireCsrf, (req, res) => {
    const removed = deleteCollection(db, routeId(req), req.session.userId!);
    if (removed !== 'deleted') {
      sendCatalogFailure(res, removed);
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/collections/:id/files', requireAuth, requireCsrf, (req, res) => {
    const ids = readIds(req.body?.ids);
    if (!ids) {
      res.status(400).json({ error: 'Choose 1 to 100 files.' });
      return;
    }
    const added = addToCollection(db, routeId(req), req.session.userId!, ids);
    if (!added.ok) {
      res.status(404).json({ error: 'That collection is not in the portal.' });
      return;
    }
    res.json(added);
  });

  app.delete('/api/collections/:id/files/:fileId', requireAuth, requireCsrf, (req, res) => {
    const fileId = typeof req.params.fileId === 'string' ? req.params.fileId : '';
    if (!removeFromCollection(db, routeId(req), fileId)) {
      res.status(404).json({ error: 'That file is not in the collection.' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/files/zip', requireAuth, (req, res, next) => {
    void handleZip(req, res, db, config, transfers).catch(next);
  });

  app.get('/api/files/:id/preview', requireAuth, (req, res, next) => {
    void handlePreview(req, res, db, config).catch(next);
  });

  app.get('/api/files/:id/thumbnail', requireAuth, (req, res, next) => {
    void handleThumbnail(req, res, db, config).catch(next);
  });

  app.get('/api/files/:id/download', requireAuth, (req, res, next) => {
    void handleDownload(req, res, db, config, transfers).catch(next);
  });

  app.post('/api/files/:id/replace', requireAuth, requireCsrf, (req, res, next) => {
    void handleReplace(req, res, { db, config, slots }).catch(next);
  });

  app.get('/api/files/:id/versions', requireAuth, (req, res) => {
    const record = getReadyFile(db, routeId(req), req.session.userId!);
    if (!record) {
      res.status(404).json({ error: 'That file is not in the portal.' });
      return;
    }
    res.json({
      versions: listFileVersions(db, record.id).map((version) => ({
        id: version.id,
        originalName: version.originalName,
        sizeBytes: version.sizeBytes,
        createdAt: version.createdAt,
      })),
    });
  });

  app.get('/api/files/:id/versions/:versionId/download', requireAuth, (req, res, next) => {
    void handleVersionDownload(req, res, db, config, transfers).catch(next);
  });

  app.delete('/api/files/:id/versions/:versionId', requireAuth, requireCsrf, (req, res, next) => {
    void handleVersionDelete(req, res, db, config).catch(next);
  });

  app.post('/api/files/:id/restore', requireAuth, requireCsrf, (req, res) => {
    const restored = restoreOwnedFile(db, routeId(req), req.session.userId!);
    if (restored === 'missing') {
      res.status(404).json({ error: 'That file is not in the bin.' });
      return;
    }
    if (restored === 'forbidden') {
      res.status(403).json({ error: 'You can restore only files you uploaded.' });
      return;
    }
    const file = getReadyFile(db, routeId(req), req.session.userId!);
    res.json({ file });
  });

  app.delete('/api/files/:id/permanent', requireAuth, requireCsrf, (req, res, next) => {
    void handlePermanentDelete(req, res, db, config).catch(next);
  });

  app.delete('/api/files/:id', requireAuth, requireCsrf, (req, res, next) => {
    void handleDelete(req, res, db, config).catch(next);
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  if (config.staticDir && existsSync(path.join(config.staticDir, 'index.html'))) {
    const indexHtml = path.join(config.staticDir, 'index.html');
    app.use(express.static(config.staticDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(`${path.sep}index.html`)) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      if (path.extname(req.path)) {
        res.status(404).end();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml, (error) => {
        if (error) next();
      });
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`request failed: ${message}`);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return {
    app,
    db,
    config,
    close() {
      db.close();
    },
  };
}

function publicLimits(config: AppConfig): Limits {
  return {
    maxFileBytes: config.maxFileBytes,
    maxStorageBytes: config.maxStorageBytes,
  };
}

function sessionBody(user: { id: string; username: string }, csrfToken: string, config: AppConfig) {
  return {
    user: { id: user.id, username: user.username },
    csrfToken,
    limits: publicLimits(config),
    uploads: {
      maxPerUser: config.maxUploadsPerUser,
      maxGlobal: config.maxUploadsGlobal,
    },
    openAccess: config.openAccess,
  };
}

async function ensureOpenUser(db: DatabaseSync, cost: number) {
  const existing = findUserByUsername(db, 'local');
  if (existing) return existing;
  try {
    return await createUser(db, 'local', randomBytes(32).toString('base64url'), cost);
  } catch (error) {
    const again = findUserByUsername(db, 'local');
    if (again) return again;
    throw error;
  }
}

function currentUser(db: DatabaseSync, req: Request) {
  if (!req.session.userId) return undefined;
  return findUserById(db, req.session.userId);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  next();
}

function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('x-csrf-token');
  const token = req.session.csrfToken;
  if (!header || !token || !sameToken(header, token)) {
    res.status(403).json({ error: 'This page is out of date. Refresh it and try again.' });
    return;
  }
  next();
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readCredentials(body: unknown): { username: string; password: string } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.username !== 'string' || typeof record.password !== 'string') return null;
  const username = record.username.trim();
  const password = record.password;
  if (!username || username.length > 32 || password.length === 0 || password.length > 200) return null;
  if (Buffer.byteLength(password) > 72) return null;
  const problem = passwordProblem(password);
  if (problem) return null;
  return { username, password };
}

function sessionCookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: Boolean(config.https),
    path: '/',
  };
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

async function ensurePeerId(req: Request): Promise<string> {
  if (!req.session.peerId) {
    req.session.peerId = randomUUID();
    await saveSession(req);
  }
  return req.session.peerId;
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

async function handleCreateUpload(
  req: Request,
  res: Response,
  ctx: { db: DatabaseSync; config: AppConfig },
): Promise<void> {
  await sweepBin(ctx.db, ctx.config);
  const userId = req.session.userId!;
  const request = readUploadStart(req.body);
  if (!request) {
    res.status(400).json({ error: 'Say which file you are uploading, and how large it is.' });
    return;
  }
  const originalName = sanitizeOriginalName(request.originalName);
  if (!originalName) {
    res.status(400).json({ error: 'That file name cannot be used.' });
    return;
  }
  if (request.sizeBytes > ctx.config.maxFileBytes) {
    res.status(413).json({
      error: `Each file must be ${formatBytes(ctx.config.maxFileBytes)} or smaller.`,
    });
    return;
  }

  const folder = resolveFolder(ctx.db, request.folderId);
  if (!folder.ok) {
    res.status(404).json({ error: 'That folder is not in the portal.' });
    return;
  }

  const nowIso = new Date().toISOString();
  await removeSessionTemps(ctx.config.storageDir, sweepExpired(ctx.db, userId, nowIso));

  if (request.sizeBytes === 0) {
    const id = randomUUID();
    const partial = tempPath(ctx.config.storageDir, id);
    if (!partial) {
      res.status(500).json({ error: 'The upload could not be saved.' });
      return;
    }
    try {
      await writeFile(partial, Buffer.alloc(0));
      const staged = stageFile(ctx.db, {
        id,
        ownerId: userId,
        originalName,
        sizeBytes: 0,
        createdAt: nowIso,
        folderId: folder.folderId,
      }, ctx.config.maxStorageBytes);
      if (!staged.ok) {
        await rm(partial, { force: true });
        res.status(507).json({ error: 'Shared storage is full.' });
        return;
      }
      const published = await publishStagedTemp(ctx.db, ctx.config, id, userId);
      if (!published.ok) {
        res.status(published.status).json({ error: published.error });
        return;
      }
      res.status(201).json({ file: published.file });
    } catch (error) {
      await rm(partial, { force: true });
      const mapped = mapFsError(error);
      res.status(mapped.httpStatus).json({ error: mapped.message });
    }
    return;
  }

  const id = randomUUID();
  const created = createUploadSession(ctx.db, {
    id,
    ownerId: userId,
    originalName,
    sizeBytes: request.sizeBytes,
    folderId: folder.folderId,
  }, ctx.config.maxStorageBytes);
  if (!created.ok) {
    const status = created.reason === 'quota' ? 507 : created.reason === 'missing-folder' ? 404 : 429;
    const error = created.reason === 'quota'
      ? 'Shared storage is full.'
      : created.reason === 'missing-folder'
        ? 'That folder is not in the portal.'
        : 'Too many unfinished uploads. Finish or cancel one before starting another.';
    res.status(status).json({ error });
    return;
  }
  const partial = tempPath(ctx.config.storageDir, id);
  if (!partial) {
    deleteOwnedSession(ctx.db, id, userId);
    res.status(500).json({ error: 'The upload could not be saved.' });
    return;
  }
  try {
    await writeFile(partial, Buffer.alloc(0));
  } catch (error) {
    deleteOwnedSession(ctx.db, id, userId);
    const mapped = mapFsError(error);
    res.status(mapped.httpStatus).json({ error: mapped.message });
    return;
  }
  res.status(201).json({ session: created.session, chunkBytes: CHUNK_BYTES });
}

async function handleListUploads(
  req: Request,
  res: Response,
  ctx: { db: DatabaseSync; config: AppConfig },
): Promise<void> {
  const userId = req.session.userId!;
  const nowIso = new Date().toISOString();
  await removeSessionTemps(ctx.config.storageDir, sweepExpired(ctx.db, userId, nowIso));
  res.json({
    sessions: listOpenSessions(ctx.db, userId, nowIso),
    chunkBytes: CHUNK_BYTES,
  });
}

async function handleCancelUpload(
  req: Request,
  res: Response,
  ctx: { db: DatabaseSync; config: AppConfig },
): Promise<void> {
  const userId = req.session.userId!;
  const id = routeId(req);
  if (!getOwnedSession(ctx.db, id, userId)) {
    res.status(404).json({ error: 'That upload is not available.' });
    return;
  }
  if (!tryLockSession(id)) {
    res.status(409).json({ error: 'This upload is still receiving data.' });
    return;
  }
  try {
    if (!deleteOwnedSession(ctx.db, id, userId)) {
      res.status(404).json({ error: 'That upload is not available.' });
      return;
    }
    await removeSessionTemps(ctx.config.storageDir, [id]);
    res.json({ ok: true });
  } finally {
    unlockSession(id);
  }
}

async function handleAppendUpload(
  req: Request,
  res: Response,
  ctx: { db: DatabaseSync; config: AppConfig; slots: UploadSlots },
): Promise<void> {
  const userId = req.session.userId!;
  if (!ctx.slots.tryAcquire(userId)) {
    req.resume();
    res.status(429).json({ error: 'Too many uploads are already running. Wait for one to finish.' });
    return;
  }
  const id = routeId(req);
  let locked = false;
  try {
    const partial = tempPath(ctx.config.storageDir, id);
    if (!partial) {
      req.resume();
      res.status(404).json({ error: 'That upload is not available.' });
      return;
    }
    if (!tryLockSession(id)) {
      req.resume();
      const current = getOwnedSession(ctx.db, id, userId);
      res.status(409).json({
        error: 'This upload is already receiving data.',
        receivedBytes: current?.receivedBytes ?? 0,
      });
      return;
    }
    locked = true;

    const session = getOwnedSession(ctx.db, id, userId);
    if (!session) {
      req.resume();
      res.status(404).json({ error: 'That upload is not available.' });
      return;
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      deleteOwnedSession(ctx.db, id, userId);
      await rm(partial, { force: true });
      req.resume();
      res.status(410).json({ error: 'That upload expired. Choose the file to start again.' });
      return;
    }

    const offset = readOffset(req.get('upload-offset'));
    if (offset === null) {
      req.resume();
      res.status(400).json({ error: 'Say where this part belongs with the Upload-Offset header.' });
      return;
    }
    if (offset !== session.receivedBytes) {
      req.resume();
      res.status(409).json({
        error: 'The server has a different amount of this file. Continue from the saved position.',
        receivedBytes: session.receivedBytes,
      });
      return;
    }

    const length = readLength(req.get('content-length'));
    if (length === null) {
      req.resume();
      res.status(400).json({ error: 'Content-Length is required.' });
      return;
    }
    if (length === 0) {
      req.resume();
      res.status(400).json({ error: 'Send the next part of the file.' });
      return;
    }
    if (length > CHUNK_BYTES) {
      req.resume();
      res.status(413).json({ error: 'Send at most 8 MB in each request.' });
      return;
    }
    if (offset + length > session.sizeBytes) {
      req.resume();
      res.status(400).json({ error: 'That part goes past the end of the file.' });
      return;
    }
    const contentType = req.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/octet-stream')) {
      req.resume();
      res.status(400).json({ error: 'Send the file bytes as application/octet-stream.' });
      return;
    }

    const wrote = await writeChunk(partial, offset, req, length);
    if (wrote === 'short') {
      sendJson(res, 400, {
        error: 'The upload stopped before that part was saved. Choose the file again to continue.',
      });
      return;
    }

    const next = offset + length;
    if (!advanceSession(ctx.db, id, userId, offset, next)) {
      const again = getOwnedSession(ctx.db, id, userId);
      const received = again?.receivedBytes ?? offset;
      await truncate(partial, received);
      sendJson(res, 409, {
        error: 'The server has a different amount of this file. Continue from the saved position.',
        receivedBytes: received,
      });
      return;
    }

    if (next === session.sizeBytes) {
      const published = await publishSession(ctx.db, ctx.config, id, userId);
      if (!published.ok) {
        sendJson(res, published.status, { error: published.error });
        return;
      }
      sendJson(res, 201, { file: published.file });
      return;
    }

    sendJson(res, 200, { session: getOwnedSession(ctx.db, id, userId) });
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    const mapped = mapFsError(error);
    console.error(`upload append failed (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'})`);
    sendJson(res, mapped.httpStatus, { error: mapped.message });
  } finally {
    if (locked) unlockSession(id);
    ctx.slots.release(userId);
  }
}

async function publishSession(
  db: DatabaseSync,
  config: AppConfig,
  id: string,
  userId: string,
): Promise<{ ok: true; file: NonNullable<ReturnType<typeof getReadyFile>> } | { ok: false; status: number; error: string }> {
  const taken = takeForPublish(db, id, userId, config.maxStorageBytes);
  if (!taken.ok) {
    return {
      ok: false,
      status: taken.reason === 'quota' ? 507 : 500,
      error: taken.reason === 'quota' ? 'Shared storage is full.' : 'The upload could not be saved.',
    };
  }
  return publishStagedTemp(db, config, id, userId);
}

async function publishStagedTemp(
  db: DatabaseSync,
  config: AppConfig,
  id: string,
  userId: string,
): Promise<{ ok: true; file: NonNullable<ReturnType<typeof getReadyFile>> } | { ok: false; status: number; error: string }> {
  const partial = tempPath(config.storageDir, id);
  const finalPath = objectPath(config.storageDir, id);
  if (!partial || !finalPath) {
    removeFileRecord(db, id);
    return { ok: false, status: 500, error: 'The upload could not be saved.' };
  }
  try {
    await rename(partial, finalPath);
  } catch (error) {
    removeFileRecord(db, id);
    await rm(partial, { force: true });
    const mapped = mapFsError(error);
    console.error(`storage rename failed (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'})`);
    return { ok: false, status: mapped.httpStatus, error: mapped.message };
  }
  if (!markReady(db, id)) {
    return {
      ok: false,
      status: 500,
      error: 'The file was saved but is not listed yet. Restart the server if it does not appear.',
    };
  }
  const file = getReadyFile(db, id, userId);
  if (!file) return { ok: false, status: 500, error: 'The upload could not be saved.' };
  scheduleThumbnail(config.storageDir, file);
  return { ok: true, file };
}

async function removeSessionTemps(storageDir: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    const partial = tempPath(storageDir, id);
    if (partial) await rm(partial, { force: true });
  }
}

function readUploadStart(body: unknown): { originalName: string; sizeBytes: number; folderId: string | null } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as { originalName?: unknown; sizeBytes?: unknown; folderId?: unknown };
  if (typeof record.originalName !== 'string') return null;
  if (typeof record.sizeBytes !== 'number' || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) {
    return null;
  }
  if (record.folderId != null && typeof record.folderId !== 'string') return null;
  return {
    originalName: record.originalName,
    sizeBytes: record.sizeBytes,
    folderId: typeof record.folderId === 'string' && record.folderId ? record.folderId : null,
  };
}

function readPageLimit(raw: unknown): number | null {
  if (raw == null || raw === '') return DEFAULT_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) return null;
  return value;
}

function sendCatalogFailure(res: Response, reason: string): void {
  if (reason === 'bad-name') {
    res.status(400).json({ error: 'That name cannot be used.' });
    return;
  }
  if (reason === 'duplicate') {
    res.status(409).json({ error: 'That name is already in use.' });
    return;
  }
  if (reason === 'forbidden') {
    res.status(403).json({ error: 'You can change only collections you created.' });
    return;
  }
  res.status(404).json({ error: 'That collection is not in the portal.' });
}

function sendFolderFailure(res: Response, reason: string): void {
  if (reason === 'bad-name') {
    res.status(400).json({ error: 'That folder name cannot be used.' });
    return;
  }
  if (reason === 'duplicate') {
    res.status(409).json({ error: 'A folder with that name is already here.' });
    return;
  }
  if (reason === 'deep') {
    res.status(400).json({ error: 'That folder is nested too deeply.' });
    return;
  }
  if (reason === 'forbidden') {
    res.status(403).json({ error: 'You can change only folders you created.' });
    return;
  }
  if (reason === 'not-empty') {
    res.status(409).json({ error: 'This folder still has files or folders in it.' });
    return;
  }
  res.status(404).json({ error: 'That folder is not in the portal.' });
}

function readOffset(header: string | undefined): number | null {
  if (!header || !/^\d+$/.test(header)) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : null;
}

function readLength(header: string | undefined): number | null {
  if (!header || !/^\d+$/.test(header)) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : null;
}

function routeId(req: Request): string {
  const value = req.params.id;
  return typeof value === 'string' ? value : '';
}

function sendJson(res: Response, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.status(status).json(body);
}

const replacing = new Set<string>();

async function handleReplace(
  req: Request,
  res: Response,
  ctx: { db: DatabaseSync; config: AppConfig; slots: UploadSlots },
): Promise<void> {
  await sweepBin(ctx.db, ctx.config);
  const userId = req.session.userId!;
  const fileId = routeId(req);
  const currentPath = objectPath(ctx.config.storageDir, fileId);
  const target = currentPath ? replacementTarget(ctx.db, fileId, userId) : { ok: false as const, reason: 'missing' as const };
  if (!target.ok) {
    req.resume();
    sendReplacementFailure(res, target.reason);
    return;
  }
  if (replacing.has(fileId)) {
    req.resume();
    res.status(409).json({ error: 'That file is already being replaced.' });
    return;
  }
  if (!ctx.slots.tryAcquire(userId)) {
    res.status(429).json({ error: 'Too many uploads are already running. Wait for one to finish.' });
    return;
  }
  replacing.add(fileId);
  const tempId = randomUUID();
  const partial = tempPath(ctx.config.storageDir, tempId);
  try {
    const claimed = Number(req.headers['content-length']);
    if (Number.isFinite(claimed) && claimed > ctx.config.maxFileBytes + 256 * 1024) {
      res.status(413).json({
        error: `Each file must be ${formatBytes(ctx.config.maxFileBytes)} or smaller.`,
      });
      return;
    }
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.toLowerCase().includes('multipart/form-data')) {
      res.status(400).json({ error: 'Choose a file to upload.' });
      return;
    }
    if (!partial || !currentPath) {
      res.status(500).json({ error: 'The upload could not be saved.' });
      return;
    }
    const received = await receiveUpload({
      req,
      tmpPath: partial,
      maxFileBytes: ctx.config.maxFileBytes,
      sanitizeName: sanitizeOriginalName,
    });
    if (received.status !== 'ok') {
      await discardTemp(partial);
      sendReceiveFailure(res, received, ctx.config.maxFileBytes);
      return;
    }
    if (received.sizeBytes > ctx.config.maxFileBytes) {
      await discardTemp(partial);
      res.status(413).json({
        error: `Each file must be ${formatBytes(ctx.config.maxFileBytes)} or smaller.`,
      });
      return;
    }
    await syncFile(partial);
    const versionId = randomUUID();
    const versionPath = objectPath(ctx.config.storageDir, versionId);
    if (!versionPath || (await fileSize(currentPath)) === null) {
      await discardTemp(partial);
      res.status(500).json({ error: 'This file is unavailable. Ask the person who uploaded it to upload it again.' });
      return;
    }
    await copyFile(currentPath, versionPath);
    await rm(currentPath, { force: true });
    try {
      await rename(partial, currentPath);
    } catch (error) {
      await copyFile(versionPath, currentPath);
      await rm(versionPath, { force: true });
      throw error;
    }
    const committed = commitReplacement(ctx.db, {
      fileId,
      ownerId: userId,
      versionId,
      newName: received.originalName,
      newSize: received.sizeBytes,
      now: new Date().toISOString(),
    }, ctx.config.maxStorageBytes);
    if (!committed.ok) {
      await rm(currentPath, { force: true });
      await rename(versionPath, currentPath);
      sendReplacementFailure(res, committed.reason);
      return;
    }
    const thumb = thumbPath(ctx.config.storageDir, fileId);
    if (thumb) await rm(thumb, { force: true });
    const file = getReadyFile(ctx.db, fileId, userId);
    if (file) scheduleThumbnail(ctx.config.storageDir, file);
    res.status(201).json({ file });
  } catch (error) {
    await discardTemp(partial);
    if (!res.headersSent) {
      const mapped = mapFsError(error);
      res.status(mapped.httpStatus).json({ error: mapped.message });
    }
  } finally {
    replacing.delete(fileId);
    ctx.slots.release(userId);
  }
}

function sendReceiveFailure(res: Response, received: { status: string; httpStatus?: number; message?: string }, maxFileBytes: number): void {
  if (received.status === 'aborted') return;
  if (received.status === 'nofile') {
    res.status(400).json({ error: 'Choose a file to upload.' });
    return;
  }
  if (received.status === 'badname') {
    res.status(400).json({ error: 'That file name cannot be used.' });
    return;
  }
  if (received.status === 'toolarge') {
    res.status(413).json({ error: `Each file must be ${formatBytes(maxFileBytes)} or smaller.` });
    return;
  }
  if (received.status === 'io') {
    res.status(received.httpStatus ?? 500).json({ error: received.message ?? 'The upload could not be saved.' });
  }
}

function sendReplacementFailure(res: Response, reason: 'missing' | 'forbidden' | 'quota'): void {
  if (reason === 'quota') {
    res.status(507).json({ error: 'Shared storage is full.' });
    return;
  }
  if (reason === 'forbidden') {
    res.status(403).json({ error: 'You can replace only files you uploaded.' });
    return;
  }
  res.status(404).json({ error: 'That file is not in the portal.' });
}

async function handleVersionDownload(req: Request, res: Response, db: DatabaseSync, config: AppConfig, transfers: TransferTracker): Promise<void> {
  const record = getReadyFile(db, routeId(req), req.session.userId!);
  const versionId = typeof req.params.versionId === 'string' ? req.params.versionId : '';
  const version = record ? listFileVersions(db, record.id).find((item) => item.id === versionId) : undefined;
  if (!record || !version) {
    res.status(404).json({ error: 'That version is not in the portal.' });
    return;
  }
  const finalPath = objectPath(config.storageDir, version.id);
  const size = finalPath ? await fileSize(finalPath) : null;
  if (!finalPath || size !== version.sizeBytes) {
    res.status(500).json({ error: 'This file is unavailable. Ask the person who uploaded it to upload it again.' });
    return;
  }
  await sendKnownDownload(req, res, transfers, {
    filePath: finalPath,
    size,
    filename: version.originalName,
    kind: 'library',
  });
}

async function handleVersionDelete(req: Request, res: Response, db: DatabaseSync, config: AppConfig): Promise<void> {
  const versionId = typeof req.params.versionId === 'string' ? req.params.versionId : '';
  const result = deleteOwnedVersion(db, routeId(req), versionId, req.session.userId!);
  if (result === 'forbidden') {
    res.status(403).json({ error: 'You can remove only versions of files you uploaded.' });
    return;
  }
  if (result === 'missing') {
    res.status(404).json({ error: 'That version is not in the portal.' });
    return;
  }
  await discardStoredFile(config, versionId);
  res.json({ ok: true });
}

async function handleUpload(
  req: Request,
  res: Response,
  ctx: { db: DatabaseSync; config: AppConfig; slots: UploadSlots; openTemp?: TempWriter },
): Promise<void> {
  await sweepBin(ctx.db, ctx.config);
  const userId = req.session.userId!;
  const headerFolder = req.get('x-folder-id');
  const folder = resolveFolder(ctx.db, headerFolder ? headerFolder : null);
  if (!folder.ok) {
    req.resume();
    res.status(404).json({ error: 'That folder is not in the portal.' });
    return;
  }
  if (!ctx.slots.tryAcquire(userId)) {
    res.status(429).json({ error: 'Too many uploads are already running. Wait for one to finish.' });
    return;
  }

  const id = randomUUID();
  const partial = tempPath(ctx.config.storageDir, id);
  let acquired = true;
  const release = () => {
    if (!acquired) return;
    acquired = false;
    ctx.slots.release(userId);
  };

  try {
    if (reservedBytes(ctx.db) >= ctx.config.maxStorageBytes) {
      res.status(507).json({ error: 'Shared storage is full.' });
      return;
    }

    const claimed = Number(req.headers['content-length']);
    if (Number.isFinite(claimed) && claimed > ctx.config.maxFileBytes + 256 * 1024) {
      res.status(413).json({
        error: `Each file must be ${formatBytes(ctx.config.maxFileBytes)} or smaller.`,
      });
      return;
    }

    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.toLowerCase().includes('multipart/form-data')) {
      res.status(400).json({ error: 'Choose a file to upload.' });
      return;
    }

    if (!partial) {
      res.status(500).json({ error: 'The upload could not be saved.' });
      return;
    }

    const received = await receiveUpload({
      req,
      tmpPath: partial,
      maxFileBytes: ctx.config.maxFileBytes,
      sanitizeName: sanitizeOriginalName,
      openTemp: ctx.openTemp,
    });

    if (received.status === 'aborted') {
      await discardTemp(partial);
      return;
    }
    if (received.status === 'nofile') {
      await discardTemp(partial);
      res.status(400).json({ error: 'Choose a file to upload.' });
      return;
    }
    if (received.status === 'badname') {
      await discardTemp(partial);
      res.status(400).json({ error: 'That file name cannot be used.' });
      return;
    }
    if (received.status === 'toolarge') {
      await discardTemp(partial);
      res.status(413).json({
        error: `Each file must be ${formatBytes(ctx.config.maxFileBytes)} or smaller.`,
      });
      return;
    }
    if (received.status === 'io') {
      await discardTemp(partial);
      res.status(received.httpStatus).json({ error: received.message });
      return;
    }
    if (received.sizeBytes > ctx.config.maxFileBytes) {
      await discardTemp(partial);
      res.status(413).json({
        error: `Each file must be ${formatBytes(ctx.config.maxFileBytes)} or smaller.`,
      });
      return;
    }

    await syncFile(partial);
    const staged = stageFile(ctx.db, {
      id,
      ownerId: userId,
      originalName: received.originalName,
      sizeBytes: received.sizeBytes,
      createdAt: new Date().toISOString(),
      folderId: folder.folderId,
    }, ctx.config.maxStorageBytes);
    if (!staged.ok) {
      await discardTemp(partial);
      res.status(507).json({ error: 'Shared storage is full.' });
      return;
    }

    const finalPath = objectPath(ctx.config.storageDir, id);
    if (!finalPath) {
      removeFileRecord(ctx.db, id);
      await discardTemp(partial);
      res.status(500).json({ error: 'The upload could not be saved.' });
      return;
    }

    try {
      await rename(partial, finalPath);
    } catch (error) {
      removeFileRecord(ctx.db, id);
      await discardTemp(partial);
      const mapped = mapFsError(error);
      console.error(`storage rename failed (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'})`);
      res.status(mapped.httpStatus).json({ error: mapped.message });
      return;
    }

    if (!markReady(ctx.db, id)) {
      res.status(500).json({ error: 'The file was saved but is not listed yet. Restart the server if it does not appear.' });
      return;
    }

    const file = getReadyFile(ctx.db, id, userId);
    if (file) scheduleThumbnail(ctx.config.storageDir, file);
    res.status(201).json({ file });
  } catch (error) {
    await discardTemp(partial);
    if (!res.headersSent) {
      const mapped = mapFsError(error);
      res.status(mapped.httpStatus).json({ error: mapped.message });
      return;
    }
    throw error;
  } finally {
    release();
  }
}

async function handlePreview(req: Request, res: Response, db: DatabaseSync, config: AppConfig): Promise<void> {
  const located = await locateReadyFile(req, res, db, config);
  if (!located) return;
  const kind = previewKind(located.record.originalName, located.record.sizeBytes);
  if (kind === 'none') {
    res.status(415).json({ error: 'This file cannot be previewed. Download it instead.' });
    return;
  }
  if (kind === 'text') {
    const sample = await readTextSample(located.finalPath, located.size, TEXT_PREVIEW_MAX_BYTES);
    if (sample === 'binary') {
      res.status(415).json({ error: 'This file cannot be previewed. Download it instead.' });
      return;
    }
    const body = Buffer.from(sample.text, 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Preview-Truncated', sample.truncated ? '1' : '0');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(body);
    return;
  }
  const contentType = imageContentType(located.record.originalName);
  if (!contentType) {
    res.status(415).json({ error: 'This file cannot be previewed. Download it instead.' });
    return;
  }
  await sendInlineFile(req, res, located.finalPath, located.size, contentType);
}

async function handleThumbnail(req: Request, res: Response, db: DatabaseSync, config: AppConfig): Promise<void> {
  const located = await locateReadyFile(req, res, db, config);
  if (!located) return;
  const generated = thumbPath(config.storageDir, located.record.id);
  const generatedSize = generated ? await fileSize(generated) : null;
  if (generated && generatedSize) {
    await sendInlineFile(req, res, generated, generatedSize, 'image/jpeg');
    return;
  }
  if (previewKind(located.record.originalName, located.record.sizeBytes) !== 'image') {
    res.status(404).json({ error: 'This file has no thumbnail.' });
    return;
  }
  const contentType = imageContentType(located.record.originalName);
  if (!contentType) {
    res.status(404).json({ error: 'This file has no thumbnail.' });
    return;
  }
  await sendInlineFile(req, res, located.finalPath, located.size, contentType);
}

async function locateReadyFile(
  req: Request,
  res: Response,
  db: DatabaseSync,
  config: AppConfig,
): Promise<{ record: NonNullable<ReturnType<typeof getReadyFile>>; finalPath: string; size: number } | null> {
  const record = getReadyFile(db, req.params.id, req.session.userId!);
  if (!record) {
    res.status(404).json({ error: 'That file is not in the portal.' });
    return null;
  }
  const finalPath = objectPath(config.storageDir, record.id);
  const size = finalPath ? await fileSize(finalPath) : null;
  if (!finalPath || size !== record.sizeBytes) {
    res.status(500).json({ error: 'This file is unavailable. Ask the person who uploaded it to upload it again.' });
    return null;
  }
  return { record, finalPath, size };
}

async function sendInlineFile(req: Request, res: Response, filePath: string, size: number, contentType: string): Promise<void> {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', (error) => {
    console.error(`storage read failed (${'code' in error ? String(error.code) : 'unknown'})`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'This file is unavailable. Ask the person who uploaded it to upload it again.' });
    } else {
      res.destroy();
    }
  });
  await pipeline(stream, res).catch(() => undefined);
}

async function handleDownload(req: Request, res: Response, db: DatabaseSync, config: AppConfig, transfers: TransferTracker): Promise<void> {
  const id = req.params.id;
  const record = getReadyFile(db, id, req.session.userId!);
  if (!record) {
    res.status(404).json({ error: 'That file is not in the portal.' });
    return;
  }
  const finalPath = objectPath(config.storageDir, record.id);
  const size = finalPath ? await fileSize(finalPath) : null;
  if (!finalPath || size !== record.sizeBytes) {
    res.status(500).json({ error: 'This file is unavailable. Ask the person who uploaded it to upload it again.' });
    return;
  }

  await sendKnownDownload(req, res, transfers, {
    filePath: finalPath,
    size,
    filename: record.originalName,
    kind: 'library',
  });
}

async function sendKnownDownload(
  req: Request,
  res: Response,
  transfers: TransferTracker,
  input: { filePath: string; size: number; filename: string; kind: 'library' },
): Promise<void> {
  const progressId = attachDownload(req, res, transfers, {
    filename: input.filename,
    kind: input.kind,
    totalBytes: input.size,
    sourceTotal: input.size,
  });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(input.size));
  res.setHeader('Content-Disposition', attachmentDisposition(input.filename));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method === 'HEAD') {
    transfers.finish(progressId);
    res.end();
    return;
  }
  let settled = false;
  req.on('close', () => {
    if (!res.writableEnded && !settled) transfers.fail(progressId, 'closed');
  });
  const stream = createReadStream(input.filePath);
  stream.on('error', (error) => {
    console.error(`storage read failed (${'code' in error ? String(error.code) : 'unknown'})`);
    if (!settled) transfers.fail(progressId, 'failed');
    if (!res.headersSent) {
      res.status(500).json({ error: 'This file is unavailable. Ask the person who uploaded it to upload it again.' });
    } else {
      res.destroy();
    }
  });
  try {
    const seen = await writeChunks(res, stream, (bytes) => transfers.add(progressId, 'sentBytes', bytes));
    if (seen !== input.size) {
      transfers.fail(progressId, 'failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'This file is unavailable. Ask the person who uploaded it to upload it again.' });
      } else {
        res.destroy();
      }
      return;
    }
    res.end();
    settled = true;
    transfers.finish(progressId);
  } catch {
    if (!settled) transfers.fail(progressId, 'closed');
    if (!res.headersSent && !res.destroyed) {
      res.status(500).json({ error: 'This file is unavailable. Ask the person who uploaded it to upload it again.' });
    }
  }
}

function attachDownload(
  req: Request,
  res: Response,
  transfers: TransferTracker,
  input: { filename: string; kind: 'library' | 'library-zip'; totalBytes: number | null; sourceTotal: number | null },
): string | null {
  const id = readProgressId(req.query.progress);
  const userId = req.session.userId;
  if (!id || !userId) return null;
  const opened = transfers.open({
    id,
    userId,
    filename: safeTransferName(input.filename),
    kind: input.kind,
    totalBytes: input.totalBytes,
    sourceTotal: input.sourceTotal,
    abort: () => {
      if (!res.writableEnded) res.destroy();
    },
  });
  return opened ? id : null;
}

async function handleBin(req: Request, res: Response, db: DatabaseSync, config: AppConfig): Promise<void> {
  await sweepBin(db, config);
  res.json({
    files: listBin(db, req.session.userId!),
    retentionDays: 30,
    storage: { usedBytes: displayedUsedBytes(db), limitBytes: config.maxStorageBytes },
  });
}

async function handlePermanentDelete(req: Request, res: Response, db: DatabaseSync, config: AppConfig): Promise<void> {
  const id = routeId(req);
  const versionIds = versionIdsForFile(db, id);
  const result = purgeOwnedBinFile(db, id, req.session.userId!);
  if (result === 'missing') {
    res.status(404).json({ error: 'That file is not in the bin.' });
    return;
  }
  if (result === 'forbidden') {
    res.status(403).json({ error: 'You can remove only files you uploaded.' });
    return;
  }
  await discardStoredFile(config, id);
  for (const versionId of versionIds) await discardStoredFile(config, versionId);
  removeUnusedTags(db);
  res.json({ ok: true });
}

async function sweepBin(db: DatabaseSync, config: AppConfig): Promise<void> {
  const expired = takeExpiredBinIds(db);
  for (const item of expired) {
    await discardStoredFile(config, item.id);
    for (const versionId of item.versionIds) await discardStoredFile(config, versionId);
  }
  if (expired.length > 0) removeUnusedTags(db);
}

async function discardStoredFile(config: AppConfig, id: string): Promise<void> {
  const finalPath = objectPath(config.storageDir, id);
  if (finalPath) {
    try {
      await rm(finalPath, { force: true });
    } catch (error) {
      console.error(`stored file remained after delete (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'})`);
    }
  }
  const thumb = thumbPath(config.storageDir, id);
  if (thumb) await rm(thumb, { force: true });
}

async function handleDeleteMany(req: Request, res: Response, db: DatabaseSync, config: AppConfig): Promise<void> {
  const ids = readIds(req.body?.ids);
  if (!ids) {
    res.status(400).json({ error: 'Choose 1 to 100 files.' });
    return;
  }
  const result = deleteOwnedFiles(db, req.session.userId!, ids);
  res.json(result);
}

async function handleZip(req: Request, res: Response, db: DatabaseSync, config: AppConfig): Promise<void> {
  const raw = typeof req.query.ids === 'string' ? req.query.ids.split(',') : [];
  const ids = readIds(raw);
  if (!ids) {
    res.status(400).json({ error: 'Choose 1 to 100 files.' });
    return;
  }
  const used = new Set<string>();
  const entries: Array<{ name: string; filePath: string; size: number }> = [];
  for (const id of ids) {
    const record = getReadyFile(db, id, req.session.userId!);
    const finalPath = record ? objectPath(config.storageDir, record.id) : null;
    const size = finalPath ? await fileSize(finalPath) : null;
    if (!record || !finalPath || size !== record.sizeBytes) {
      res.status(404).json({ error: 'One of those files is not in the portal.' });
      return;
    }
    entries.push({ name: uniqueZipName(used, record.originalName), filePath: finalPath, size });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', attachmentDisposition('portal-files.zip'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    await writeStoredZip(res, entries);
    res.end();
  } catch (error) {
    console.error(`zip failed (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'})`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'The files could not be packed.' });
    } else {
      res.destroy();
    }
  }
}

const BULK_LIMIT = 100;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > BULK_LIMIT) return null;
  if (!value.every((id) => typeof id === 'string' && ID_RE.test(id))) return null;
  return [...new Set(value)];
}

async function handleDelete(req: Request, res: Response, db: DatabaseSync, config: AppConfig): Promise<void> {
  const id = req.params.id;
  if (!objectPath(config.storageDir, id)) {
    res.status(404).json({ error: 'That file is not in the portal.' });
    return;
  }
  const result = deleteOwnedFile(db, id, req.session.userId!);
  if (result === 'missing') {
    res.status(404).json({ error: 'That file is not in the portal.' });
    return;
  }
  if (result === 'forbidden') {
    res.status(403).json({ error: 'You can delete only files you uploaded.' });
    return;
  }
  res.json({ ok: true });
}
