import { z } from 'zod';

// §5.3 — agents propose actions; humans approve. A proposal IS a drafted
// action (status='drafted', mode='proposed') with the agent's metadata
// attached. We don't have a separate proposals table; this type just
// names the shape the agent runtime returns to the executor.

export const agentNameSchema = z.enum([
  'cash_chaser',
  'project_concierge',
  'time_sentinel',
  'reconciler',
  'triage',
]);
export type AgentName = z.infer<typeof agentNameSchema>;

// One-line rationale shown in the UI (§5.3) plus a confidence in [0, 1].
// The structured `action` is what gets persisted. If the model returns a
// malformed shape twice, the runtime falls back to Manual (§5.3) and emits
// `agent.needs_approval` so a human takes over.
export const proposalSchema = z.object({
  agent: agentNameSchema,
  agent_version: z.string().regex(/^v\d+(\.\d+)*$/),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(500),
  // Action *to be created* — the API persists this as a drafted action.
  // Kept as `unknown` here to avoid a circular dependency with actions.ts;
  // the runtime validates against the actual actionSchema before insert.
  draft_action: z.unknown(),
});
export type Proposal = z.infer<typeof proposalSchema>;

// Reconciler-specific: §5.3 says proposals below 0.85 don't surface — they
// fall back to a manual `payment.received_unapplied` event. Single source
// of truth for that threshold.
export const RECONCILER_CONFIDENCE_THRESHOLD = 0.85;
