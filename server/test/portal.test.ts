import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp, type AppHandle, type AppOptions } from '../src/app.js';
import { assertBindSafety, resolveConfig } from '../src/config.js';
import { markReady, removeFileRecord, stageFile } from '../src/files.js';
import { reconcileStorage } from '../src/reconcile.js';
import { attachmentDisposition, objectPath, sanitizeOriginalName, tempPath } from '../src/storage.js';
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
  const cookie = (login.headers['set-cookie'] as string[] | undefined ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');
  return {
    agent,
    cookie,
    csrf: login.body.csrfToken as string,
    userId: login.body.user.id as string,
  };
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
      assert.equal(downloaded.text, 'beta-longer');

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
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="..\\\\..\\\\outside.txt"\r\nContent-Type: application/octet-stream\r\n\nsafe\r\n--${boundary}--\r\n`,
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
      await assert.rejects(stat(stored!));
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
    await withPortal({ maxFileBytes: 8, maxStorageBytes: 15 }, async (handle) => {
      const ada = await account(handle, 'ada');
      const tooBig = await uploadNamed(ada.agent, ada.csrf, 'big.txt', '0123456789');
      assert.equal(tooBig.status, 413);
      const first = await uploadNamed(ada.agent, ada.csrf, 'one.txt', '12345');
      assert.equal(first.status, 201);
      const second = await uploadNamed(ada.agent, ada.csrf, 'two.txt', '123456');
      assert.equal(second.status, 507);
      const listed = await ada.agent.get('/api/files');
      assert.equal(listed.body.files.length, 1);
      assert.equal(listed.body.storage.usedBytes, 5);
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
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocking: TempWriter = (filePath) => {
        const stream = createWriteStream(filePath, { flags: 'wx' });
        const write = stream.write.bind(stream);
        stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
          void gate.then(() => {
            write(chunk as never, encoding as never, callback as never);
          });
          return true;
        }) as WriteStream['write'];
        return stream;
      };
      const handleBlocked = await createApp(handle.config, { passwordCost: 4, openTemp: blocking });
      try {
        const user = await account(handleBlocked, 'ada');
        const first = uploadNamed(user.agent, user.csrf, 'slow.txt', 'hello');
        await new Promise((resolve) => setTimeout(resolve, 100));
        const second = await uploadNamed(user.agent, user.csrf, 'next.txt', 'hello');
        assert.equal(second.status, 429);
        release!();
        assert.equal((await first).status, 201);
      } finally {
        release!();
        handleBlocked.close();
      }
      void ada;
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
      assert.equal(downloaded.text, 'still-here');

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
      await new Promise<void>((resolve) => {
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
        req.write(head);
        req.write(Buffer.alloc(32 * 1024, 7));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 100);
      });
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const tmp = await readdir(path.join(handle.config.storageDir, 'tmp'));
      assert.deepEqual(tmp, []);
      const listed = await ada.agent.get('/api/files');
      assert.equal(listed.body.files.length, 0);
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

  it('creates a user from the command line without printing the password', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-'));
    const password = 'command-line-password';
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/create-user.ts', 'casey'], {
      cwd: path.resolve('src', '..'),
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
