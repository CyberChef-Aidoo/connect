import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { prepareShareFiles, sanitizeSharePath } from '../src/sharePaths.js';
import { createShareHub } from '../src/shares.js';

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

describe('share presence', () => {
  it('forgets a browser that stops checking in, and shows it again when it returns', () => {
    const hub = createShareHub(1000);
    hub.beat('ada', 'Ada', 0);
    hub.beat('blake', 'Blake', 0);
    assert.equal(hub.online(0).length, 2);
    assert.equal(hub.online(21_000).length, 0);
    hub.beat('blake', 'Blake', 22_000);
    assert.deepEqual(hub.online(22_000).map((person) => person.peerId), ['blake']);
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

      const progressId = randomUUID();
      const download = get(base, blake, `/api/shares/${shareId}/files/${fileId}?progress=${progressId}`);
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
      const progress = await fetch(`${base}/api/transfers/${progressId}`, { headers: { Cookie: blake.cookie } });
      assert.equal(progress.status, 200);
      const progressBody = await progress.json() as { sentBytes: number; uploadBytes: number; savedBytes: null; totalBytes: number; done: boolean };
      assert.equal(progressBody.sentBytes, 5);
      assert.equal(progressBody.uploadBytes, 5);
      assert.equal(progressBody.savedBytes, null);
      assert.equal(progressBody.totalBytes, 5);
      assert.equal(progressBody.done, true);
      const hiddenProgress = await fetch(`${base}/api/transfers/${progressId}`, { headers: { Cookie: ada.cookie } });
      assert.equal(hiddenProgress.status, 404);

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

  it('streams a folder zip without writing the archive, and revoke stops a download in progress', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-share-zip-'));
    const handle = await createApp(testConfig(dir), { passwordCost: 4 });
    const server = http.createServer(handle.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    try {
      const ada = await signIn(base, 'Ada');
      const blake = await signIn(base, 'Blake');
      const shared = await send(base, ada, '/api/shares', {
        name: 'Docs',
        peerIds: [blake.peerId],
        files: [
          { clientToken: 'a', relativePath: 'docs/a.txt', size: 3, modifiedAt: 1 },
          { clientToken: 'b', relativePath: 'docs/b.txt', size: 3, modifiedAt: 1 },
        ],
      });
      assert.equal(shared.status, 201);
      const shareId = shared.body.share.id as string;
      const [first, second] = shared.body.files as Array<{ id: string }>;
      const download = get(base, blake, `/api/shares/${shareId}/archive?dir=${encodeURIComponent('docs')}`);
      await postReadyFile(base, ada, first.id, 'one');
      await postReadyFile(base, ada, second.id, 'two');
      const received = await download;
      assert.equal(received.status, 200);
      assert.equal(received.headers.get('x-transfer-mode'), 'relay');
      assert.equal(received.headers.get('content-length'), null);
      const bytes = Buffer.from(await received.arrayBuffer());
      assert.equal(bytes.subarray(0, 2).toString(), 'PK');
      assert.equal(bytes.includes(Buffer.from('one')), true);
      assert.equal(bytes.includes(Buffer.from('two')), true);

      const again = await send(base, ada, '/api/shares', {
        name: 'One',
        peerIds: [blake.peerId],
        files: [{ clientToken: 'c', relativePath: 'note.txt', size: 4, modifiedAt: 1 }],
      });
      const fileId = again.body.files[0].id as string;
      const hanging = get(base, blake, `/api/shares/${again.body.share.id}/files/${fileId}`);
      await waitForReady(base, ada, fileId);
      const revoked = await fetch(`${base}/api/shares/${again.body.share.id}`, {
        method: 'DELETE',
        headers: { Cookie: ada.cookie, 'X-CSRF-Token': ada.csrf },
      });
      assert.equal(revoked.status, 200);
      const stopped = await hanging;
      assert.equal(stopped.status, 502);
      const names = await readdir(handle.config.storageDir);
      assert.deepEqual(names.sort(), ['objects', 'thumbs', 'tmp']);
    } finally {
      server.close();
      handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists the other browser, refuses another site, and does not replace API errors with the website', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-share-peers-'));
    const handle = await createApp(testConfig(dir), { passwordCost: 4 });
    const server = http.createServer(handle.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const listenPort = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${listenPort}`;
    try {
      const ada = await signIn(base, 'Ada');
      const blake = await signIn(base, 'Blake');
      const peers = await get(base, ada, '/api/share-peers');
      assert.equal(peers.status, 200);
      const peerBody = await peers.json() as { self: string; people: Array<{ peerId: string; displayName: string }> };
      assert.equal(peerBody.self, ada.peerId);
      assert.deepEqual(peerBody.people.map((person) => person.displayName), ['Blake']);
      const library = await get(base, ada, '/api/peers');
      const libraryBody = await library.json() as { browsers: Array<{ userId: string; peerId: string }> };
      assert.equal(library.status, 200);
      assert.equal(libraryBody.browsers.length, 1);
      assert.equal(libraryBody.browsers[0].peerId, blake.peerId);
      assert.notEqual(libraryBody.browsers[0].peerId, ada.peerId);

      const foreign = await fetch(`${base}/api/peers/heartbeat`, {
        method: 'POST',
        headers: {
          Cookie: ada.cookie,
          'X-CSRF-Token': ada.csrf,
          'Content-Type': 'application/json',
          Origin: 'http://evil.example',
        },
        body: '{}',
      });
      assert.equal(foreign.status, 403);
      assert.match(foreign.headers.get('content-type') ?? '', /json/);

      const missing = await get(base, ada, '/api/not-a-route');
      const missingText = await missing.text();
      assert.equal(missing.status, 404);
      assert.match(missing.headers.get('content-type') ?? '', /json/);
      assert.equal(missingText.trimStart().startsWith('<'), false);

      const shared = await send(base, ada, '/api/shares', {
        name: 'Note',
        peerIds: [blake.peerId],
        files: [{ clientToken: 'c', relativePath: 'note.txt', size: 5, modifiedAt: 1 }],
      });
      const shareId = shared.body.share.id as string;
      const fileId = shared.body.files[0].id as string;
      const outsider = await signIn(base, 'Cara');
      const refused = await get(base, outsider, `/api/shares/${shareId}/files/${fileId}?check=1`);
      assert.equal(refused.status, 403);
      assert.match(refused.headers.get('content-type') ?? '', /json/);

      const checked = await get(base, blake, `/api/shares/${shareId}/files/${fileId}?check=1`);
      assert.equal(checked.status, 200);
      const checkedBody = await checked.json() as { mode: string };
      assert.equal(checkedBody.mode, 'relay');
      const idle = await fetch(`${base}/api/shares/outbox`, { headers: { Cookie: ada.cookie } });
      const idleBody = await idle.json() as { jobs: unknown[] };
      assert.equal(idleBody.jobs.length, 0);

      const hanging = get(base, blake, `/api/shares/${shareId}/files/${fileId}`);
      const job = await waitForReady(base, ada, fileId);
      const aborted = await fetch(`${base}/api/shares/outbox/${job.id}/abort`, {
        method: 'POST',
        headers: { Cookie: ada.cookie, 'X-CSRF-Token': ada.csrf },
      });
      assert.equal(aborted.status, 200);
      const stopped = await hanging;
      assert.equal(stopped.status, 502);
      const stoppedBody = await stopped.json() as { error: string };
      assert.match(stoppedBody.error, /does not still have this file/);

      const again = await send(base, ada, '/api/shares', {
        name: 'Chunk',
        peerIds: [blake.peerId],
        files: [{ clientToken: 'd', relativePath: 'chunk.txt', size: 5, modifiedAt: 1 }],
      });
      const chunkShare = again.body.share.id as string;
      const chunkFile = again.body.files[0].id as string;
      const download = get(base, blake, `/api/shares/${chunkShare}/files/${chunkFile}`);
      const ready = await waitForReady(base, ada, chunkFile);
      const posted = await postChunked(listenPort, `/api/shares/outbox/${ready.id}/files/${chunkFile}`, ada, Buffer.from('hello'));
      assert.equal(posted.status, 200);
      const received = await download;
      assert.equal(received.status, 200);
      assert.equal(received.headers.get('x-transfer-mode'), 'relay');
      assert.equal(await received.text(), 'hello');
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
  return waitForReady(base, who);
}

async function waitForReady(base: string, who: { cookie: string }, fileId?: string) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    const response = await fetch(`${base}/api/shares/outbox`, { headers: { Cookie: who.cookie } });
    const body = await response.json() as { jobs: Array<{ id: string; nextFileId: string | null; ready?: boolean }> };
    const ready = body.jobs.find((job) => job.ready && (!fileId || job.nextFileId === fileId));
    if (ready) return ready;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The sender never saw the download.');
}

function postChunked(
  port: number,
  pathName: string,
  who: { cookie: string; csrf: string },
  body: Buffer,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method: 'POST',
      headers: {
        Cookie: who.cookie,
        'X-CSRF-Token': who.csrf,
        'Content-Type': 'application/octet-stream',
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postReadyFile(base: string, who: { cookie: string; csrf: string }, fileId: string, text: string) {
  const job = await waitForReady(base, who, fileId);
  const uploaded = await fetch(`${base}/api/shares/outbox/${job.id}/files/${fileId}`, {
    method: 'POST',
    headers: {
      Cookie: who.cookie,
      'X-CSRF-Token': who.csrf,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(Buffer.byteLength(text)),
    },
    body: Buffer.from(text),
  });
  assert.equal(uploaded.status, 200);
}
