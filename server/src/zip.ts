import { createReadStream } from 'node:fs';
import type { Writable } from 'node:stream';
import { sanitizeOriginalName } from './storage.js';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

export type ZipEntry = { name: string; filePath: string; size: number };

export function uniqueZipName(used: Set<string>, raw: string): string {
  const base = sanitizeOriginalName(raw) ?? 'file';
  const key = base.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return base;
  }
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let n = 2;
  let name = `${stem} (${n})${ext}`;
  while (used.has(name.toLowerCase())) {
    n += 1;
    name = `${stem} (${n})${ext}`;
  }
  used.add(name.toLowerCase());
  return name;
}

export type ZipSource = {
  name: string;
  size: number;
  open: () => AsyncIterable<Buffer | Uint8Array>;
};

export async function writeStoredZip(output: Writable, files: ZipEntry[]): Promise<void> {
  await writeZipFromSources(output, files.map((file) => ({
    name: file.name,
    size: file.size,
    open: () => createReadStream(file.filePath),
  })));
}

export async function writeZipFromSources(output: Writable, files: ZipSource[]): Promise<void> {
  const now = dosDateTime(new Date());
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt16LE(name.length, 26);
    await writeChunk(output, local);
    await writeChunk(output, name);
    const localOffset = offset;
    offset += local.length + name.length;

    let crc = 0xffffffff;
    let seen = 0;
    for await (const piece of file.open()) {
      let chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      if (seen + chunk.length > file.size) chunk = chunk.subarray(0, file.size - seen);
      if (chunk.length === 0) break;
      crc = updateCrc(crc, chunk);
      seen += chunk.length;
      await writeChunk(output, chunk);
      if (seen === file.size) break;
    }
    if (seen !== file.size) {
      throw Object.assign(new Error('The shared file changed while it was being packed.'), { code: 'EBUSY' });
    }
    const finished = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(finished, 4);
    descriptor.writeUInt32LE(seen, 8);
    descriptor.writeUInt32LE(seen, 12);
    await writeChunk(output, descriptor);
    offset += seen + descriptor.length;

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0808, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(now.time, 12);
    header.writeUInt16LE(now.date, 14);
    header.writeUInt32LE(finished, 16);
    header.writeUInt32LE(seen, 20);
    header.writeUInt32LE(seen, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(localOffset, 42);
    central.push(header, name);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const part of central) {
    await writeChunk(output, part);
    centralSize += part.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  await writeChunk(output, end);
}

function updateCrc(crc: number, chunk: Buffer): number {
  let next = crc;
  for (let i = 0; i < chunk.length; i += 1) {
    next = CRC_TABLE[(next ^ chunk[i]) & 0xff] ^ (next >>> 8);
  }
  return next >>> 0;
}

function writeChunk(output: Writable, chunk: Buffer): Promise<void> {
  if (output.destroyed) return Promise.reject(Object.assign(new Error('The download was closed.'), { code: 'ECONNRESET' }));
  if (output.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    output.once('drain', resolve);
    output.once('error', reject);
  });
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}
