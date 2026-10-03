import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectionMatchesSession } from './resumeMatch.ts';

describe('resume file selection', () => {
  it('accepts the same name and size', () => {
    assert.equal(
      selectionMatchesSession({ name: 'notes.txt', size: 12 }, { originalName: 'notes.txt', sizeBytes: 12 }),
      null,
    );
  });

  it('rejects a different name or size', () => {
    const session = { originalName: 'notes.txt', sizeBytes: 12 };
    assert.match(selectionMatchesSession({ name: 'other.txt', size: 12 }, session) ?? '', /notes\.txt/);
    assert.match(selectionMatchesSession({ name: 'notes.txt', size: 13 }, session) ?? '', /notes\.txt/);
  });
});
