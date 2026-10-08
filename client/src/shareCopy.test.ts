import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from './api.ts';
import { connectionPlain, explainRejected, explainShareError, supportDetails } from './shareCopy.ts';

describe('share wording', () => {
  it('maps a known download problem to a next step and hides unexpected text', () => {
    const known = explainShareError('download', new ApiError(409, 'The person sharing these files is not here. The share stays read-only and is not watched for changes.'));
    assert.match(known, /not here/);
    assert.match(known, /open the files again/);

    const secret = explainShareError('download', new ApiError(500, 'csrf=token password=hunter2'));
    assert.equal(secret.includes('csrf'), false);
    assert.equal(secret.includes('hunter2'), false);
    assert.match(secret, /download did not start/i);
    assert.match(secret, /Help/);
  });

  it('does not treat a successful check as proof that sharing works', () => {
    const text = connectionPlain({ checking: false, reachable: true, signedOut: false });
    assert.match(text.title, /can reach/);
    assert.match(text.detail, /does not|only means/i);
  });

  it('copies support details without file contents or a raw unknown error', () => {
    const text = supportDetails({
      build: '2026-10-08T02:00',
      origin: 'http://192.168.1.20:8443',
      reachable: true,
      signedOut: false,
      registered: true,
      lastCheck: '2:00 AM',
      browsers: ['Ada\ninjected'],
      sharesReady: 1,
      directAvailable: false,
      transfer: 'Not transferring',
      lastProblem: 'The download did not start. Try again.',
      lastStatus: 502,
    });
    assert.match(text, /Shares with files still open: 1/);
    assert.equal(text.includes('\ninjected'), false);
    assert.match(text, /code 502/);
  });

  it('replaces an unknown rejected path with a safe explanation', () => {
    assert.equal(explainRejected('absolute path C:\\secret\\notes.txt'), 'This item was left out. Choose a different file.');
    assert.match(explainRejected('That path cannot be shared.'), /not safe/);
  });
});