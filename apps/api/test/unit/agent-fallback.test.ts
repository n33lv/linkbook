import { describe, expect, it, beforeAll } from 'vitest';
import { applyTestEnv } from '../_fixtures/env';
beforeAll(() => applyTestEnv());

import { proposeWithFallback, type AgentspanClient } from '../../src/agents/runtime';
import type { Event } from '@linkbook/types';

const baseEvent: Event = {
  event_id: '00000000-0000-0000-0000-000000000001',
  source: 'qbo',
  type: 'invoice.aging_60',
  subject_ref: 'invoice:1',
  occurred_at: new Date(),
  ingested_at: new Date(),
  priority_score: 50,
  state: 'unread',
  suggested_actions: [],
  dedupe_key: 'd',
  thread_id: null,
  payload: {
    invoice_id: 'INV-1',
    client_id: '00000000-0000-0000-0000-000000000010',
    amount_cents: 100000,
    currency: 'USD',
    issued_at: new Date(),
    due_at: new Date(),
    days_overdue: 60,
  },
} as Event;

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('proposeWithFallback (§5.3)', () => {
  it('returns ok on first valid response', async () => {
    const client: AgentspanClient = {
      async propose() {
        return {
          agent: 'cash_chaser',
          agent_version: 'v1.0',
          confidence: 0.85,
          rationale: 'good',
          draft_action: null,
        };
      },
    };
    const r = await proposeWithFallback(client, { agent: 'cash_chaser', agent_version: 'v1.0', event: baseEvent, context: {} }, silent);
    expect(r.ok).toBe(true);
  });

  it('falls back to manual after two malformed', async () => {
    const client: AgentspanClient = {
      async propose() {
        return { totally: 'wrong' };
      },
    };
    const r = await proposeWithFallback(client, { agent: 'cash_chaser', agent_version: 'v1.0', event: baseEvent, context: {} }, silent);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('fallback_to_manual');
      expect(r.attempts).toBe(2);
    }
  });

  it('falls back after two thrown errors', async () => {
    const client: AgentspanClient = {
      async propose() {
        throw new Error('agent down');
      },
    };
    const r = await proposeWithFallback(client, { agent: 'cash_chaser', agent_version: 'v1.0', event: baseEvent, context: {} }, silent);
    expect(r.ok).toBe(false);
  });

  it('recovers if first attempt malformed and second is valid', async () => {
    let calls = 0;
    const client: AgentspanClient = {
      async propose() {
        calls++;
        if (calls === 1) return { bad: true };
        return {
          agent: 'cash_chaser',
          agent_version: 'v1.0',
          confidence: 0.7,
          rationale: 'recovered',
          draft_action: null,
        };
      },
    };
    const r = await proposeWithFallback(client, { agent: 'cash_chaser', agent_version: 'v1.0', event: baseEvent, context: {} }, silent);
    expect(r.ok).toBe(true);
  });
});
