import type { NextFunction, Request, Response } from 'express';
import type { Express } from 'express';
import { once } from 'node:events';
import { attachmentDisposition } from './storage.js';
import type { ShareHub } from './shares.js';
import { writeZipFromSources } from './zip.js';

type Guard = (req: Request, res: Response, next: NextFunction) => void;

export function registerShareRoutes(
  app: Express,
  hub: ShareHub,
  requireAuth: Guard,
  requireCsrf: Guard,
  peerIdFor: (req: Request) => Promise<string>,
): void {
  app.get('/api/share-peers', requireAuth, async (req, res, next) => {
    try {
      const self = await peerIdFor(req);
      hub.beat(self, req.query.name);
      const people = hub.online()
        .filter((person) => person.peerId !== self)
        .map((person) => ({ peerId: person.peerId, displayName: person.displayName }));
      res.json({ self, people });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/shares/preview', requireAuth, requireCsrf, (req, res) => {
    const prepared = hub.preview(req.body?.files);
    res.json({
      files: prepared.files.map(({ id: _id, ...file }) => file),
      rejected: prepared.rejected,
      fileCount: prepared.files.length,
      emptyDirectoriesOmitted: true,
    });
  });

  app.post('/api/shares', requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const ownerPeerId = await peerIdFor(req);
      const published = hub.publish({
        ownerPeerId,
        name: req.body?.name,
        peerIds: req.body?.peerIds,
        files: req.body?.files,
      });
      if (!published.ok) {
        res.status(published.status).json({ error: published.error });
        return;
      }
      const prepared = hub.preview(req.body?.files);
      res.status(201).json({ share: published.share, files: prepared.files });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/shares/release', requireAuth, requireCsrf, async (req, res, next) => {
    try {
      hub.release(await peerIdFor(req));
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/shares/outbox', requireAuth, async (req, res, next) => {
    try {
      res.json({ jobs: hub.outbox(await peerIdFor(req)) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/shares/outbox/:jobId/files/:fileId', requireAuth, requireCsrf, async (req, res, next) => {
    try {
      const taken = hub.takeBytes(routeParam(req, 'jobId'), routeParam(req, 'fileId'), await peerIdFor(req));
      if ('error' in taken) {
        res.status(409).json({ error: taken.error });
        return;
      }
      const length = Number(req.get('content-length'));
      if (!Number.isSafeInteger(length) || length !== taken.size) {
        taken.stream.destroy();
        res.status(400).json({ error: 'The file size does not match the share.' });
        return;
      }
      let seen = 0;
      for await (const piece of req) {
        const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        seen += chunk.length;
        if (seen > taken.size) break;
        if (!taken.stream.write(chunk)) await once(taken.stream, 'drain');
      }
      if (seen !== taken.size) {
        taken.stream.destroy();
        if (!res.headersSent) res.status(400).json({ error: 'The file ended early.' });
        return;
      }
      taken.stream.end();
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/shares', requireAuth, async (req, res, next) => {
    try {
      res.json({ shares: hub.list(await peerIdFor(req)) });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/shares/:id', requireAuth, requireCsrf, async (req, res, next) => {
    try {
      if (!hub.revoke(routeParam(req, 'id'), await peerIdFor(req))) {
        res.status(404).json({ error: 'That share is not yours.' });
        return;
      }
      res.json({
        ok: true,
        note: 'People who already received a file keep that copy. New downloads are refused.',
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/shares/:id/files/:fileId', requireAuth, async (req, res, next) => {
    try {
      const started = hub.beginFile(routeParam(req, 'id'), routeParam(req, 'fileId'), await peerIdFor(req));
      if ('error' in started) {
        sendShareError(res, started.error);
        return;
      }
      const downloadName = started.file.relativePath.split('/').pop() ?? 'download';
      await pumpDownload(req, res, started.file.size, downloadName, () => hub.waitForFile(started.job, started.file.id), () => {
        hub.cancelDownload(started.job.id);
      });
      hub.finish(started.job.id);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/shares/:id/archive', requireAuth, async (req, res, next) => {
    try {
      const ids = typeof req.query.ids === 'string' && req.query.ids ? req.query.ids.split(',') : [];
      const started = hub.beginZip(routeParam(req, 'id'), req.query.dir, ids, await peerIdFor(req));
      if ('error' in started) {
        sendShareError(res, started.error);
        return;
      }
      const folder = typeof req.query.dir === 'string' ? req.query.dir : '';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', attachmentDisposition('shared-folder.zip'));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Transfer-Mode', 'relay');
      req.on('close', () => {
        if (!res.writableEnded) hub.cancelDownload(started.job.id);
      });
      try {
        await writeZipFromSources(res, started.files.map((file) => ({
          name: zipEntryName(file.relativePath, folder),
          size: file.size,
          open: async function* open() {
            const stream = await hub.waitForFile(started.job, file.id);
            for await (const chunk of stream) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          },
        })));
        res.end();
      } catch (error) {
        hub.cancelDownload(started.job.id);
        if (!res.headersSent) next(error);
        else res.destroy();
      } finally {
        hub.finish(started.job.id);
      }
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/shares/:id', requireAuth, async (req, res, next) => {
    try {
      const listing = hub.browse(routeParam(req, 'id'), await peerIdFor(req), req.query.dir, req.query.q);
      if (!listing) {
        res.status(404).json({ error: 'That share is not available to you.' });
        return;
      }
      if ('error' in listing) {
        res.status(400).json({ error: listing.error });
        return;
      }
      res.json(listing);
    } catch (error) {
      next(error);
    }
  });
}

async function pumpDownload(
  req: Request,
  res: Response,
  size: number,
  downloadName: string,
  open: () => Promise<AsyncIterable<Buffer | Uint8Array>>,
  stop: () => void,
): Promise<void> {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', attachmentDisposition(downloadName));
  res.setHeader('Content-Length', String(size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Transfer-Mode', 'relay');
  req.on('close', () => {
    if (!res.writableEnded) stop();
  });
  try {
    const stream = await open();
    let seen = 0;
    for await (const piece of stream) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      seen += chunk.length;
      if (!res.write(chunk)) await once(res, 'drain');
    }
    if (seen !== size) throw new Error('The shared file ended early.');
    res.end();
  } catch {
    stop();
    if (!res.headersSent) res.status(502).json({ error: 'The sender did not finish this file.' });
    else res.destroy();
  }
}

function sendShareError(res: Response, error: string): void {
  if (error === 'forbidden') {
    res.status(403).json({ error: 'You cannot download this share.' });
    return;
  }
  if (error === 'offline') {
    res.status(409).json({ error: 'The person sharing these files is not here. The share stays read-only and is not watched for changes.' });
    return;
  }
  if (error === 'busy') {
    res.status(429).json({ error: 'Too many downloads are already running.' });
    return;
  }
  if (error === 'path') {
    res.status(400).json({ error: 'That folder path cannot be downloaded.' });
    return;
  }
  res.status(404).json({ error: 'That file is not in the share.' });
}

function zipEntryName(relativePath: string, dir: string): string {
  if (!dir) return relativePath;
  const prefix = `${dir}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : relativePath;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}
