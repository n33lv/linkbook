import { describe, expect, it, beforeAll } from 'vitest';
import { applyTestEnv } from '../_fixtures/env';
beforeAll(() => applyTestEnv());

import { computeIdempotencyKey } from '../../src/idempotency';

describe('idempotency key (§2.4)', () => {
  it('is stable across param key ordering', () => {
    const a = computeIdempotencyKey('invoice.remind', 'invoice:42', {
      recipient: 'a@example.com', invoice_id: 'INV-42', tone: 'firm', body: 'long body', subject: 's',
    });
    const b = computeIdempotencyKey('invoice.remind', 'invoice:42', {
      tone: 'firm', body: 'long body', recipient: 'a@example.com', subject: 's', invoice_id: 'INV-42',
    });
    expect(a).toBe(b);
  });

  it('cosmetic edits do NOT change the key', () => {
    const a = computeIdempotencyKey('invoice.remind', 'invoice:42', {
      recipient: 'a@example.com', invoice_id: 'INV-42', tone: 'firm', body: 'V1', subject: 'X',
    });
    const b = computeIdempotencyKey('invoice.remind', 'invoice:42', {
      recipient: 'a@example.com', invoice_id: 'INV-42', tone: 'firm', body: 'V2 — totally rewritten', subject: 'Y',
    });
    expect(a).toBe(b);
  });

  it('semantic edits DO change the key', () => {
    const polite = computeIdempotencyKey('invoice.remind', 'invoice:42', {
      recipient: 'a@example.com', invoice_id: 'INV-42', tone: 'polite', body: '', subject: '',
    });
    const firm = computeIdempotencyKey('invoice.remind', 'invoice:42', {
      recipient: 'a@example.com', invoice_id: 'INV-42', tone: 'firm', body: '', subject: '',
    });
    expect(polite).not.toBe(firm);
  });

  it('different recipient => different key', () => {
    const a = computeIdempotencyKey('invoice.remind', 'invoice:42', {
      recipient: 'a@example.com', invoice_id: 'INV-42', tone: 'firm',
    });
    const b = computeIdempotencyKey('invoice.remind', 'invoice:42', {
      recipient: 'b@example.com', invoice_id: 'INV-42', tone: 'firm',
    });
    expect(a).not.toBe(b);
  });
});
