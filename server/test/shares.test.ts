import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { prepareShareFiles, sanitizeSharePath } from '../src/sharePaths.js';

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
    openAccess: true,
  };
}

describe('share paths', () => {
  it('rejects absolute paths and traversal and renames case collisions', () => {
    assert.equal(sanitizeSharePath('C:\\Users\\notes.txt'), null);
    assert.equal(sanitizeSharePath('/etc/passwd'), null);
    assert.equal(sanitizeSharePath('docs/../../secret.txt'), null);
    assert.equal(sanitizeSharePath('folder/notes.txt'), 'folder/notes.txt');
    const prepared = prepareShareFiles([
      { clientToken: 'a', relativePath: 'Folder/Notes.txt', size: 4, modifiedAt: 1 },
      { clientToken: 'b', relativePath: 'folder/notes.txt', size: 4, modifiedAt: 2 },
    ], 10, 100);
    assert.equal(prepared.rejected.length, 0);
    assert.deepEqual(prepared.files.map((file) => file.relativePath), ['Folder/Notes.txt', 'folder/notes (2).txt']);
  });
});

describe('read-only shares', () => {
  it('publishes only to chosen peers and streams a file without storing it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-share-'));
    const handle = await createApp(testConfig(dir), { passwordCost: 4 });
    const server = http.createServer(handle.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    try {
      const ada = await signIn(base, 'Ada');
      const blake = await signIn(base, 'Blake');
      const preview = await send(base, ada, '/api/shares/preview', {
        files: [
          { clientToken: 'keep', relativePath: 'docs/notes.txt', size: 5, modifiedAt: 10 },
          { clientToken: 'drop', relativePath: '../secret.txt', size: 5, modifiedAt: 10 },
        ],
      });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.files.length, 1);
      assert.equal(preview.body.files[0].relativePath, 'docs/notes.txt');
      assert.equal(preview.body.rejected.length, 1);

      const outsider = await send(base, ada, '/api/shares', {
        name: 'Notes',
        peerIds: [],
        files: preview.body.files,
      });
      assert.equal(outsider.status, 201);
      const hidden = await get(base, blake, `/api/shares/${outsider.body.share.id}/files/${outsider.body.files[0].id}`);
      assert.equal(hidden.status, 403);

      const shared = await send(base, ada, '/api/shares', {
        name: 'Notes',
        peerIds: [blake.peerId],
        files: [{ clientToken: 'keep', relativePath: 'docs/notes.txt', size: 5, modifiedAt: 10 }],
      });
      assert.equal(shared.status, 201);
      const fileId = shared.body.files[0].id as string;
      const shareId = shared.body.share.id as string;

      const download = get(base, blake, `/api/shares/${shareId}/files/${fileId}`);
      const job = await waitForJob(base, ada);
      const uploaded = await fetch(`${base}/api/shares/outbox/${job.id}/files/${fileId}`, {
        method: 'POST',
        headers: {
          Cookie: ada.cookie,
          'X-CSRF-Token': ada.csrf,
          'Content-Type': 'application/octet-stream',
          'Content-Length': '5',
        },
        body: Buffer.from('hello'),
      });
      assert.equal(uploaded.status, 200);
      const received = await download;
      assert.equal(received.status, 200);
      assert.equal(received.headers.get('x-transfer-mode'), 'relay');
      assert.equal(await received.text(), 'hello');

      const revoked = await fetch(`${base}/api/shares/${shareId}`, {
        method: 'DELETE',
        headers: { Cookie: ada.cookie, 'X-CSRF-Token': ada.csrf },
      });
      assert.equal(revoked.status, 200);
      const again = await get(base, blake, `/api/shares/${shareId}/files/${fileId}`);
      assert.equal(again.status, 403);
      const names = await readdir(handle.config.storageDir);
      assert.deepEqual(names.sort(), ['objects', 'thumbs', 'tmp']);
    } finally {
      server.close();
      handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function signIn(base: string, displayName: string) {
  const me = await fetch(`${base}/api/auth/me`);
  const body = await me.json() as { csrfToken: string };
  const cookie = (me.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ');
  const beat = await fetch(`${base}/api/peers/heartbeat`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': body.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  const beatBody = await beat.json() as { peerId: string };
  return { cookie, csrf: body.csrfToken, peerId: beatBody.peerId };
}

async function send(base: string, who: { cookie: string; csrf: string }, pathName: string, body: unknown) {
  const response = await fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { Cookie: who.cookie, 'X-CSRF-Token': who.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function get(base: string, who: { cookie: string }, pathName: string) {
  return fetch(`${base}${pathName}`, { headers: { Cookie: who.cookie } });
}

async function waitForJob(base: string, who: { cookie: string }) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const response = await fetch(`${base}/api/shares/outbox`, { headers: { Cookie: who.cookie } });
    const body = await response.json() as { jobs: Array<{ id: string; files: Array<{ fileId: string }> }> };
    const ready = body.jobs.find((job) => (job as { ready?: boolean }).ready);
    if (ready) return ready;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The sender never saw the download.');
}
