import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { writeZipFromSources } from '../server/src/zip.ts';

const mb = 32 * 1024 * 1024;
const data = Buffer.alloc(mb, 7);

async function copyAt(chunkSize) {
  const dest = new PassThrough({ highWaterMark: chunkSize });
  let received = 0;
  const reading = (async () => {
    for await (const chunk of dest) received += chunk.length;
  })();
  const started = performance.now();
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const slice = data.subarray(offset, Math.min(data.length, offset + chunkSize));
    if (!dest.write(slice)) await once(dest, 'drain');
  }
  dest.end();
  await reading;
  const seconds = (performance.now() - started) / 1000;
  return {
    chunkSize,
    received,
    megabytesPerSecond: Number((mb / 1e6 / seconds).toFixed(1)),
  };
}

async function zipAt(parts, partBytes) {
  const part = Buffer.alloc(partBytes, 3);
  const dest = new PassThrough({ highWaterMark: 64 * 1024 });
  let received = 0;
  const reading = (async () => {
    for await (const chunk of dest) received += chunk.length;
  })();
  const started = performance.now();
  await writeZipFromSources(dest, Array.from({ length: parts }, (_, index) => ({
    name: `file-${index}.bin`,
    size: part.length,
    open: async function* open() { yield part; },
  })));
  dest.end();
  await reading;
  const seconds = (performance.now() - started) / 1000;
  const source = parts * partBytes;
  return {
    parts,
    sourceMegabytes: Number((source / 1e6).toFixed(1)),
    outputMegabytes: Number((received / 1e6).toFixed(1)),
    megabytesPerSecond: Number((source / 1e6 / seconds).toFixed(1)),
  };
}

async function concurrent(count, chunkSize) {
  const each = 8 * 1024 * 1024;
  const started = performance.now();
  await Promise.all(Array.from({ length: count }, async () => {
    const payload = Buffer.alloc(each, 9);
    const dest = new PassThrough({ highWaterMark: chunkSize });
    const reading = (async () => {
      for await (const chunk of dest) chunk.length;
    })();
    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const slice = payload.subarray(offset, Math.min(payload.length, offset + chunkSize));
      if (!dest.write(slice)) await once(dest, 'drain');
    }
    dest.end();
    await reading;
  }));
  const seconds = (performance.now() - started) / 1000;
  return {
    count,
    chunkSize,
    megabytesPerSecond: Number((count * each / 1e6 / seconds).toFixed(1)),
  };
}

const copies = [];
for (const size of [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
  copies.push(await copyAt(size));
}
const zip = await zipAt(8, 4 * 1024 * 1024);
const sideBySide = [await concurrent(1, 64 * 1024), await concurrent(4, 64 * 1024)];
console.log(JSON.stringify({ copies, zip, sideBySide }, null, 2));
