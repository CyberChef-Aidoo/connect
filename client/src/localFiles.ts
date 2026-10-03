const held = new Map<string, File>();

export function rememberLocalFile(id: string, file: File): void {
  held.set(id, file);
}

export function localFile(id: string): File | undefined {
  return held.get(id);
}
