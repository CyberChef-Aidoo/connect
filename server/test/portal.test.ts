import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp, type AppHandle, type AppOptions } from '../src/app.js';
import { assertBindSafety, resolveConfig } from '../src/config.js';
import { BIN_RETENTION_MS, markReady, removeFileRecord, stageFile } from '../src/files.js';
import { reconcileStorage } from '../src/reconcile.js';
import { createJobRunner, whenJobsIdle } from '../src/jobs.js';
import { IMAGE_PREVIEW_MAX_BYTES, TEXT_PREVIEW_MAX_BYTES } from '../src/preview.js';
import { attachmentDisposition, objectPath, sanitizeOriginalName, tempPath, thumbPath } from '../src/storage.js';
import type { AppConfig } from '../src/config.js';
import type { TempWriter } from '../src/uploads.js';
import { createUser } from '../src/users.js';

const PASSWORD = 'test-password-1';

function testConfig(dir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    repoRoot: dir,
    host: '127.0.0.1',
    port: 0,
    storageDir: path.join(dir, 'storage'),
    databasePath: path.join(dir, 'app.db'),
    maxFileBytes: 2 * 1024 * 1024 * 1024,
    maxStorageBytes: 50 * 1024 * 1024 * 1024,
    sessionSecret: 'test-session-secret-not-for-production',
    sessionTtlMs: 60 * 60 * 1000,
    https: null,
    staticDir: null,
    loginRateLimit: 100,
    maxUploadsPerUser: 3,
    maxUploadsGlobal: 8,
    usingDevSessionSecret: false,
    ...overrides,
  };
}

async function withPortal(
  overrides: Partial<AppConfig>,
  fn: (handle: AppHandle, dir: string) => Promise<void>,
  options: AppOptions = {},
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-'));
  const handle = await createApp(testConfig(dir, overrides), { passwordCost: 4, ...options });
  try {
    await fn(handle, dir);
  } finally {
    handle.close();
    await removeDir(dir);
  }
}

async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function account(handle: AppHandle, username: string) {
  await createUser(handle.db, username, PASSWORD, 4);
  const agent = request.agent(handle.app);
  const login = await agent.post('/api/auth/login').send({ username, password: PASSWORD });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.password, undefined);
  assert.equal(JSON.stringify(login.body).includes(PASSWORD), false);
  const setCookie = login.headers['set-cookie'];
  const cookieValues = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = cookieValues.map((value) => value.split(';')[0]).join('; ');
  return {
    agent,
    cookie,
    csrf: login.body.csrfToken as string,
    userId: login.body.user.id as string,
  };
}

function responseText(response: { body?: unknown; text?: string }): string {
  if (Buffer.isBuffer(response.body)) return response.body.toString('utf8');
  return response.text ?? '';
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the storage folder to change.');
}

async function uploadNamed(
  agent: request.Agent,
  csrf: string,
  filename: string,
  content: Buffer | string,
) {
  return agent
    .post('/api/files')
    .set('X-CSRF-Token', csrf)
    .attach('file', Buffer.from(content), { filename });
}

function appendChunk(
  agent: request.Agent,
  csrf: string,
  id: string,
  offset: number,
  body: Buffer,
) {
  return agent
    .patch(`/api/uploads/${id}`)
    .set('X-CSRF-Token', csrf)
    .set('Content-Type', 'application/octet-stream')
    .set('Upload-Offset', String(offset))
    .send(body);
}

describe('configuration', () => {
  it('refuses a network address without HTTPS', () => {
    const config = resolveConfig({
      HOST: '0.0.0.0',
      SESSION_SECRET: 'a-long-enough-session-secret',
    }, os.tmpdir());
    assert.throws(() => assertBindSafety(config), /HTTPS/);
  });

  it('requires a session secret before leaving this computer', () => {
    assert.throws(() => resolveConfig({ HOST: '0.0.0.0' }, os.tmpdir()), /SESSION_SECRET/);
  });

  it('allows loopback HTTP for development and keeps storage out of the website', () => {
    const root = path.join(os.tmpdir(), 'portal-config');
    const config = resolveConfig({ HOST: '127.0.0.1' }, root);
    assert.equal(config.https, null);
    assert.equal(config.usingDevSessionSecret, true);
    assert.doesNotThrow(() => assertBindSafety(config));
    assert.throws(
      () => resolveConfig({ STORAGE_DIR: path.join(root, 'client', 'dist') }, root),
      /STORAGE_DIR/,
    );
  });
});

describe('filenames', () => {
  it('keeps a display name and removes path and control characters', () => {
    assert.equal(sanitizeOriginalName('..\\..\\outside.txt'), 'outside.txt');
    assert.equal(sanitizeOriginalName('../secret.txt'), 'secret.txt');
    assert.equal(sanitizeOriginalName('報告書.txt'), '報告書.txt');
    assert.equal(sanitizeOriginalName('a\r\nB.html'), 'aB.html');
    assert.equal(sanitizeOriginalName('..\0secret.txt'), null);
    assert.equal(sanitizeOriginalName('.'), null);
    assert.equal(sanitizeOriginalName(''), null);
    const header = attachmentDisposition('a\r\nB.html');
    assert.equal(header.includes('\r') || header.includes('\n'), false);
    assert.match(header, /^attachment;/);
    assert.match(attachmentDisposition('報告書.txt'), /filename\*=UTF-8''/);
  });
});

describe('portal', () => {
  it('rejects anonymous access and a bad sign-in', async () => {
    await withPortal({}, async (handle) => {
      await createUser(handle.db, 'ada', PASSWORD, 4);
      for (const pathName of ['/api/files', '/api/auth/me']) {
        const response = await request(handle.app).get(pathName);
        assert.equal(response.status, 401);
      }
      const upload = await request(handle.app).post('/api/files');
      assert.equal(upload.status, 401);
      const failed = await request(handle.app).post('/api/auth/login').send({ username: 'ada', password: 'wrong-password' });
      assert.equal(failed.status, 401);
      assert.equal(JSON.stringify(failed.body).includes('wrong-password'), false);
      const missing = await request(handle.app).post('/api/auth/login').send({ username: 'nobody', password: PASSWORD });
      assert.equal(missing.status, 401);
      assert.equal(missing.body.error, failed.body.error);
    });
  });

  it('uploads, lists, searches, sorts, and downloads', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const me = await ada.agent.get('/api/auth/me');
      assert.equal(me.body.uploads.maxPerUser, 3);
      assert.equal(me.body.uploads.maxGlobal, 8);
      const first = await uploadNamed(ada.agent, ada.csrf, 'notes.txt', 'alpha');
      assert.equal(first.status, 201);
      const second = await uploadNamed(ada.agent, ada.csrf, 'notes.txt', 'beta-longer');
      assert.equal(second.status, 201);
      assert.notEqual(first.body.file.id, second.body.file.id);

      const unicode = await uploadNamed(ada.agent, ada.csrf, '報告書.txt', 'ユニコード');
      assert.equal(unicode.status, 201);
      assert.equal(unicode.body.file.originalName, '報告書.txt');
      const empty = await uploadNamed(ada.agent, ada.csrf, 'empty.dat', '');
      assert.equal(empty.status, 201);
      assert.equal(empty.body.file.sizeBytes, 0);
      const reserved = await uploadNamed(ada.agent, ada.csrf, 'con.txt', 'device-name');
      assert.equal(reserved.status, 201);

      const listed = await ada.agent.get('/api/files?sort=size&order=asc');
      assert.equal(listed.status, 200);
      assert.equal(listed.body.files.length, 5);
      assert.ok(listed.body.files[0].sizeBytes <= listed.body.files.at(-1).sizeBytes);
      const names = listed.body.files.map((file: { originalName: string }) => file.originalName);
      assert.ok(names.filter((name: string) => name === 'notes.txt').length === 2);

      const found = await ada.agent.get('/api/files').query({ q: '報告' });
      assert.equal(found.body.files.length, 1);
      const none = await ada.agent.get('/api/files').query({ q: 'missing-name' });
      assert.equal(none.body.files.length, 0);
      const badSort = await ada.agent.get('/api/files').query({ sort: 'path' });
      assert.equal(badSort.status, 400);

      const downloaded = await ada.agent.get(`/api/files/${second.body.file.id}/download`);
      assert.equal(downloaded.status, 200);
      assert.equal(downloaded.headers['content-type'], 'application/octet-stream');
      assert.match(String(downloaded.headers['content-disposition']), /attachment/);
      assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
      assert.equal(responseText(downloaded), 'beta-longer');

      const html = await uploadNamed(ada.agent, ada.csrf, 'page.html', '<html><script>alert(1)</script></html>');
      const htmlDownload = await ada.agent.get(`/api/files/${html.body.file.id}/download`);
      assert.equal(htmlDownload.headers['content-type'], 'application/octet-stream');
      assert.match(String(htmlDownload.headers['content-disposition']), /attachment/);
    });
  });

  it('stores traversal attempts under a generated id and only lets the uploader delete', async () => {
    await withPortal({}, async (handle, dir) => {
      const ada = await account(handle, 'ada');
      const blake = await account(handle, 'blake');
      const boundary = '----portalform';
      const body = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="..\\\\..\\\\outside.txt"\r\nContent-Type: application/octet-stream\r\n\r\nsafe\r\n--${boundary}--\r\n`,
        'utf8',
      );
      const uploaded = await ada.agent
        .post('/api/files')
        .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
        .set('X-CSRF-Token', ada.csrf)
        .send(body);
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      assert.equal(uploaded.body.file.originalName, 'outside.txt');
      const outside = path.join(dir, 'outside.txt');
      await assert.rejects(stat(outside));
      const stored = objectPath(handle.config.storageDir, uploaded.body.file.id);
      assert.ok(stored);
      assert.equal((await stat(stored!)).isFile(), true);

      const traversal = await ada.agent.get('/api/files/..%2F..%2Foutside.txt/download');
      assert.equal(traversal.status, 404);

      const forbidden = await blake.agent.delete(`/api/files/${uploaded.body.file.id}`).set('X-CSRF-Token', blake.csrf);
      assert.equal(forbidden.status, 403);
      const stillThere = await ada.agent.get(`/api/files/${uploaded.body.file.id}/download`);
      assert.equal(stillThere.status, 200);

      const removed = await ada.agent.delete(`/api/files/${uploaded.body.file.id}`).set('X-CSRF-Token', ada.csrf);
      assert.equal(removed.status, 200);
      const gone = await ada.agent.get(`/api/files/${uploaded.body.file.id}/download`);
      assert.equal(gone.status, 404);
      assert.equal((await stat(stored!)).isFile(), true);
    });
  });

  it('requires the CSRF header for uploads, deletion, and sign-out', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const missing = await ada.agent.post('/api/files').attach('file', Buffer.from('x'), 'a.txt');
      assert.equal(missing.status, 403);
      const uploaded = await uploadNamed(ada.agent, ada.csrf, 'a.txt', 'x');
      const deleted = await ada.agent.delete(`/api/files/${uploaded.body.file.id}`);
      assert.equal(deleted.status, 403);
      const logout = await ada.agent.post('/api/auth/logout');
      assert.equal(logout.status, 403);
    });
  });

  it('enforces the file-size and storage limits', async () => {
    await withPortal({ maxFileBytes: 12, maxStorageBytes: 15 }, async (handle) => {
      const ada = await account(handle, 'ada');
      const tooBig = await uploadNamed(ada.agent, ada.csrf, 'big.txt', '0123456789abc');
      assert.equal(tooBig.status, 413);
      const first = await uploadNamed(ada.agent, ada.csrf, 'one.txt', '12345678');
      assert.equal(first.status, 201);
      const second = await uploadNamed(ada.agent, ada.csrf, 'two.txt', '12345678');
      assert.equal(second.status, 507);
      const listed = await ada.agent.get('/api/files');
      assert.equal(listed.body.files.length, 1);
      assert.equal(listed.body.storage.usedBytes, 8);
      assert.equal(listed.body.storage.limitBytes, 15);
    });
  });

  it('stops accepting sign-in attempts after repeated failures', async () => {
    await withPortal({ loginRateLimit: 2 }, async (handle) => {
      await createUser(handle.db, 'ada', PASSWORD, 4);
      const attempts = [];
      for (let i = 0; i < 4; i += 1) {
        attempts.push(await request(handle.app).post('/api/auth/login').send({ username: 'ada', password: 'wrong-password' }));
      }
      assert.ok(attempts.some((attempt) => attempt.status === 429));
    });
  });

  it('limits how many uploads one person can run at once', async () => {
    await withPortal({ maxUploadsPerUser: 1, maxUploadsGlobal: 4 }, async (handle) => {
      const ada = await account(handle, 'ada');
      const server = http.createServer(handle.app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const boundary = '----holdopen';
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hold.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const held = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/files',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(head.length + (2 * 1024 * 1024)),
          Cookie: ada.cookie,
          'X-CSRF-Token': ada.csrf,
        },
      });
      held.on('error', () => {});
      held.write(head);
      held.write(Buffer.alloc(64 * 1024, 4));
      const tmpDir = path.join(handle.config.storageDir, 'tmp');
      try {
        const caps = await ada.agent.get('/api/auth/me');
        assert.equal(caps.body.uploads.maxPerUser, 1);
        await waitFor(async () => (await readdir(tmpDir)).length > 0);
        const second = await uploadNamed(ada.agent, ada.csrf, 'next.txt', 'hello');
        assert.equal(second.status, 429);
      } finally {
        held.destroy();
      }
      await waitFor(async () => (await readdir(tmpDir)).length === 0);
      const third = await uploadNamed(ada.agent, ada.csrf, 'after.txt', 'hello');
      assert.equal(third.status, 201);
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    });
  });

  it('reports a full disk and does not publish the file', async () => {
    await withPortal({}, async (_handle, dir) => {
      const failing: TempWriter = (filePath) => {
        const stream = createWriteStream(filePath, { flags: 'wx' });
        stream.on('open', () => {
          stream.destroy(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
        });
        return stream;
      };
      const blocked = await createApp(testConfig(dir), { passwordCost: 4, openTemp: failing });
      try {
        const ada = await account(blocked, 'ada');
        const response = await uploadNamed(ada.agent, ada.csrf, 'disk.txt', 'hello');
        assert.equal(response.status, 507);
        assert.match(response.body.error, /disk is full/i);
        const listed = await ada.agent.get('/api/files');
        assert.equal(listed.body.files.length, 0);
      } finally {
        blocked.close();
      }
    });
  });

  it('refuses to start when the storage path is not a folder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-'));
    const blocker = path.join(dir, 'not-a-folder');
    await writeFile(blocker, 'x');
    await assert.rejects(() => createApp(testConfig(dir, { storageDir: blocker }), { passwordCost: 4 }));
    await removeDir(dir);
  });

  it('keeps finished files after a restart and cleans crash leftovers', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-'));
    const config = testConfig(dir);
    const first = await createApp(config, { passwordCost: 4 });
    let fileId = '';
    try {
      const ada = await account(first, 'ada');
      const uploaded = await uploadNamed(ada.agent, ada.csrf, 'kept.txt', 'still-here');
      fileId = uploaded.body.file.id;
      const me = await ada.agent.get('/api/auth/me');
      assert.equal(me.status, 200);
    } finally {
      first.close();
    }

    const second = await createApp(config, { passwordCost: 4 });
    try {
      const agent = request.agent(second.app);
      const login = await agent.post('/api/auth/login').send({ username: 'ada', password: PASSWORD });
      assert.equal(login.status, 200);
      const listed = await agent.get('/api/files').set('X-CSRF-Token', login.body.csrfToken);
      assert.equal(listed.body.files.length, 1);
      assert.equal(listed.body.files[0].id, fileId);
      const downloaded = await agent.get(`/api/files/${fileId}/download`);
      assert.equal(downloaded.status, 200);
      assert.equal(responseText(downloaded), 'still-here');

      const orphanId = randomUUID();
      await writeFile(objectPath(config.storageDir, orphanId)!, 'orphan');
      const tempId = randomUUID();
      await writeFile(tempPath(config.storageDir, tempId)!, 'partial');
      const stagingId = randomUUID();
      const ownerId = listed.body.files[0].ownerId as string;
      stageFile(second.db, {
        id: stagingId,
        ownerId,
        originalName: 'finished-late.txt',
        sizeBytes: 4,
        createdAt: new Date().toISOString(),
      }, config.maxStorageBytes);
      await writeFile(objectPath(config.storageDir, stagingId)!, 'done');
      const brokenId = randomUUID();
      stageFile(second.db, {
        id: brokenId,
        ownerId,
        originalName: 'never.txt',
        sizeBytes: 3,
        createdAt: new Date().toISOString(),
      }, config.maxStorageBytes);
      const incompleteId = randomUUID();
      stageFile(second.db, {
        id: incompleteId,
        ownerId,
        originalName: 'partial.txt',
        sizeBytes: 2,
        createdAt: new Date().toISOString(),
      }, config.maxStorageBytes);
      markReady(second.db, brokenId);
      const corruptId = randomUUID();
      stageFile(second.db, {
        id: corruptId,
        ownerId,
        originalName: 'bad-size.txt',
        sizeBytes: 4,
        createdAt: new Date().toISOString(),
      }, config.maxStorageBytes);
      await writeFile(objectPath(config.storageDir, corruptId)!, 'WRONG');
      markReady(second.db, corruptId);

      const report = await reconcileStorage(second.db, config.storageDir);
      assert.equal(report.publishedInterrupted, 1);
      assert.equal(report.removedIncomplete >= 1, true);
      assert.equal(report.removedCorrupt, 1);
      assert.equal(report.removedOrphans, 1);
      assert.equal(report.removedTemp, 1);
      const after = await agent.get('/api/files');
      const names = after.body.files.map((file: { originalName: string }) => file.originalName);
      assert.ok(names.includes('kept.txt'));
      assert.ok(names.includes('finished-late.txt'));
      assert.equal(names.includes('never.txt'), false);
      assert.equal(names.includes('bad-size.txt'), false);
      removeFileRecord(second.db, stagingId);
    } finally {
      second.close();
      await removeDir(dir);
    }
  });

  it('drops an interrupted upload instead of publishing it', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const server = http.createServer(handle.app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const boundary = '----abortme';
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/files',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(head.length + 1024 * 1024),
          Cookie: ada.cookie,
          'X-CSRF-Token': ada.csrf,
        },
      });
      req.on('error', () => {});
      req.write(head);
      req.write(Buffer.alloc(64 * 1024, 7));
      const tmpDir = path.join(handle.config.storageDir, 'tmp');
      await waitFor(async () => (await readdir(tmpDir)).length > 0);
      req.destroy();
      await waitFor(async () => (await readdir(tmpDir)).length === 0);
      const listed = await ada.agent.get('/api/files');
      assert.equal(listed.body.files.length, 0);
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    });
  });

  it('streams a multi-megabyte file without holding it all in memory', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const server = http.createServer(handle.app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const source = path.join(handle.config.storageDir, 'source.bin');
      const size = 8 * 1024 * 1024;
      await writePattern(source, size);
      const expected = await hashFile(source);
      if (global.gc) global.gc();
      const before = process.memoryUsage().heapUsed;

      const boundary = '----streamboundary';
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const uploaded = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/api/files',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(head.length + size + tail.length),
            Cookie: ada.cookie,
            'X-CSRF-Token': ada.csrf,
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.write(head);
        pipeline(createReadStream(source), req, { end: false })
          .then(() => req.end(tail))
          .catch(reject);
      });
      assert.equal(uploaded.status, 201, uploaded.body);
      const id = JSON.parse(uploaded.body).file.id as string;
      if (global.gc) global.gc();
      const delta = process.memoryUsage().heapUsed - before;
      assert.ok(delta < 24 * 1024 * 1024, `heap grew by ${delta} bytes`);

      const actual = createHash('sha256');
      await new Promise<void>((resolve, reject) => {
        http.get({
          hostname: '127.0.0.1',
          port,
          path: `/api/files/${id}/download`,
          headers: { Cookie: ada.cookie },
        }, (res) => {
          assert.equal(res.statusCode, 200);
          assert.equal(res.headers['content-type'], 'application/octet-stream');
          res.on('data', (chunk: Buffer) => actual.update(chunk));
          res.on('end', () => resolve());
          res.on('error', reject);
        }).on('error', reject);
      });
      assert.equal(actual.digest('hex'), expected);
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    });
  });

  it('resumes an upload from the last saved part', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const created = await ada.agent
        .post('/api/uploads')
        .set('X-CSRF-Token', ada.csrf)
        .send({ originalName: '..\\notes.txt', sizeBytes: 6 });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.session.originalName, 'notes.txt');
      assert.equal(created.body.session.receivedBytes, 0);
      assert.equal(created.body.chunkBytes, 8 * 1024 * 1024);
      const id = created.body.session.id as string;

      const first = await appendChunk(ada.agent, ada.csrf, id, 0, Buffer.from('abc'));
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.session.receivedBytes, 3);

      const listed = await ada.agent.get('/api/uploads');
      assert.equal(listed.status, 200);
      assert.equal(listed.body.sessions.length, 1);
      assert.equal(listed.body.sessions[0].receivedBytes, 3);

      const files = await ada.agent.get('/api/files');
      assert.equal(files.body.files.length, 0);
      assert.equal(files.body.storage.usedBytes, 6);

      const second = await appendChunk(ada.agent, ada.csrf, id, 3, Buffer.from('def'));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.file.originalName, 'notes.txt');
      const downloaded = await ada.agent.get(`/api/files/${id}/download`);
      assert.equal(downloaded.status, 200);
      assert.ok(Buffer.isBuffer(downloaded.body));
      assert.equal(Buffer.compare(downloaded.body, Buffer.from('abcdef')), 0);
      const after = await ada.agent.get('/api/uploads');
      assert.equal(after.body.sessions.length, 0);
    });
  });

  it('rejects a mismatched offset, another person, and an anonymous request', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const blake = await account(handle, 'blake');
      const anonymous = request(handle.app);
      assert.equal((await anonymous.post('/api/uploads').send({ originalName: 'a.txt', sizeBytes: 1 })).status, 401);
      assert.equal((await anonymous.get('/api/uploads')).status, 401);

      const missingToken = await ada.agent.post('/api/uploads').send({ originalName: 'a.txt', sizeBytes: 1 });
      assert.equal(missingToken.status, 403);

      const empty = await ada.agent
        .post('/api/uploads')
        .set('X-CSRF-Token', ada.csrf)
        .send({ originalName: 'empty.dat', sizeBytes: 0 });
      assert.equal(empty.status, 201, JSON.stringify(empty.body));
      assert.equal(empty.body.file.originalName, 'empty.dat');
      assert.equal(empty.body.file.sizeBytes, 0);

      const created = await ada.agent
        .post('/api/uploads')
        .set('X-CSRF-Token', ada.csrf)
        .send({ originalName: 'part.bin', sizeBytes: 4 });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.session.id as string;
      const saved = await appendChunk(ada.agent, ada.csrf, id, 0, Buffer.from('ab'));
      assert.equal(saved.status, 200, JSON.stringify(saved.body));

      const wrong = await appendChunk(ada.agent, ada.csrf, id, 0, Buffer.from('zz'));
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body.receivedBytes, 2);

      const hidden = await appendChunk(blake.agent, blake.csrf, id, 2, Buffer.from('cd'));
      assert.equal(hidden.status, 404);
      const removed = await blake.agent.delete(`/api/uploads/${id}`).set('X-CSRF-Token', blake.csrf);
      assert.equal(removed.status, 404);

      const rest = await appendChunk(ada.agent, ada.csrf, id, 2, Buffer.from('cd'));
      assert.equal(rest.status, 201, JSON.stringify(rest.body));
    });
  });

  it('counts an open upload toward the storage limit', async () => {
    await withPortal({ maxFileBytes: 12, maxStorageBytes: 15 }, async (handle) => {
      const ada = await account(handle, 'ada');
      const created = await ada.agent
        .post('/api/uploads')
        .set('X-CSRF-Token', ada.csrf)
        .send({ originalName: 'reserved.bin', sizeBytes: 10 });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const listed = await ada.agent.get('/api/files');
      assert.equal(listed.body.storage.usedBytes, 10);
      const blocked = await uploadNamed(ada.agent, ada.csrf, 'extra.txt', '12345678');
      assert.equal(blocked.status, 507);
      const second = await ada.agent
        .post('/api/uploads')
        .set('X-CSRF-Token', ada.csrf)
        .send({ originalName: 'more.bin', sizeBytes: 8 });
      assert.equal(second.status, 507);
    });
  });

  it('keeps an unfinished upload across a restart and drops it after it expires', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const created = await ada.agent
        .post('/api/uploads')
        .set('X-CSRF-Token', ada.csrf)
        .send({ originalName: 'keep.bin', sizeBytes: 4 });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.session.id as string;
      const saved = await appendChunk(ada.agent, ada.csrf, id, 0, Buffer.from('ab'));
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const partial = tempPath(handle.config.storageDir, id);
      assert.ok(partial);
      const extra = await open(partial, 'a');
      await extra.write(Buffer.from('zzzz'));
      await extra.close();

      const trimmed = await reconcileStorage(handle.db, handle.config.storageDir);
      assert.equal(trimmed.removedTemp, 0);
      assert.equal((await stat(partial)).size, 2);
      const still = await ada.agent.get('/api/uploads');
      assert.equal(still.body.sessions[0].receivedBytes, 2);

      const shorter = await open(partial, 'r+');
      await shorter.truncate(1);
      await shorter.close();
      await reconcileStorage(handle.db, handle.config.storageDir);
      const lowered = await ada.agent.get('/api/uploads');
      assert.equal(lowered.body.sessions[0].receivedBytes, 1);
      assert.equal((await stat(partial)).size, 1);

      await writeFile(partial, Buffer.from('wxyz'));
      handle.db.prepare('UPDATE upload_sessions SET received_bytes = 4 WHERE id = ?').run(id);
      const published = await reconcileStorage(handle.db, handle.config.storageDir);
      assert.equal(published.publishedInterrupted, 1);
      const downloaded = await ada.agent.get(`/api/files/${id}/download`);
      assert.equal(responseText(downloaded), 'wxyz');

      const again = await ada.agent
        .post('/api/uploads')
        .set('X-CSRF-Token', ada.csrf)
        .send({ originalName: 'old.bin', sizeBytes: 2 });
      assert.equal(again.status, 201, JSON.stringify(again.body));
      const expiredId = again.body.session.id as string;
      handle.db.prepare(`UPDATE upload_sessions SET expires_at = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', expiredId);
      const expired = await reconcileStorage(handle.db, handle.config.storageDir);
      assert.equal(expired.removedTemp, 1);
      const gone = await ada.agent.get('/api/uploads');
      assert.equal(gone.body.sessions.length, 0);
      const expiredTemp = tempPath(handle.config.storageDir, expiredId);
      assert.equal(expiredTemp ? await stat(expiredTemp).then(() => true, () => false) : false, false);
    });
  });

  it('does not keep a chunk that stopped before it was fully received', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const created = await ada.agent
        .post('/api/uploads')
        .set('X-CSRF-Token', ada.csrf)
        .send({ originalName: 'cut.bin', sizeBytes: 200_000 });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.session.id as string;
      const partial = tempPath(handle.config.storageDir, id);
      assert.ok(partial);

      const server = http.createServer(handle.app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      try {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: `/api/uploads/${id}`,
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(100_000),
            'Upload-Offset': '0',
            Cookie: ada.cookie,
            'X-CSRF-Token': ada.csrf,
          },
        });
        req.on('error', () => {});
        req.write(Buffer.alloc(64 * 1024, 7));
        await waitFor(async () => ((await stat(partial).catch(() => null))?.size ?? 0) > 0);
        req.destroy();
        await waitFor(async () => ((await stat(partial).catch(() => null))?.size ?? -1) === 0);
        const listed = await ada.agent.get('/api/uploads');
        assert.equal(listed.body.sessions[0].receivedBytes, 0);
        const files = await ada.agent.get('/api/files');
        assert.equal(files.body.files.length, 0);
      } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
      }
    });
  });

  it('puts files in shared folders and pages the list', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const blake = await account(handle, 'blake');
      assert.equal((await request(handle.app).post('/api/folders').send({ name: 'hidden' })).status, 401);

      const created = await ada.agent
        .post('/api/folders')
        .set('X-CSRF-Token', ada.csrf)
        .send({ name: '..\\..\\outside', parentId: null });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.folder.name, 'outside');
      const folderId = created.body.folder.id as string;

      const duplicate = await ada.agent
        .post('/api/folders')
        .set('X-CSRF-Token', ada.csrf)
        .send({ name: 'OUTSIDE' });
      assert.equal(duplicate.status, 409);

      const forbidden = await blake.agent
        .patch(`/api/folders/${folderId}`)
        .set('X-CSRF-Token', blake.csrf)
        .send({ name: 'nope' });
      assert.equal(forbidden.status, 403);
      const renamed = await ada.agent
        .patch(`/api/folders/${folderId}`)
        .set('X-CSRF-Token', ada.csrf)
        .send({ name: 'Reports' });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

      const child = await ada.agent
        .post('/api/folders')
        .set('X-CSRF-Token', ada.csrf)
        .send({ name: '2026', parentId: folderId });
      assert.equal(child.status, 201, JSON.stringify(child.body));
      const rootFolders = await ada.agent.get('/api/files');
      assert.equal(rootFolders.body.folders.some((folder: { name: string }) => folder.name === '2026'), false);
      const nested = await ada.agent.get('/api/files').query({ folderId });
      assert.equal(nested.body.folders[0].name, '2026');
      assert.equal(nested.body.breadcrumbs.at(-1).name, 'Reports');
      const removedChild = await ada.agent.delete(`/api/folders/${child.body.folder.id}`).set('X-CSRF-Token', ada.csrf);
      assert.equal(removedChild.status, 200);

      const started = await ada.agent
        .post('/api/uploads')
        .set('X-CSRF-Token', ada.csrf)
        .send({ originalName: 'notes.txt', sizeBytes: 4, folderId });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      const fileId = started.body.session.id as string;
      const finished = await appendChunk(ada.agent, ada.csrf, fileId, 0, Buffer.from('note'));
      assert.equal(finished.status, 201, JSON.stringify(finished.body));

      const root = await ada.agent.get('/api/files');
      assert.equal(root.body.files.some((file: { originalName: string }) => file.originalName === 'notes.txt'), false);
      const inside = await blake.agent.get('/api/files').query({ folderId });
      assert.equal(inside.body.files.length, 1);
      assert.equal(inside.body.files[0].folderName, 'Reports');
      const found = await ada.agent.get('/api/files').query({ q: 'notes' });
      assert.equal(found.body.files.length, 1);

      const stored = objectPath(handle.config.storageDir, fileId);
      assert.ok(stored);
      assert.equal(path.basename(path.dirname(stored)), 'objects');
      assert.deepEqual((await readdir(handle.config.storageDir)).sort(), ['objects', 'thumbs', 'tmp']);

      const blocked = await ada.agent.delete(`/api/folders/${folderId}`).set('X-CSRF-Token', ada.csrf);
      assert.equal(blocked.status, 409);
      assert.equal((await ada.agent.delete(`/api/files/${fileId}`).set('X-CSRF-Token', ada.csrf)).status, 200);
      assert.equal((await ada.agent.delete(`/api/folders/${folderId}`).set('X-CSRF-Token', ada.csrf)).status, 200);

      for (const name of ['one.txt', 'two.txt', 'three.txt']) {
        assert.equal((await uploadNamed(ada.agent, ada.csrf, name, name)).status, 201);
      }
      const first = await ada.agent.get('/api/files').query({ limit: 2, sort: 'name', order: 'asc' });
      assert.equal(first.body.files.length, 2);
      assert.equal(typeof first.body.page.nextCursor, 'string');
      const second = await ada.agent.get('/api/files').query({
        limit: 2,
        sort: 'name',
        order: 'asc',
        cursor: first.body.page.nextCursor,
      });
      assert.equal(second.body.files.length, 1);
      assert.equal(second.body.page.nextCursor, null);
      const names = [...first.body.files, ...second.body.files].map((file: { originalName: string }) => file.originalName);
      assert.deepEqual(names, ['one.txt', 'three.txt', 'two.txt']);
      assert.equal((await ada.agent.get('/api/files').query({ cursor: 'not-a-page' })).status, 400);
    });
  });

  it('moves and deletes only your files, packs a zip, and keeps folder paths inside the open folder', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const blake = await account(handle, 'blake');
      assert.equal((await request(handle.app).post('/api/files/move').send({ ids: ['x'] })).status, 401);
      assert.equal((await request(handle.app).get('/api/files/zip')).status, 401);

      const ensured = await ada.agent
        .post('/api/folders/ensure')
        .set('X-CSRF-Token', ada.csrf)
        .send({ path: '..\\outside\\nested', parentId: null });
      assert.equal(ensured.status, 201, JSON.stringify(ensured.body));
      const folderId = ensured.body.folderId as string;
      const again = await ada.agent
        .post('/api/folders/ensure')
        .set('X-CSRF-Token', ada.csrf)
        .send({ path: 'outside/nested', parentId: null });
      assert.equal(again.status, 201, JSON.stringify(again.body));
      assert.equal(again.body.folderId, folderId);
      assert.deepEqual(again.body.created, []);
      assert.deepEqual((await readdir(handle.config.storageDir)).sort(), ['objects', 'thumbs', 'tmp']);

      const mine = await uploadNamed(ada.agent, ada.csrf, 'mine.txt', 'hello');
      const theirs = await uploadNamed(blake.agent, blake.csrf, 'theirs.txt', 'secret');
      assert.equal(mine.status, 201, JSON.stringify(mine.body));
      assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
      const mineId = mine.body.file.id as string;
      const theirsId = theirs.body.file.id as string;

      const missingToken = await ada.agent.post('/api/files/move').send({ ids: [mineId], folderId });
      assert.equal(missingToken.status, 403);

      const packed = await ada.agent.get('/api/files/zip').query({ ids: `${mineId},${theirsId}` });
      assert.equal(packed.status, 200);
      assert.match(String(packed.headers['content-type']), /application\/zip/);
      assert.match(String(packed.headers['content-disposition']), /portal-files\.zip/);
      const zip = Buffer.isBuffer(packed.body) ? packed.body : Buffer.from(packed.text ?? '');
      assert.equal(zip.subarray(0, 2).toString('utf8'), 'PK');
      assert.equal(zip.includes(Buffer.from('hello')), true);
      assert.equal(zip.includes(Buffer.from('secret')), true);
      assert.equal(zip.includes(Buffer.from('mine.txt')), true);

      const moved = await ada.agent
        .post('/api/files/move')
        .set('X-CSRF-Token', ada.csrf)
        .send({ ids: [mineId, theirsId], folderId });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.deepEqual(moved.body.moved, [mineId]);
      assert.equal(moved.body.skipped[0].id, theirsId);
      assert.equal(moved.body.skipped[0].reason, 'forbidden');
      const inside = await ada.agent.get('/api/files').query({ folderId });
      assert.equal(inside.body.files.some((file: { id: string }) => file.id === mineId), true);
      const root = await ada.agent.get('/api/files');
      assert.equal(root.body.files.some((file: { id: string }) => file.id === mineId), false);
      assert.equal(root.body.files.some((file: { id: string }) => file.id === theirsId), true);

      const removed = await ada.agent
        .post('/api/files/delete-many')
        .set('X-CSRF-Token', ada.csrf)
        .send({ ids: [mineId, theirsId] });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.deepEqual(removed.body.deleted, [mineId]);
      assert.equal(removed.body.skipped[0].reason, 'forbidden');
      const still = await blake.agent.get(`/api/files/${theirsId}/download`);
      assert.equal(responseText(still), 'secret');
    });
  });

  it('keeps favorites personal and shares tags and collections', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const blake = await account(handle, 'blake');
      const folder = await ada.agent.post('/api/folders').set('X-CSRF-Token', ada.csrf).send({ name: 'Notes', parentId: null });
      assert.equal(folder.status, 201);
      const uploaded = await ada.agent
        .post('/api/files')
        .set('X-CSRF-Token', ada.csrf)
        .set('X-Folder-Id', folder.body.folder.id)
        .attach('file', Buffer.from('inside'), { filename: 'inside.txt' });
      assert.equal(uploaded.status, 201);
      const fileId = uploaded.body.file.id as string;
      const other = await uploadNamed(ada.agent, ada.csrf, 'outside.txt', 'root');

      const anonymous = await request(handle.app).post(`/api/files/${fileId}/favorite`);
      assert.equal(anonymous.status, 401);
      const missingToken = await ada.agent.post(`/api/files/${fileId}/favorite`);
      assert.equal(missingToken.status, 403);

      const starred = await ada.agent.post(`/api/files/${fileId}/favorite`).set('X-CSRF-Token', ada.csrf);
      assert.equal(starred.status, 200);
      const adaWide = await ada.agent.get('/api/files?favorite=1');
      assert.equal(adaWide.body.folders.length, 0);
      assert.deepEqual(adaWide.body.files.map((file: { originalName: string; favorite: boolean }) => [file.originalName, file.favorite]), [['inside.txt', true]]);
      const blakeList = await blake.agent.get('/api/files');
      const blakeRow = blakeList.body.files.find((file: { id: string }) => file.id === other.body.file.id);
      assert.equal(blakeRow.favorite, false);
      const blakeWide = await blake.agent.get('/api/files?favorite=1');
      assert.equal(blakeWide.body.files.some((file: { id: string }) => file.id === fileId), false);

      const tagged = await ada.agent.post('/api/files/tags').set('X-CSRF-Token', ada.csrf).send({ ids: [fileId], name: 'minutes/final' });
      assert.equal(tagged.status, 201);
      assert.equal(tagged.body.tag.name, 'final');
      const shared = await blake.agent.get(`/api/files?tagId=${tagged.body.tag.id}`);
      assert.equal(shared.body.files.length, 1);
      assert.equal(shared.body.files[0].tags[0].name, 'final');
      const removed = await blake.agent.delete(`/api/files/${fileId}/tags/${tagged.body.tag.id}`).set('X-CSRF-Token', blake.csrf);
      assert.equal(removed.status, 200);
      const tags = await ada.agent.get('/api/tags');
      assert.equal(tags.body.tags.length, 0);

      const collection = await ada.agent.post('/api/collections').set('X-CSRF-Token', ada.csrf).send({ name: 'Board pack' });
      assert.equal(collection.status, 201);
      const seen = await blake.agent.get('/api/collections');
      assert.equal(seen.body.collections[0].name, 'Board pack');
      assert.equal(seen.body.collections[0].canDelete, false);
      const added = await blake.agent.post(`/api/collections/${collection.body.collection.id}/files`).set('X-CSRF-Token', blake.csrf).send({ ids: [fileId] });
      assert.equal(added.status, 200);
      const filtered = await ada.agent.get(`/api/files?collectionId=${collection.body.collection.id}`);
      assert.equal(filtered.body.files.length, 1);
      assert.equal(filtered.body.files[0].originalName, 'inside.txt');
      const blocked = await blake.agent.delete(`/api/collections/${collection.body.collection.id}`).set('X-CSRF-Token', blake.csrf);
      assert.equal(blocked.status, 403);
      const renamed = await blake.agent.patch(`/api/collections/${collection.body.collection.id}`).set('X-CSRF-Token', blake.csrf).send({ name: 'Nope' });
      assert.equal(renamed.status, 403);
      const deleted = await ada.agent.delete(`/api/files/${fileId}`).set('X-CSRF-Token', ada.csrf);
      assert.equal(deleted.status, 200);
      const afterDelete = await ada.agent.get(`/api/files?collectionId=${collection.body.collection.id}`);
      assert.equal(afterDelete.body.files.length, 0);
      const removedCollection = await ada.agent.delete(`/api/collections/${collection.body.collection.id}`).set('X-CSRF-Token', ada.csrf);
      assert.equal(removedCollection.status, 200);
      const stillThere = await ada.agent.get('/api/files');
      assert.equal(stillThere.body.files.some((file: { originalName: string }) => file.originalName === 'outside.txt'), true);
    });
  });

  it('keeps an earlier version only when the uploader replaces a file', async () => {
    await withPortal({ maxStorageBytes: 24 }, async (handle) => {
      const ada = await account(handle, 'ada');
      const blake = await account(handle, 'blake');
      const original = await uploadNamed(ada.agent, ada.csrf, 'notes.txt', '12345678');
      assert.equal(original.status, 201);
      const fileId = original.body.file.id as string;
      assert.equal((await request(handle.app).post(`/api/files/${fileId}/replace`)).status, 401);
      assert.equal((await ada.agent.post(`/api/files/${fileId}/replace`).attach('file', Buffer.from('87654321'), 'notes.txt')).status, 403);

      const replaced = await ada.agent
        .post(`/api/files/${fileId}/replace`)
        .set('X-CSRF-Token', ada.csrf)
        .attach('file', Buffer.from('87654321'), { filename: 'renamed.txt' });
      assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
      assert.equal(replaced.body.file.originalName, 'renamed.txt');
      assert.equal(replaced.body.file.versionCount, 1);
      assert.equal(replaced.body.file.id, fileId);
      const current = await ada.agent.get(`/api/files/${fileId}/download`);
      assert.equal(responseText(current), '87654321');
      const versions = await ada.agent.get(`/api/files/${fileId}/versions`);
      assert.equal(versions.body.versions.length, 1);
      assert.equal(versions.body.versions[0].originalName, 'notes.txt');
      const versionId = versions.body.versions[0].id as string;
      const earlier = await blake.agent.get(`/api/files/${fileId}/versions/${versionId}/download`);
      assert.equal(earlier.status, 200);
      assert.equal(responseText(earlier), '12345678');
      assert.match(String(earlier.headers['content-disposition']), /attachment/);
      assert.equal((await blake.agent.delete(`/api/files/${fileId}/versions/${versionId}`).set('X-CSRF-Token', blake.csrf)).status, 403);
      assert.equal((await ada.agent.get('/api/files')).body.storage.usedBytes, 16);

      const again = await uploadNamed(ada.agent, ada.csrf, 'notes.txt', 'abcdefgh');
      assert.equal(again.status, 201);
      assert.notEqual(again.body.file.id, fileId);
      assert.equal((await ada.agent.get('/api/files')).body.files.length, 2);

      const blocked = await ada.agent
        .post(`/api/files/${fileId}/replace`)
        .set('X-CSRF-Token', ada.csrf)
        .attach('file', Buffer.from('zzzzzzzz'), { filename: 'renamed.txt' });
      assert.equal(blocked.status, 507);
      assert.equal(responseText(await ada.agent.get(`/api/files/${fileId}/download`)), '87654321');

      assert.equal((await ada.agent.delete(`/api/files/${fileId}/versions/${versionId}`).set('X-CSRF-Token', ada.csrf)).status, 200);
      assert.equal((await ada.agent.get('/api/files')).body.storage.usedBytes, 16);
      const versionPath = objectPath(handle.config.storageDir, versionId);
      assert.ok(versionPath);
      await assert.rejects(stat(versionPath));
    });
  });

  it('keeps a deleted file in the owner bin until it is restored or expires', async () => {
    await withPortal({ maxStorageBytes: 10 }, async (handle) => {
      const ada = await account(handle, 'ada');
      const blake = await account(handle, 'blake');
      const uploaded = await uploadNamed(ada.agent, ada.csrf, 'notes.txt', '12345678');
      assert.equal(uploaded.status, 201);
      const fileId = uploaded.body.file.id as string;
      const stored = objectPath(handle.config.storageDir, fileId);
      assert.ok(stored);
      const used = (await ada.agent.get('/api/files')).body.storage.usedBytes;
      assert.equal(used, 8);

      assert.equal((await request(handle.app).get('/api/bin')).status, 401);
      assert.equal((await ada.agent.post(`/api/files/${fileId}/restore`)).status, 403);
      const removed = await ada.agent.delete(`/api/files/${fileId}`).set('X-CSRF-Token', ada.csrf);
      assert.equal(removed.status, 200);
      assert.equal((await stat(stored!)).isFile(), true);
      const listed = await ada.agent.get('/api/files');
      assert.equal(listed.body.files.some((file: { id: string }) => file.id === fileId), false);
      assert.equal(listed.body.storage.usedBytes, 8);
      const full = await uploadNamed(ada.agent, ada.csrf, 'more.txt', '12345678');
      assert.equal(full.status, 507);

      const adaBin = await ada.agent.get('/api/bin');
      assert.equal(adaBin.body.retentionDays, 30);
      assert.equal(adaBin.body.files.length, 1);
      assert.equal(adaBin.body.files[0].originalName, 'notes.txt');
      const blakeBin = await blake.agent.get('/api/bin');
      assert.equal(blakeBin.body.files.length, 0);
      assert.equal((await ada.agent.get(`/api/files/${fileId}/download`)).status, 404);
      const blocked = await blake.agent.post(`/api/files/${fileId}/restore`).set('X-CSRF-Token', blake.csrf);
      assert.equal(blocked.status, 403);

      const restored = await ada.agent.post(`/api/files/${fileId}/restore`).set('X-CSRF-Token', ada.csrf);
      assert.equal(restored.status, 200);
      assert.equal((await ada.agent.get(`/api/files/${fileId}/download`)).status, 200);
      assert.equal((await ada.agent.get('/api/bin')).body.files.length, 0);

      assert.equal((await ada.agent.delete(`/api/files/${fileId}`).set('X-CSRF-Token', ada.csrf)).status, 200);
      const blockedPurge = await blake.agent.delete(`/api/files/${fileId}/permanent`).set('X-CSRF-Token', blake.csrf);
      assert.equal(blockedPurge.status, 403);
      handle.db.prepare('UPDATE files SET deleted_at = ? WHERE id = ?').run(
        new Date(Date.now() - BIN_RETENTION_MS - 1000).toISOString(),
        fileId,
      );
      const afterExpiry = await ada.agent.get('/api/bin');
      assert.equal(afterExpiry.body.files.length, 0);
      assert.equal(afterExpiry.body.storage.usedBytes, 0);
      await assert.rejects(stat(stored!));
      const again = await uploadNamed(ada.agent, ada.csrf, 'more.txt', '12345678');
      assert.equal(again.status, 201);
    });
  });

  it('previews images and text without rendering HTML', async () => {
    await withPortal({}, async (handle) => {
      const ada = await account(handle, 'ada');
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const image = await uploadNamed(ada.agent, ada.csrf, 'dot.png', png);
      assert.equal(image.status, 201, JSON.stringify(image.body));
      assert.equal(image.body.file.preview, 'image');
      const imageId = image.body.file.id as string;
      assert.equal((await request(handle.app).get(`/api/files/${imageId}/preview`)).status, 401);
      const preview = await ada.agent.get(`/api/files/${imageId}/preview`);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers['content-type'], 'image/png');
      assert.equal(preview.headers['content-disposition'], 'inline');
      assert.equal(preview.headers['x-content-type-options'], 'nosniff');
      assert.equal(Buffer.isBuffer(preview.body), true);
      assert.equal(Buffer.compare(preview.body as Buffer, png), 0);

      const note = await uploadNamed(ada.agent, ada.csrf, 'note.txt', '<html><script>alert(1)</script></html>');
      assert.equal(note.body.file.preview, 'text');
      const text = await ada.agent.get(`/api/files/${note.body.file.id}/preview`);
      assert.equal(text.status, 200);
      assert.match(String(text.headers['content-type']), /^text\/plain/);
      assert.equal(text.headers['x-content-type-options'], 'nosniff');
      assert.equal(responseText(text), '<html><script>alert(1)</script></html>');

      const html = await uploadNamed(ada.agent, ada.csrf, 'page.html', '<html><script>alert(1)</script></html>');
      assert.equal(html.body.file.preview, 'none');
      const htmlPreview = await ada.agent.get(`/api/files/${html.body.file.id}/preview`);
      assert.equal(htmlPreview.status, 415);
      assert.match(String(htmlPreview.headers['content-type']), /json/);
      assert.equal(String(htmlPreview.headers['content-type']).includes('text/html'), false);

      const svg = await uploadNamed(ada.agent, ada.csrf, 'icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      const svgPreview = await ada.agent.get(`/api/files/${svg.body.file.id}/preview`);
      assert.equal(svgPreview.status, 415);
      assert.equal(String(svgPreview.headers['content-type']).includes('svg'), false);

      const binary = await uploadNamed(ada.agent, ada.csrf, 'binary.txt', Buffer.from([0x68, 0x69, 0x00]));
      assert.equal((await ada.agent.get(`/api/files/${binary.body.file.id}/preview`)).status, 415);

      const longFile = await uploadNamed(ada.agent, ada.csrf, 'long.txt', Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 10, 0x61));
      const longPreview = await ada.agent.get(`/api/files/${longFile.body.file.id}/preview`);
      assert.equal(longPreview.status, 200);
      assert.equal(longPreview.headers['x-preview-truncated'], '1');
      assert.equal(responseText(longPreview).length, TEXT_PREVIEW_MAX_BYTES);

      const bigImage = await uploadNamed(ada.agent, ada.csrf, 'big.png', Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES + 1, 1));
      assert.equal(bigImage.status, 201, JSON.stringify(bigImage.body));
      assert.equal(bigImage.body.file.preview, 'none');
      assert.equal((await ada.agent.get(`/api/files/${bigImage.body.file.id}/preview`)).status, 415);
      assert.equal((await ada.agent.get(`/api/files/${bigImage.body.file.id}/thumbnail`)).status, 404);

      await whenJobsIdle();
      const thumb = await ada.agent.get(`/api/files/${imageId}/thumbnail`);
      assert.equal(thumb.status, 200);
      assert.match(String(thumb.headers['content-type']), /^image\/(png|jpeg)/);
      assert.equal(thumb.headers['x-content-type-options'], 'nosniff');
      assert.equal((await ada.agent.get(`/api/files/${note.body.file.id}/thumbnail`)).status, 404);

      const removed = await ada.agent.delete(`/api/files/${imageId}`).set('X-CSRF-Token', ada.csrf);
      assert.equal(removed.status, 200);
      const purged = await ada.agent.delete(`/api/files/${imageId}/permanent`).set('X-CSRF-Token', ada.csrf);
      assert.equal(purged.status, 200);
      const removedThumb = thumbPath(handle.config.storageDir, imageId);
      assert.ok(removedThumb);
      await assert.rejects(stat(removedThumb));

      const stray = thumbPath(handle.config.storageDir, randomUUID());
      assert.ok(stray);
      await writeFile(stray, Buffer.from('nope'));
      await reconcileStorage(handle.db, handle.config.storageDir);
      await assert.rejects(stat(stray));
    });
  });

  it('keeps the thumbnail queue to eight jobs', async () => {
    const jobs = createJobRunner();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = 0;
    for (let index = 0; index < 8; index += 1) {
      assert.equal(jobs.enqueue(async () => {
        await gate;
        ran += 1;
      }), true);
    }
    assert.equal(jobs.enqueue(async () => undefined), false);
    release();
    await jobs.whenIdle();
    assert.equal(ran, 8);
  });

  it('creates a user from the command line without printing the password', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-'));
    const password = 'command-line-password';
    const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/create-user.ts', 'casey'], {
      cwd: serverRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '3000',
        DATABASE_PATH: path.join(dir, 'app.db'),
        STORAGE_DIR: path.join(dir, 'storage'),
        SESSION_SECRET: 'cli-test-session-secret',
        PORTAL_NEW_PASSWORD: password,
        HTTPS_PFX_PATH: '',
        HTTPS_KEY_PATH: '',
        HTTPS_CERT_PATH: '',
        HTTPS_PFX_PASSPHRASE: '',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const code = await new Promise<number>((resolve) => child.on('close', resolve));
    assert.equal(code, 0, output);
    assert.equal(output.includes(password), false);
    const handle = await createApp(testConfig(dir, { databasePath: path.join(dir, 'app.db') }), { passwordCost: 4 });
    try {
      const login = await request(handle.app).post('/api/auth/login').send({ username: 'casey', password });
      assert.equal(login.status, 200, JSON.stringify(login.body));
    } finally {
      handle.close();
      await removeDir(dir);
    }
  });
});

async function writePattern(filePath: string, size: number): Promise<void> {
  const handle = await open(filePath, 'w');
  try {
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let left = size;
    while (left > 0) {
      const slice = chunk.subarray(0, Math.min(chunk.length, left));
      await handle.write(slice);
      left -= slice.length;
    }
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}
