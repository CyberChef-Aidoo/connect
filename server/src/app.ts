import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
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
  markReady,
  readyBytes,
  removeFileRecord,
  stageFile,
  usedBytes,
} from './files.js';
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
    res.json({ user: { id: user.id, username: user.username }, csrfToken: req.session.csrfToken, limits });
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
      res.json({
        user: { id: user.id, username: user.username },
        csrfToken: req.session.csrfToken,
        limits,
      });
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
    const files = listFiles(db, { query, sort, order, userId: req.session.userId! });
    if (!files) {
      res.status(400).json({ error: 'Sort by name, size, or date, in ascending or descending order.' });
      return;
    }
    res.json({
      files,
      storage: { usedBytes: readyBytes(db), limitBytes: config.maxStorageBytes },
      limits,
    });
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

async function handleUpload(
  req: Request,
  res: Response,
  ctx: { db: DatabaseSync; config: AppConfig; slots: UploadSlots; openTemp?: TempWriter },
): Promise<void> {
  const userId = req.session.userId!;
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
    if (usedBytes(ctx.db) >= ctx.config.maxStorageBytes) {
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
