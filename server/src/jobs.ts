import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { previewKind } from './preview.js';
import { objectPath, thumbPath } from './storage.js';

const MAX_PENDING = 8;
const THUMB_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

type Task = () => Promise<void>;

export function createJobRunner(): { enqueue: (task: Task) => boolean; whenIdle: () => Promise<void> } {
  const queue: Task[] = [];
  let active = 0;
  let idleWaiters: Array<() => void> = [];

  function pump(): void {
    while (active < 1 && queue.length > 0) {
      const task = queue.shift();
      if (!task) return;
      active += 1;
      void Promise.resolve()
        .then(task)
        .catch(() => undefined)
        .finally(() => {
          active -= 1;
          pump();
          if (active === 0 && queue.length === 0) {
            const waiters = idleWaiters;
            idleWaiters = [];
            for (const resolve of waiters) resolve();
          }
        });
    }
  }

  return {
    enqueue(task: Task): boolean {
      if (active + queue.length >= MAX_PENDING) return false;
      queue.push(task);
      pump();
      return true;
    },
    whenIdle(): Promise<void> {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
}

const runner = createJobRunner();
let ffmpegLookup: Promise<boolean> | null = null;

export function enqueueJob(task: Task): boolean {
  return runner.enqueue(task);
}

export function whenJobsIdle(): Promise<void> {
  return runner.whenIdle();
}

export function scheduleThumbnail(
  storageDir: string,
  file: { id: string; originalName: string; sizeBytes: number },
): void {
  if (previewKind(file.originalName, file.sizeBytes) !== 'image') return;
  const source = objectPath(storageDir, file.id);
  const target = thumbPath(storageDir, file.id);
  if (!source || !target) return;
  enqueueJob(() => writeThumbnail(source, target));
}

async function writeThumbnail(source: string, target: string): Promise<void> {
  if (!(await ffmpegAvailable())) return;
  await mkdir(path.dirname(target), { recursive: true });
  const wrote = await runFfmpeg(source, target);
  if (!wrote) {
    await rm(target, { force: true });
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size <= 0 || info.size > THUMB_OUTPUT_MAX_BYTES) {
      await rm(target, { force: true });
    }
  } catch {
    await rm(target, { force: true });
  }
}

function ffmpegAvailable(): Promise<boolean> {
  if (!ffmpegLookup) ffmpegLookup = detectFfmpeg();
  return ffmpegLookup;
}

function detectFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2000);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

function runFfmpeg(source: string, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-vf',
      'scale=320:-1',
      '-frames:v',
      '1',
      target,
    ], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 15_000);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}
