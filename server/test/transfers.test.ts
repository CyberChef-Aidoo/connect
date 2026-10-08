import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { createTransferTracker } from '../src/transferTrack.js';
import { createUser } from '../src/users.js';

const PASSWORD = 'test-password-1';

function testConfig(dir: string): AppConfig {
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
    openAccess: false,
  };
}

describe('transfer tracker', () => {
  it('shows sent bytes to the owner only and never reports a saved file', () => {
    const tracker = createTransferTracker();
    let aborted = false;
    const id = randomUUID();
    assert.equal(tracker.open({
      id,
      sessionId: 'ada-session',
      filename: 'notes.txt',
      kind: 'library',
      totalBytes: 5,
      sourceTotal: 5,
      abort: () => { aborted = true; },
    }), true);
    tracker.add(id, 'sentBytes', 5);
    const view = tracker.view('ada-session', id);
    assert.equal(view?.sentBytes, 5);
    assert.equal(view?.savedBytes, null);
    assert.equal(tracker.view('blake-session', id), null);
    assert.equal(tracker.cancel('ada-session', id), true);
    assert.equal(aborted, true);
    assert.equal(tracker.view('ada-session', id)?.error, 'stopped');
  });

  it('keeps a zip length unknown', () => {
    const tracker = createTransferTracker();
    const id = randomUUID();
    tracker.open({
      id,
      sessionId: 'ada-session',
      filename: 'files.zip',
      kind: 'library-zip',
      totalBytes: null,
      sourceTotal: 9,
      abort: () => undefined,
    });
    tracker.add(id, 'sentBytes', 12);
    tracker.add(id, 'sourceBytes', 9);
    tracker.finish(id);
    const view = tracker.view('ada-session', id);
    assert.equal(view?.totalBytes, null);
    assert.equal(view?.sentBytes, 12);
    assert.equal(view?.sourceBytes, 9);
    assert.equal(view?.savedBytes, null);
    assert.equal(view?.done, true);
  });
});

describe('download progress', () => {
  it('counts a library download and a zip without inventing a zip length', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-progress-'));
    const handle = await createApp(testConfig(dir), { passwordCost: 4 });
    try {
      await createUser(handle.db, 'ada', PASSWORD, 4);
      await createUser(handle.db, 'blake', PASSWORD, 4);
      const ada = request.agent(handle.app);
      const blake = request.agent(handle.app);
      const adaLogin = await ada.post('/api/auth/login').send({ username: 'ada', password: PASSWORD });
      const blakeLogin = await blake.post('/api/auth/login').send({ username: 'blake', password: PASSWORD });
      assert.equal(adaLogin.status, 200);
      const uploaded = await ada.post('/api/files').set('X-CSRF-Token', adaLogin.body.csrfToken).attach('file', Buffer.from('hello'), { filename: 'notes.txt' });
      assert.equal(uploaded.status, 201);
      const fileId = uploaded.body.file.id as string;
      const progressId = randomUUID();
      const downloaded = await ada.get(`/api/files/${fileId}/download`).query({ progress: progressId });
      assert.equal(downloaded.status, 200);
      assert.equal(downloaded.headers['content-length'], '5');
      assert.equal(Buffer.isBuffer(downloaded.body) ? downloaded.body.toString('utf8') : downloaded.text, 'hello');
      const progress = await ada.get(`/api/transfers/${progressId}`);
      assert.equal(progress.status, 200);
      assert.equal(progress.body.sentBytes, 5);
      assert.equal(progress.body.savedBytes, null);
      assert.equal(progress.body.done, true);
      assert.equal(JSON.stringify(progress.body).includes(PASSWORD), false);
      const hidden = await blake.get(`/api/transfers/${progressId}`);
      assert.equal(hidden.status, 404);
      assert.equal(blakeLogin.status, 200);

      const zipId = randomUUID();
      const zip = await ada.get('/api/files/zip').query({ ids: fileId, progress: zipId });
      assert.equal(zip.status, 200);
      assert.equal(zip.headers['content-length'], undefined);
      const zipBytes = Buffer.isBuffer(zip.body) ? zip.body : Buffer.from(zip.text ?? '');
      assert.equal(zipBytes.subarray(0, 2).toString('utf8'), 'PK');
      const zipProgress = await ada.get(`/api/transfers/${zipId}`);
      assert.equal(zipProgress.body.totalBytes, null);
      assert.ok(zipProgress.body.sentBytes > 5);
      assert.equal(zipProgress.body.sourceBytes, 5);
      assert.equal(zipProgress.body.savedBytes, null);
      assert.equal(zipProgress.body.done, true);
    } finally {
      handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
