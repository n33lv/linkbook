// Local mirror of the API response shapes. We don't import @linkbook/types
// directly to keep the FE bundle tiny — the FE only needs a subset.

export type Source = 'qbo' | 'harvest' | 'dropboxsign' | 'airtable' | 'gmail' | 'linkbook';
export type EventState = 'unread' | 'read' | 'done' | 'snoozed' | 'dismissed' | 'waiting';

export type ActionStatus =
  | 'drafted' | 'approved' | 'queued_30s' | 'executing' | 'succeeded'
  | 'failed' | 'cancelled' | 'undone';

export type ActionRow = {
  id: string;
  type: string;
  params: Record<string, unknown>;
  status: ActionStatus;
  drafted_by: string;
  reversal_class: 'true_undo' | 'compensating' | 'no_undo';
  agent_confidence: string | null;
  agent_rationale: string | null;
  preview: string;
  subject_ref: string;
  originating_event_id: string | null;
  idempotency_key: string;
  queued_until: string | null;
  created_at: string;
};

export type EventRow = {
  id: string;
  source: Source;
  type: string;
  subject_ref: string;
  occurred_at: string;
  ingested_at: string;
  priority_score: number;
  state: EventState;
  payload: Record<string, unknown>;
  thread_id: string | null;
  proposed_actions: ActionRow[];
  client: { name: string; tier: number | null } | null;
};

export type InboxResp = {
  events: EventRow[];
  counts: { all: number; money: number; projects: number; contracts: number; time: number };
};

export type ActionsResp = {
  actions: ActionRow[];
  stats: { open: number; in_flight: number; failed_today: number; done_today: number };
};

export type CashView = {
  ar_aging: { '0_30': number; '31_60': number; '61_90': number; '90_plus': number };
  ar_total_cents: number;
  qtd_revenue_cash_cents: number;
  qtd_revenue_accrual_cents: number;
  top_outstanding: Array<{
    invoice_id: string;
    number: string;
    amount_cents: number;
    days_overdue: number;
    client_name: string | null;
  }>;
  avg_days_to_payment: number;
  last_synced_at: string;
};

export type PipelineView = {
  sent: number;
  signed: number;
  declined: number;
  expected_revenue_cents: number;
  conversion_rate: number;
  open_contracts: EventRow[];
};

export type UtilizationView = {
  billable_pct: number;
  logged_hours: number;
  retainer_cap_pct: number;
  heatmap: Array<{ user_id: string; daily: number[] }>;
  days: string[];
};

export type ProjectsView = {
  projects: Array<{
    id: string;
    name: string;
    client_name: string | null;
    owner: string | null;
    budget_hours: number | null;
    hours_used: number | null;
    days_silent: number;
    budget_pct: number;
    rag: 'red' | 'amber' | 'green';
  }>;
};

export type ClientsView = {
  clients: Array<{
    id: string;
    name: string;
    tier: number | null;
    lifetime_cents: number;
    open_ar_cents: number;
  }>;
};

export type IntegrationsResp = {
  connections: Array<{
    id: string;
    source: Source;
    status: string;
    display_name: string | null;
    last_sync_at: string | null;
  }>;
  mocks: boolean;
};
