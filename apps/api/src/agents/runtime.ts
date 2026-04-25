import {
  proposalSchema,
  type AgentName,
  type Event,
  type Proposal,
} from '@linkbook/types';
import type { AppConfig } from '../config.js';
import type { AppLogger } from '../lib/principal-context.js';

// §5.3 — Agentspan runtime wrapper.

export type ProposeRequest = {
  agent: AgentName;
  agent_version: string;
  event: Event;
  context: Record<string, unknown>;
};

export type ProposeResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: 'fallback_to_manual'; attempts: number };

export type AgentspanClient = {
  propose(req: ProposeRequest): Promise<unknown>;
};

class StubClient implements AgentspanClient {
  async propose(req: ProposeRequest): Promise<unknown> {
    const { agent, event } = req;
    if (agent === 'cash_chaser' && event.type.startsWith('invoice.')) {
      const days = (event.payload as { days_overdue?: number }).days_overdue ?? 0;
      return {
        agent,
        agent_version: 'v1.0',
        // confidence rises with days overdue, plateaus at .92
        confidence: Math.min(0.92, 0.6 + days / 200),
        rationale:
          days >= 60
            ? 'Stellate-style 62-day pattern: firm reminder usually resolves within 5 days. cc principal.'
            : 'Standard polite reminder; client typically pays after first reminder.',
        draft_action: null,
      };
    }
    if (agent === 'project_concierge' && event.type === 'contract.signed') {
      return {
        agent,
        agent_version: 'v1.0',
        confidence: 0.96,
        rationale:
          'Counterparty matched to existing client; Drive template applies; 4-leg kickoff is the standard pattern.',
        draft_action: null,
      };
    }
    if (agent === 'reconciler' && event.type === 'payment.received_unapplied') {
      const cands = (event.payload as { candidate_invoice_ids?: string[] }).candidate_invoice_ids ?? [];
      // Single candidate → high confidence; multiple → low (test threshold path).
      const conf = cands.length === 1 ? 0.91 : cands.length === 0 ? 0.4 : 0.71;
      return {
        agent,
        agent_version: 'v1.0',
        confidence: conf,
        rationale:
          cands.length === 1
            ? 'Single open invoice for this customer matches the wire amount exactly.'
            : 'Multiple open invoices and amount does not match exactly — leaving for manual review.',
        draft_action: null,
      };
    }
    if (agent === 'time_sentinel' && event.type === 'time.missing_yesterday') {
      return {
        agent,
        agent_version: 'v1.0',
        confidence: 0.9,
        rationale: 'Workday with under 4h logged. Self-nudge is the standard response.',
        draft_action: null,
      };
    }
    if (agent === 'triage') {
      return {
        agent,
        agent_version: 'v1.0',
        confidence: 1,
        rationale: 'Deterministic triage.',
        draft_action: null,
      };
    }
    // No canned response for this agent/event combo — caller-side gates should prevent this,
    // but if it slips through return malformed twice → fallback path exercised.
    return null;
  }
}

let _client: AgentspanClient | null = null;

export function getAgentspanClient(cfg: AppConfig): AgentspanClient {
  if (_client) return _client;
  if (!cfg.AGENTSPAN_BASE_URL || !cfg.AGENTSPAN_API_KEY) {
    _client = new StubClient();
  } else {
    // TODO(agentspan): real HTTP client.
    _client = new StubClient();
  }
  return _client;
}

// Test seam.
export function setAgentspanClient(c: AgentspanClient | null): void {
  _client = c;
}

/**
 * §5.3 — invoke an agent with retry-on-malformed-output. Two failed parses
 * → fall back to Manual; the caller emits an `agent.needs_approval` event.
 */
export async function proposeWithFallback(
  client: AgentspanClient,
  req: ProposeRequest,
  log: AppLogger,
): Promise<ProposeResult> {
  let attempts = 0;
  let lastErr: unknown = null;

  while (attempts < 2) {
    attempts++;
    try {
      const raw = await client.propose(req);
      const parsed = proposalSchema.safeParse(raw);
      if (parsed.success) {
        return { ok: true, proposal: parsed.data };
      }
      log.warn(
        { agent: req.agent, attempt: attempts, issues: parsed.error.issues },
        'agent returned malformed output',
      );
      lastErr = parsed.error;
    } catch (err) {
      log.warn({ agent: req.agent, attempt: attempts, err }, 'agent invocation threw');
      lastErr = err;
    }
  }

  log.error(
    { agent: req.agent, attempts, err: lastErr },
    'agent fell back to Manual after 2 malformed attempts',
  );
  return { ok: false, reason: 'fallback_to_manual', attempts };
}
