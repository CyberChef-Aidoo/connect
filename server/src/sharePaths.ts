const MAX_SEGMENTS = 32;
const MAX_PATH = 240;
const MAX_SEGMENT = 120;

export type ShareDraft = {
  clientToken: string;
  relativePath: string;
  size: number;
  modifiedAt: number;
};

export type PreparedFile = ShareDraft & { id: string };

export function sanitizeSharePath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  if (input.includes('\0')) return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_PATH) return null;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.includes('//')) return null;
  const parts = normalized.split('/');
  if (parts.length === 0 || parts.length > MAX_SEGMENTS) return null;
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return null;
    if (part.length > MAX_SEGMENT) return null;
    if (/[\u0000-\u001f\u007f]/.test(part)) return null;
  }
  return parts.join('/');
}

export function prepareShareFiles(
  inputs: unknown,
  maxFiles: number,
  maxFileBytes: number,
): { files: PreparedFile[]; rejected: Array<{ relativePath: string; reason: string }> } {
  const rejected: Array<{ relativePath: string; reason: string }> = [];
  const files: PreparedFile[] = [];
  const used = new Set<string>();
  const rows = Array.isArray(inputs) ? inputs : [];
  if (rows.length > maxFiles) {
    return { files: [], rejected: [{ relativePath: '', reason: `Choose ${maxFiles} files or fewer.` }] };
  }
  for (const row of rows) {
    const record = row && typeof row === 'object' ? row as Record<string, unknown> : {};
    const rawPath = typeof record.relativePath === 'string' ? record.relativePath : '';
    const relativePath = sanitizeSharePath(rawPath);
    if (!relativePath) {
      rejected.push({ relativePath: rawPath.slice(0, 240), reason: 'That path cannot be shared.' });
      continue;
    }
    const size = record.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) {
      rejected.push({ relativePath, reason: 'That file size cannot be shared.' });
      continue;
    }
    const modified = typeof record.modifiedAt === 'number' && Number.isFinite(record.modifiedAt) ? record.modifiedAt : 0;
    const token = typeof record.clientToken === 'string' ? record.clientToken.slice(0, 80) : '';
    const slash = relativePath.lastIndexOf('/');
    const parent = slash === -1 ? '' : relativePath.slice(0, slash);
    const base = slash === -1 ? relativePath : relativePath.slice(slash + 1);
    const name = uniqueName(used, parent, base);
    const path = parent ? `${parent}/${name}` : name;
    files.push({
      id: crypto.randomUUID(),
      clientToken: token,
      relativePath: path,
      size,
      modifiedAt: modified,
    });
  }
  return { files, rejected };
}

export function sanitizeShareName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  return name;
}

export function sanitizeDisplayName(input: unknown): string {
  if (typeof input !== 'string') return 'This browser';
  const name = input.trim().replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
  if (!name) return 'This browser';
  return name.slice(0, 40);
}

export function childListing(files: PreparedFile[], dir: string): {
  folders: Array<{ name: string; path: string; fileCount: number }>;
  files: PreparedFile[];
} {
  const prefix = dir ? `${dir}/` : '';
  const folders = new Map<string, { name: string; path: string; fileCount: number }>();
  const here: PreparedFile[] = [];
  for (const file of files) {
    if (dir && file.relativePath !== dir && !file.relativePath.startsWith(prefix)) continue;
    const rest = dir ? file.relativePath.slice(prefix.length) : file.relativePath;
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      here.push(file);
      continue;
    }
    const name = rest.slice(0, slash);
    const key = name.toLowerCase();
    const path = dir ? `${dir}/${name}` : name;
    const current = folders.get(key) ?? { name, path, fileCount: 0 };
    current.fileCount += 1;
    folders.set(key, current);
  }
  return {
    folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
    files: here.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

export function filesUnder(files: PreparedFile[], dir: string): PreparedFile[] {
  if (!dir) return files;
  const prefix = `${dir}/`;
  return files.filter((file) => file.relativePath === dir || file.relativePath.startsWith(prefix));
}

function uniqueName(used: Set<string>, parent: string, base: string): string {
  const keyOf = (name: string) => `${parent.toLowerCase()}/${name.toLowerCase()}`;
  if (!used.has(keyOf(base))) {
    used.add(keyOf(base));
    return base;
  }
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let n = 2;
  let name = `${stem} (${n})${ext}`;
  while (used.has(keyOf(name))) {
    n += 1;
    name = `${stem} (${n})${ext}`;
  }
  used.add(keyOf(name));
  return name;
}
