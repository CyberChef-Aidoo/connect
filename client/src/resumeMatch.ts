export function selectionMatchesSession(
  file: { name: string; size: number },
  session: { originalName: string; sizeBytes: number },
): string | null {
  if (file.name !== session.originalName || file.size !== session.sizeBytes) {
    return `Choose ${session.originalName} again. A different file cannot continue this upload.`;
  }
  return null;
}
