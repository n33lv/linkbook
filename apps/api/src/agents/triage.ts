import type { Event } from '@linkbook/types';
import type { AppLogger } from '../lib/principal-context.js';
import type { AppConfig } from '../config.js';

// §5.3 — Triage: every new event. Computes priority score (deterministic,
// see ranking.ts) and recommends actions from the §2.2 catalog. Triage's
// outputs *populate* the Inbox row — they don't write to a source system,
// so no HITL gate.
//
// Lives as a sibling to other agents but doesn't go through Agentspan in
// v1 — the priority formula is deterministic, not LLM-shaped, and the
// "recommended action" mapping is hard-coded per event type. We can move
// this behind Agentspan later if we want LLM-shaped recommendations.

import type { ActionType, EventType } from '@linkbook/types';

const RECOMMENDED_ACTIONS: Record<EventType, readonly ActionType[]> = {
  // Money in
  'invoice.overdue': ['invoice.remind', 'event.snooze'],
  'invoice.aging_30': ['invoice.remind'],
  'invoice.aging_60': ['invoice.remind'],
  'invoice.aging_90': ['invoice.remind'],
  'invoice.paid': [], // informational; no action proposed
  'invoice.draft_ready_to_send': ['invoice.send'],
  'payment.received_unapplied': ['payment.apply'],
  // Money out
  'bill.due_in_3_days': [],
  'expense.uncategorized': [],
  // Time
  'time.missing_yesterday': ['time.self_nudge'],
  'time.budget_threshold_80': ['email.send_draft', 'project.update_status'],
  'time.budget_threshold_100': ['email.send_draft', 'project.update_status'],
  'time.budget_threshold_120': ['email.send_draft', 'project.update_status'],
  'time.uninvoiced_over_threshold': [],
  // Contracts
  'contract.sent_unsigned_5d': ['contract.send_reminder'],
  'contract.signed': ['project.kickoff'],
  'contract.declined': [],
  // Project
  'project.status_stale': ['project.update_status'],
  'project.milestone_due_soon': [],
  'project.milestone_overdue': [],
  // Client comms
  'email.client_reply_awaiting_response_3d': ['email.send_draft'],
  // System
  'integration.disconnected': [],
  'integration.harvest_qbo_sync_lag': [],
  'action.failed': [],
  'agent.needs_approval': [],
};

export function recommendedActionsFor(type: EventType): readonly ActionType[] {
  return RECOMMENDED_ACTIONS[type] ?? [];
}

// Currently a no-op call site; kept so other modules can import a single
// "this just got ingested" hook. We'll grow this when Agentspan-shaped
// triage lands.
export async function runTriage(
  _event: Event,
  _cfg: AppConfig,
  _log: AppLogger,
): Promise<void> {
  // priority_score is computed in ranking.ts at the moment of insert.
  // suggested_actions[] is filled by recommendedActionsFor() at the
  // same call site. There is nothing for runTriage to do today — it
  // exists as the named hook for the future LLM version.
}
