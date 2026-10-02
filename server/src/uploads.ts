import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import busboy from 'busboy';
import type { Request } from 'express';
import { mapFsError } from './storage.js';

export type TempWriter = (filePath: string) => WriteStream;

export type ReceiveResult =
  | { status: 'ok'; originalName: string; sizeBytes: number }
  | { status: 'aborted' }
  | { status: 'nofile' }
  | { status: 'badname' }
  | { status: 'toolarge' }
  | { status: 'io'; httpStatus: number; message: string };

export function receiveUpload(options: {
  req: Request;
  tmpPath: string;
  maxFileBytes: number;
  sanitizeName: (raw: string) => string | null;
  openTemp?: TempWriter;
}): Promise<ReceiveResult> {
  const { req, tmpPath, maxFileBytes, sanitizeName } = options;
  const openTemp = options.openTemp ?? defaultTempWriter;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ReceiveResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let requestClosedEarly = false;
    let fileStarted = false;
    let writeStream: WriteStream | undefined;
    let fileStream: Readable | undefined;

    const failIo = (error: unknown) => {
      const mapped = mapFsError(error);
      console.error(`storage write failed (${errorCode(error) || 'unknown'})`);
      finish({ status: 'io', httpStatus: mapped.httpStatus, message: mapped.message });
    };

    const abort = () => {
      requestClosedEarly = true;
      fileStream?.destroy();
      writeStream?.destroy();
      if (!settled) finish({ status: 'aborted' });
    };

    req.on('aborted', abort);

    let parser: ReturnType<typeof busboy>;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: {
          files: 1,
          fileSize: maxFileBytes,
          fields: 5,
          parts: 8,
          fieldSize: 1024,
          headerPairs: 40,
        },
      });
    } catch {
      finish({ status: 'io', httpStatus: 400, message: 'Choose a file to upload.' });
      return;
    }

    parser.on('file', (fieldName, stream, info) => {
      fileStream = stream;
      if (fieldName !== 'file') {
        stream.resume();
        return;
      }
      fileStarted = true;
      const originalName = sanitizeName(info.filename);
      if (!originalName) {
        stream.resume();
        finish({ status: 'badname' });
        return;
      }

      let tooBig = false;
      stream.on('limit', () => {
        tooBig = true;
      });

      try {
        writeStream = openTemp(tmpPath);
      } catch (error) {
        stream.resume();
        failIo(error);
        return;
      }

      pipeline(stream, writeStream)
        .then(() => {
          if (requestClosedEarly) {
            finish({ status: 'aborted' });
            return;
          }
          const truncated = tooBig || Boolean((stream as { truncated?: boolean }).truncated);
          if (truncated) {
            finish({ status: 'toolarge' });
            return;
          }
          finish({
            status: 'ok',
            originalName,
            sizeBytes: writeStream?.bytesWritten ?? 0,
          });
        })
        .catch((error: unknown) => {
          if (requestClosedEarly || errorCode(error) === 'ERR_STREAM_PREMATURE_CLOSE') {
            finish({ status: 'aborted' });
            return;
          }
          failIo(error);
        });
    });

    parser.on('error', () => {
      fileStream?.destroy();
      writeStream?.destroy();
      finish({ status: 'io', httpStatus: 400, message: 'The upload could not be read.' });
    });

    parser.on('close', () => {
      if (!fileStarted) finish({ status: 'nofile' });
    });

    req.on('close', () => {
      if (!settled && !req.complete) abort();
    });

    req.pipe(parser);
  });
}

export async function discardTemp(filePath: string | null): Promise<void> {
  if (!filePath) return;
  await rm(filePath, { force: true });
}

function defaultTempWriter(filePath: string): WriteStream {
  return createWriteStream(filePath, { flags: 'wx', highWaterMark: 64 * 1024 });
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return '';
}
