import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { rename, rm, truncate, writeFile } from 'node:fs/promises';
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
  getReadyFile,
  listFiles,
  DEFAULT_PAGE_SIZE,
  displayedUsedBytes,
  MAX_PAGE_SIZE,
  markReady,
  removeFileRecord,
  reservedBytes,
  stageFile,
} from './files.js';
import {
  breadcrumbs,
  createFolder,
  deleteFolder,
  listChildFolders,
  renameFolder,
  resolveFolder,
} from './folders.js';
import { formatBytes } from './format.js';
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
import { findUserById, findUserByUsername } from './users.js';
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
  app.use(express.json({ limit: '20kb' }));
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

  app.get('/api/auth/me', (req, res) => {
    const user = currentUser(db, req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }
    res.json(sessionBody(user, req.session.csrfToken ?? '', config));
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

  app.get('/api/files', requireAuth, (req, res) => {
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
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null;
    const page = listFiles(db, {
      query,
      sort,
      order,
      userId: req.session.userId!,
      folderId: query ? null : folder.folderId,
      limit,
      cursor,
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
      folders: query ? [] : listChildFolders(db, folder.folderId, req.session.userId!),
      breadcrumbs: trail,
      page: { limit, nextCursor: page.nextCursor },
      storage: { usedBytes: displayedUsedBytes(db), limitBytes: config.maxStorageBytes },
      limits,
    });
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

  app.get('/api/files/:id/download', requireAuth, (req, res, next) => {
    void handleDownload(req, res, db, config).catch(next);
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
  };
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

async function handleUpload(
  req: Request,
  res: Response,
  ctx: { db: DatabaseSync; config: AppConfig; slots: UploadSlots; openTemp?: TempWriter },
): Promise<void> {
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

async function handleDownload(req: Request, res: Response, db: DatabaseSync, config: AppConfig): Promise<void> {
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

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', attachmentDisposition(record.originalName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(finalPath);
  stream.on('error', (error) => {
    console.error(`storage read failed (${'code' in error ? String(error.code) : 'unknown'})`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'This file is unavailable. Ask the person who uploaded it to upload it again.' });
    } else {
      res.destroy();
    }
  });
  await pipeline(stream, res).catch(() => {
    // The client may have cancelled the download. The stored file stays in place.
  });
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
  const finalPath = objectPath(config.storageDir, id);
  if (finalPath) {
    try {
      await rm(finalPath, { force: true });
    } catch (error) {
      console.error(`stored file remained after delete (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown'})`);
    }
  }
  res.json({ ok: true });
}
