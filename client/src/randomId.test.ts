import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomId } from './randomId.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('browser ids on HTTP', () => {
  it('returns a uuid when randomUUID throws', () => {
    const cryptoWithThrow = crypto as Crypto & { randomUUID: () => string };
    const original = cryptoWithThrow.randomUUID;
    cryptoWithThrow.randomUUID = () => {
      throw new Error('secure context required');
    };
    try {
      assert.match(randomId(), UUID);
    } finally {
      cryptoWithThrow.randomUUID = original;
    }
  });
});
