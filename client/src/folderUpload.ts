export type PlannedUpload = { file: File; relativePath: string };

type DirectoryReader = {
  readEntries: (success: (entries: FileSystemEntryLike[]) => void, failure?: (error: unknown) => void) => void;
};

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, failure?: (error: unknown) => void) => void;
  createReader?: () => DirectoryReader;
};

export function folderPlacement(relativePath: string): { directories: string[]; fileName: string } | null {
  const parts = relativePath.split(/[/\\]/).map((part) => part.trim()).filter((part) => part && part !== '.' && part !== '..');
  if (parts.length === 0) return null;
  const fileName = parts[parts.length - 1];
  return { directories: parts.slice(0, -1), fileName };
}

export async function readDataTransfer(data: DataTransfer): Promise<PlannedUpload[]> {
  const items = Array.from(data.items);
  const canWalk = items.some((item) => (
    typeof (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }).webkitGetAsEntry === 'function'
  ));
  if (!canWalk) return Array.from(data.files).map((file) => ({ file, relativePath: relativePathOf(file) }));
  try {
    const collected: PlannedUpload[] = [];
    for (const item of items) {
      const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }).webkitGetAsEntry?.() ?? null;
      if (!entry) {
        const file = item.getAsFile();
        if (file) collected.push({ file, relativePath: file.name });
        continue;
      }
      collected.push(...await walkEntry(entry, ''));
    }
    if (collected.length === 0) return Array.from(data.files).map((file) => ({ file, relativePath: relativePathOf(file) }));
    return collected;
  } catch {
    return Array.from(data.files).map((file) => ({ file, relativePath: relativePathOf(file) }));
  }
}

function relativePathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative || file.name;
}

function walkEntry(entry: FileSystemEntryLike, prefix: string): Promise<PlannedUpload[]> {
  if (entry.isFile && entry.file) {
    return new Promise((resolve, reject) => {
      entry.file?.((file) => {
        resolve([{ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name }]);
      }, reject);
    });
  }
  if (entry.isDirectory && entry.createReader) {
    const next = prefix ? `${prefix}/${entry.name}` : entry.name;
    return readAll(entry.createReader()).then(async (children) => {
      const files: PlannedUpload[] = [];
      for (const child of children) files.push(...await walkEntry(child, next));
      return files;
    });
  }
  return Promise.resolve([]);
}

function readAll(reader: DirectoryReader): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntryLike[] = [];
    const pull = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        pull();
      }, reject);
    };
    pull();
  });
}
