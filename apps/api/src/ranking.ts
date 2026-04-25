import type { Event } from '@linkbook/types';
import type { AppConfig } from './config.js';

// §1.3 — priority_score in [0, 100]. Deterministic, debuggable, no ML.
// "Why is this on top?" must be reproducible from these terms.
//
// score = w_money * money_at_stake_normalized
//       + w_urgency * recency_decay(due_date)
//       + w_client_tier * client_tier_weight
//       + w_blocking * is_blocking_other_work
//       + w_neglect * days_unread_in_inbox      (§1.3 added clause)
//       - w_snoozed * snooze_decay
//
// All sub-terms normalized to [0, 1] before weighting. Weights summed to
// produce a 0..100 score by multiplying by 100 / sum(weights).

export type RankInputs = {
  // money at stake in cents (0 if not money-shaped). $25k anchors to ~1.0.
  money_at_stake_cents: number;
  // days until / past due. Negative = past due (more urgent).
  days_to_due: number | null;
  // 1 = top tier, 2, 3 = lower. null = unknown.
  client_tier: 1 | 2 | 3 | null;
  is_blocking_other_work: boolean;
  days_unread_in_inbox: number;
  // 0 if not snoozed; >0 while snoozed (used to suppress score during sleep).
  snooze_decay: number;
};

export type RankBreakdown = {
  money: number;
  urgency: number;
  client_tier: number;
  blocking: number;
  neglect: number;
  snoozed: number;
  total: number; // 0..100
};

const MONEY_ANCHOR_CENTS = 25_000_00; // $25k
const URGENCY_HALFLIFE_DAYS = 14;     // every 14 days past due, urgency halves toward 0 from 1

function normalizeMoney(cents: number): number {
  if (cents <= 0) return 0;
  // log-scaled saturation toward 1
  const t = Math.log10(1 + cents / MONEY_ANCHOR_CENTS) / Math.log10(11);
  return Math.min(1, Math.max(0, t));
}

function urgencyFromDays(daysToDue: number | null): number {
  if (daysToDue === null) return 0;
  if (daysToDue >= 0) {
    // future-due: ramp from 0 (60d out) to ~0.5 (1d out)
    return Math.max(0, Math.min(0.5, (60 - daysToDue) / 120));
  }
  // past-due: from ~0.5 at 0d to 1 by ~30d, with mild decay beyond
  const past = -daysToDue;
  const a = Math.min(1, 0.5 + past / 60);
  // long-overdue items asymptote rather than blowing past 1
  return Math.min(1, a);
}

function tierWeight(tier: 1 | 2 | 3 | null): number {
  if (tier === 1) return 1;
  if (tier === 2) return 0.55;
  if (tier === 3) return 0.25;
  return 0; // unknown
}

function neglect(daysUnread: number): number {
  // Saturates near 1 around 21 days; flat thereafter.
  return Math.min(1, daysUnread / 21);
}

export function computePriorityScore(
  inputs: RankInputs,
  cfg: AppConfig,
): RankBreakdown {
  const money = normalizeMoney(inputs.money_at_stake_cents);
  const urgency = urgencyFromDays(inputs.days_to_due);
  const clientTier = tierWeight(inputs.client_tier);
  const blocking = inputs.is_blocking_other_work ? 1 : 0;
  const neglectTerm = neglect(inputs.days_unread_in_inbox);
  const snoozed = Math.max(0, Math.min(1, inputs.snooze_decay));

  const positiveSum =
    cfg.RANK_W_MONEY * money +
    cfg.RANK_W_URGENCY * urgency +
    cfg.RANK_W_CLIENT_TIER * clientTier +
    cfg.RANK_W_BLOCKING * blocking +
    cfg.RANK_W_NEGLECT * neglectTerm;

  const positiveDenom =
    cfg.RANK_W_MONEY +
    cfg.RANK_W_URGENCY +
    cfg.RANK_W_CLIENT_TIER +
    cfg.RANK_W_BLOCKING +
    cfg.RANK_W_NEGLECT;

  const positive = positiveDenom > 0 ? positiveSum / positiveDenom : 0;
  const penalty = cfg.RANK_W_SNOOZED * snoozed; // already in [0, w_snoozed]

  const score = Math.round(Math.max(0, Math.min(1, positive - penalty)) * 100);

  return {
    money: Math.round(money * 100),
    urgency: Math.round(urgency * 100),
    client_tier: Math.round(clientTier * 100),
    blocking: Math.round(blocking * 100),
    neglect: Math.round(neglectTerm * 100),
    snoozed: Math.round(snoozed * 100),
    total: score,
  };
}

// Convenience: pull rank inputs out of a (loaded) Event row plus the
// caller-supplied per-event context (we don't have client_tier on the
// envelope, it has to be joined from the clients table at query time).
//
// Wired up by the Inbox route — kept here so the formula stays in one place.
export function rankInputsFromEvent(
  event: Event,
  ctx: {
    client_tier: 1 | 2 | 3 | null;
    is_blocking_other_work: boolean;
    days_unread_in_inbox: number;
    snooze_decay: number;
  },
): RankInputs {
  let money_at_stake_cents = 0;
  let days_to_due: number | null = null;

  switch (event.type) {
    case 'invoice.overdue':
    case 'invoice.aging_30':
    case 'invoice.aging_60':
    case 'invoice.aging_90':
      money_at_stake_cents = event.payload.amount_cents;
      days_to_due = -event.payload.days_overdue;
      break;
    case 'invoice.draft_ready_to_send':
      money_at_stake_cents = event.payload.amount_cents;
      break;
    case 'payment.received_unapplied':
      money_at_stake_cents = event.payload.amount_cents;
      break;
    case 'bill.due_in_3_days':
      money_at_stake_cents = event.payload.amount_cents;
      days_to_due = Math.ceil(
        (event.payload.due_at.getTime() - Date.now()) / 86_400_000,
      );
      break;
    case 'time.uninvoiced_over_threshold':
      money_at_stake_cents = event.payload.uninvoiced_amount_cents;
      break;
    case 'project.milestone_due_soon':
    case 'project.milestone_overdue':
      days_to_due = Math.ceil(
        (event.payload.due_at.getTime() - Date.now()) / 86_400_000,
      );
      break;
    default:
      // money_at_stake stays 0; urgency falls back to neglect/tier
      break;
  }

  return {
    money_at_stake_cents,
    days_to_due,
    client_tier: ctx.client_tier,
    is_blocking_other_work: ctx.is_blocking_other_work,
    days_unread_in_inbox: ctx.days_unread_in_inbox,
    snooze_decay: ctx.snooze_decay,
  };
}
