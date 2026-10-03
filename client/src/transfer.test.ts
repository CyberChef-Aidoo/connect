import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatRemaining, formatSpeed, rememberSample, transferView } from './transfer.ts';

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
});
