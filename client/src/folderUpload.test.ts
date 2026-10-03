import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { folderPlacement } from './folderUpload.ts';

describe('folder upload paths', () => {
  it('keeps the chosen folder and the file name', () => {
    assert.deepEqual(folderPlacement('Vacation/Day 1/a.jpg'), {
      directories: ['Vacation', 'Day 1'],
      fileName: 'a.jpg',
    });
  });

  it('drops parent-directory segments instead of climbing out', () => {
    assert.deepEqual(folderPlacement('..\\..\\outside\\notes.txt'), {
      directories: ['outside'],
      fileName: 'notes.txt',
    });
    assert.deepEqual(folderPlacement('a/../b/file.txt'), {
      directories: ['a', 'b'],
      fileName: 'file.txt',
    });
  });

  it('rejects a path that has no file name', () => {
    assert.equal(folderPlacement('..'), null);
    assert.equal(folderPlacement('.'), null);
  });
});
