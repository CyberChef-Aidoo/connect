import { open } from 'node:fs/promises';

export const IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const TEXT_EXTENSIONS = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'css']);

export type PreviewKind = 'image' | 'text' | 'none';

export function previewKind(originalName: string, sizeBytes: number): PreviewKind {
  const extension = extensionOf(originalName);
  if (!extension || activeDocument(extension)) return 'none';
  if (IMAGE_TYPES[extension]) {
    return sizeBytes > 0 && sizeBytes <= IMAGE_PREVIEW_MAX_BYTES ? 'image' : 'none';
  }
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return 'none';
}

export function imageContentType(originalName: string): string | null {
  const extension = extensionOf(originalName);
  if (!extension || activeDocument(extension)) return null;
  return IMAGE_TYPES[extension] ?? null;
}

export async function readTextSample(
  filePath: string,
  sizeBytes: number,
  cap = TEXT_PREVIEW_MAX_BYTES,
): Promise<{ text: string; truncated: boolean } | 'binary'> {
  const length = Math.max(0, Math.min(sizeBytes, cap));
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const sample = buffer.subarray(0, offset);
    if (sample.includes(0)) return 'binary';
    return { text: sample.toString('utf8'), truncated: sizeBytes > cap };
  } finally {
    await handle.close();
  }
}

function extensionOf(originalName: string): string {
  const base = originalName.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

function activeDocument(extension: string): boolean {
  return ['html', 'htm', 'xhtml', 'xml', 'svg', 'js', 'mjs', 'cjs', 'mhtml', 'hta'].includes(extension);
}
