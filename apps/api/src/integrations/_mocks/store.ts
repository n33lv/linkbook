// Shared in-memory state for the mock layer. Tests reset it between runs.
// Mocks read from + write to this store; route handlers project from it.

export type MockInvoice = {
  id: string;
  customer_id: string;
  customer_name: string;
  doc_number: string;
  amount_cents: number;
  issued_at: string; // ISO
  due_at: string;
  paid_at: string | null;
  status: 'draft' | 'sent' | 'paid' | 'voided';
  source: 'qbo' | 'harvest';
};

export type MockPayment = {
  id: string;
  customer_name_raw: string;
  amount_cents: number;
  received_at: string;
  applied_to_invoice_id: string | null;
};

export type MockContract = {
  id: string; // signature_request_id
  title: string;
  recipient: string;
  status: 'sent' | 'viewed' | 'signed' | 'declined' | 'expired';
  sent_at: string;
  signed_at: string | null;
};

export type MockTimeEntry = {
  id: string;
  user_id: string;
  project_id: string;
  date: string; // YYYY-MM-DD
  hours: number;
  notes: string | null;
};

export type MockGmailMessage = {
  id: string;
  thread_id: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  sent_at: string;
  label_ids: string[];
};

// Simulate next-write-fails for testing failure paths.
// Tests call: failures.next('qbo:applyPayment', { status: 401 })
export type FailureSpec = { status: number; body?: unknown };

class FailureRegistry {
  private q = new Map<string, FailureSpec[]>();
  next(key: string, spec: FailureSpec): void {
    const list = this.q.get(key) ?? [];
    list.push(spec);
    this.q.set(key, list);
  }
  consume(key: string): FailureSpec | null {
    const list = this.q.get(key);
    if (!list || list.length === 0) return null;
    const next = list.shift()!;
    if (list.length === 0) this.q.delete(key);
    return next;
  }
  reset(): void {
    this.q.clear();
  }
}

export type MockStore = {
  invoices: Map<string, MockInvoice>;
  payments: Map<string, MockPayment>;
  contracts: Map<string, MockContract>;
  time_entries: Map<string, MockTimeEntry>;
  gmail_messages: Map<string, MockGmailMessage>;
  // sent emails the system claims to have delivered
  sent_emails: Array<{ to: string; cc: string[]; subject: string; body: string; thread_id: string | null; at: string }>;
  // contract reminders sent
  contract_reminders: Array<{ signature_request_id: string; at: string }>;
  // airtable records and field-mapped projects
  airtable_records: Map<string, Record<string, unknown>>;
  // harvest projects created
  harvest_projects: Map<string, { id: string; name: string; client_id: string; budget_hours: number }>;
  // drive folders created (no body, just a name)
  drive_folders: Array<{ path: string; created_at: string }>;
  failures: FailureRegistry;
};

const _store: MockStore = {
  invoices: new Map(),
  payments: new Map(),
  contracts: new Map(),
  time_entries: new Map(),
  gmail_messages: new Map(),
  sent_emails: [],
  contract_reminders: [],
  airtable_records: new Map(),
  harvest_projects: new Map(),
  drive_folders: [],
  failures: new FailureRegistry(),
};

export function getMockStore(): MockStore {
  return _store;
}

export function resetMockStore(): void {
  _store.invoices.clear();
  _store.payments.clear();
  _store.contracts.clear();
  _store.time_entries.clear();
  _store.gmail_messages.clear();
  _store.sent_emails.length = 0;
  _store.contract_reminders.length = 0;
  _store.airtable_records.clear();
  _store.harvest_projects.clear();
  _store.drive_folders.length = 0;
  _store.failures.reset();
}
