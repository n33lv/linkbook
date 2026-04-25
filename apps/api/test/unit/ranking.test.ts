import { describe, expect, it, beforeAll } from 'vitest';
import { applyTestEnv } from '../_fixtures/env';

beforeAll(() => applyTestEnv());

import { computePriorityScore, type RankInputs } from '../../src/ranking';
import { loadConfig } from '../../src/config';

const cfg = loadConfig();

const baseline: RankInputs = {
  money_at_stake_cents: 0,
  days_to_due: null,
  client_tier: null,
  is_blocking_other_work: false,
  days_unread_in_inbox: 0,
  snooze_decay: 0,
};

describe('priority score (§1.3)', () => {
  it('zeros out for empty input', () => {
    expect(computePriorityScore(baseline, cfg).total).toBe(0);
  });

  it('scales monotonically with money', () => {
    const a = computePriorityScore({ ...baseline, money_at_stake_cents: 1_000_00 }, cfg).total;
    const b = computePriorityScore({ ...baseline, money_at_stake_cents: 50_000_00 }, cfg).total;
    expect(b).toBeGreaterThan(a);
  });

  it('past-due boosts urgency more than future-due', () => {
    const past = computePriorityScore({ ...baseline, days_to_due: -30 }, cfg).total;
    const future = computePriorityScore({ ...baseline, days_to_due: 30 }, cfg).total;
    expect(past).toBeGreaterThan(future);
  });

  it('tier 1 outweighs tier 3', () => {
    const t1 = computePriorityScore({ ...baseline, client_tier: 1 }, cfg).total;
    const t3 = computePriorityScore({ ...baseline, client_tier: 3 }, cfg).total;
    expect(t1).toBeGreaterThan(t3);
  });

  it('w_neglect: unread items don\'t decay against the user', () => {
    const fresh = computePriorityScore({ ...baseline, money_at_stake_cents: 5_000_00, days_unread_in_inbox: 0 }, cfg).total;
    const old = computePriorityScore({ ...baseline, money_at_stake_cents: 5_000_00, days_unread_in_inbox: 21 }, cfg).total;
    expect(old).toBeGreaterThan(fresh);
  });

  it('snooze suppresses score', () => {
    const awake = computePriorityScore({ ...baseline, money_at_stake_cents: 25_000_00, days_to_due: -60, client_tier: 1, snooze_decay: 0 }, cfg).total;
    const asleep = computePriorityScore({ ...baseline, money_at_stake_cents: 25_000_00, days_to_due: -60, client_tier: 1, snooze_decay: 1 }, cfg).total;
    expect(asleep).toBeLessThan(awake);
  });

  it('result clamped to [0, 100]', () => {
    const r = computePriorityScore(
      { money_at_stake_cents: 999_999_99, days_to_due: -200, client_tier: 1, is_blocking_other_work: true, days_unread_in_inbox: 365, snooze_decay: 0 },
      cfg,
    );
    expect(r.total).toBeGreaterThanOrEqual(0);
    expect(r.total).toBeLessThanOrEqual(100);
  });
});
