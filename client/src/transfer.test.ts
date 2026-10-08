import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readAck } from './directChannel.ts';
import { applyServerProgress, type DownloadWatch } from './browserDownload.ts';
import {
  directReadyToFinish,
  displayPercent,
  explainTransferFailure,
  formatRemaining,
  formatSpeed,
  overallBytes,
  rememberSample,
  shouldPaint,
  transferStatusLabel,
  transferView,
} from './transfer.ts';

describe('transfer estimates', () => {
  it('waits for two samples before showing a speed', () => {
    const view = transferView({
      loaded: 100,
      total: 1000,
      now: 1_000,
      samples: [{ at: 1_000, loaded: 100 }],
      active: true,
    });
    assert.equal(view.bytesPerSecond, null);
    assert.equal(view.remainingMs, null);
    assert.equal(view.stalled, false);
    assert.equal(view.progress, 10);
  });

  it('estimates remaining time from the recent window', () => {
    const view = transferView({
      loaded: 500,
      total: 1000,
      now: 2_000,
      samples: [
        { at: 0, loaded: 0 },
        { at: 1_000, loaded: 250 },
        { at: 2_000, loaded: 500 },
      ],
      active: true,
    });
    assert.equal(view.bytesPerSecond, 250);
    assert.equal(view.remainingMs, 2_000);
    assert.equal(formatSpeed(view.bytesPerSecond), '250 B/s');
    assert.equal(formatRemaining(view.remainingMs, false), 'A few seconds left');
  });

  it('says stalled instead of inventing a time when bytes stop arriving', () => {
    const view = transferView({
      loaded: 400,
      total: 1000,
      now: 10_000,
      samples: [
        { at: 0, loaded: 0 },
        { at: 1_000, loaded: 400 },
      ],
      active: true,
    });
    assert.equal(view.stalled, true);
    assert.equal(view.bytesPerSecond, null);
    assert.equal(view.remainingMs, null);
    assert.equal(formatRemaining(null, true), 'Stalled');
  });

  it('does not call a finished idle row stalled', () => {
    const view = transferView({
      loaded: 1000,
      total: 1000,
      now: 20_000,
      samples: [{ at: 0, loaded: 1000 }],
      active: false,
    });
    assert.equal(view.stalled, false);
    assert.equal(view.progress, 100);
  });

  it('drops samples older than the speed window and ignores a backward jump', () => {
    const kept = rememberSample(
      [
        { at: 0, loaded: 10 },
        { at: 1_000, loaded: 20 },
      ],
      { at: 8_000, loaded: 30 },
    );
    assert.deepEqual(kept, [{ at: 8_000, loaded: 30 }]);
    const reset = rememberSample(kept, { at: 8_100, loaded: 5 });
    assert.deepEqual(reset, [{ at: 8_100, loaded: 5 }]);
  });

  it('formats longer estimates in minutes', () => {
    assert.equal(formatRemaining(120_000, false), 'About 2 min left');
  });

  it('measures overall progress by bytes and stays indeterminate when one size is unknown', () => {
    const known = overallBytes([
      { transferredBytes: 0, totalBytes: 10 },
      { transferredBytes: 90, totalBytes: 100 },
    ]);
    assert.equal(known.transferredBytes, 90);
    assert.equal(known.totalBytes, 110);
    assert.equal(known.percent, 82);
    const average = Math.round(((0 / 10) * 100 + (90 / 100) * 100) / 2);
    assert.notEqual(known.percent, average);
    const unknown = overallBytes([
      { transferredBytes: 20, totalBytes: 40 },
      { transferredBytes: 5, totalBytes: null },
    ]);
    assert.equal(unknown.totalBytes, null);
    assert.equal(unknown.percent, null);
  });

  it('does not show a finished upload until completion is allowed', () => {
    assert.equal(displayPercent(100, 100, false), 99);
    assert.equal(displayPercent(100, 100, true), 100);
    assert.equal(displayPercent(10, null, false), null);
    assert.equal(directReadyToFinish(4, 5), false);
    assert.equal(directReadyToFinish(5, 5), true);
    assert.equal(transferStatusLabel('finishing'), 'Finishing up');
    assert.equal(transferStatusLabel('lost'), 'Connection lost');
  });

  it('paints at most about four times a second unless the status changes', () => {
    assert.equal(shouldPaint(1_000, 1_100, false), false);
    assert.equal(shouldPaint(1_000, 1_250, false), true);
    assert.equal(shouldPaint(1_000, 1_100, true), true);
  });

  it('hides unexpected failure text and keeps a direct acknowledgement', () => {
    const hidden = explainTransferFailure(500, 'password=hunter2 csrf=token');
    assert.equal(hidden.message.includes('hunter2'), false);
    assert.equal(hidden.status, 'retry');
    const lost = explainTransferFailure(0, 'Failed to fetch');
    assert.equal(lost.status, 'lost');
    assert.equal(readAck(JSON.stringify({ type: 'ack', received: 32 })), 32);
    assert.equal(readAck('not-json'), null);
  });

  it('keeps sent bytes separate from a saved file for a browser download', () => {
    const current: DownloadWatch = {
      id: '1',
      href: '/api/files/a/download',
      filename: 'notes.txt',
      kind: 'library',
      totalBytes: null,
      sentBytes: 0,
      uploadBytes: 0,
      sourceBytes: 0,
      sourceTotal: null,
      status: 'downloading',
      error: null,
    };
    const next = applyServerProgress(current, {
      kind: 'library',
      totalBytes: 20,
      sentBytes: 20,
      savedBytes: null,
      done: true,
      error: null,
    });
    assert.equal(next.sentBytes, 20);
    assert.equal(next.status, 'completed');
    const zip = applyServerProgress(current, { kind: 'library-zip', totalBytes: null, sentBytes: 8, sourceBytes: 5, sourceTotal: 10, done: false });
    assert.equal(zip.totalBytes, null);
    assert.equal(zip.status, 'downloading');
    const relay = applyServerProgress(current, { kind: 'relay', totalBytes: 20, sentBytes: 0, uploadBytes: 12, done: false });
    assert.equal(relay.status, 'sending');
    assert.equal(relay.uploadBytes, 12);
  });
});
