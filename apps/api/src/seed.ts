// Idempotent seed for the dev SQLite DB. Creates:
//   * 5 integration_connections (one per source)
//   * 14 clients spread across 3 tiers
//   * 9 projects, 22 invoices spanning aging buckets, contracts, time entries
//   * The 7 inbox events from the UI sketch (with proposed actions)
//
// Run: pnpm --filter @linkbook/api seed
//
// Designed so re-running is safe: every insert checks for existence first.

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { createDb, schema } from '@linkbook/db';
import { loadConfig } from './config.js';
import { ingestEvent } from './ingestion.js';
import { installMockTransport, getMockStore, resetMockStore } from './integrations/_mocks/index.js';
import type { AppCtx } from './lib/principal-context.js';

const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);

const log = {
  info: (o: unknown, m?: string) => console.log('info', m ?? '', JSON.stringify(o)),
  warn: (o: unknown, m?: string) => console.warn('warn', m ?? '', JSON.stringify(o)),
  error: (o: unknown, m?: string) => console.error('error', m ?? '', JSON.stringify(o)),
  debug: () => {},
};

const ctx: AppCtx = { db, cfg, log };

installMockTransport();
resetMockStore();

// ----- 1. Integration connections (one per source). -----
const sources = ['qbo', 'harvest', 'dropboxsign', 'airtable', 'gmail'] as const;
for (const src of sources) {
  const existing = db
    .select()
    .from(schema.integration_connections)
    .where(eq(schema.integration_connections.source, src))
    .all();
  if (existing.length > 0) continue;
  db.insert(schema.integration_connections)
    .values({
      source: src,
      external_account_id: src === 'qbo' ? 'realm_dev' : `${src}_acct`,
      display_name: src.toUpperCase(),
      status: 'connected',
      access_token: 'dev_token',
      metadata:
        src === 'airtable'
          ? { base_id: 'app_demo', projects_table_id: 'tbl_projects' }
          : {},
    })
    .run();
}

// ----- 2. Clients. -----
const CLIENTS: Array<{ name: string; tier: 1 | 2 | 3 }> = [
  { name: 'Stellate Studios', tier: 1 },
  { name: 'Halford & Co.', tier: 1 },
  { name: 'Petal & Vine', tier: 1 },
  { name: 'Ridgemoor Group', tier: 1 },
  { name: 'Cypress Labs', tier: 2 },
  { name: 'Brightside Goods', tier: 2 },
  { name: 'Northbeam Inc.', tier: 2 },
  { name: 'Meadowlark Co.', tier: 2 },
  { name: 'Linkwell', tier: 2 },
  { name: 'Cypress Bay', tier: 2 },
  { name: 'Hill & Houseman', tier: 3 },
  { name: 'Foxglove Press', tier: 3 },
  { name: 'Marlowe Editorial', tier: 3 },
  { name: 'Kestrel & Co.', tier: 3 },
];
const clientByName: Record<string, string> = {};
for (const c of CLIENTS) {
  const existing = db.select().from(schema.clients).where(eq(schema.clients.name, c.name)).all();
  if (existing[0]) {
    clientByName[c.name] = existing[0].id;
    continue;
  }
  const inserted = db
    .insert(schema.clients)
    .values({
      name: c.name,
      tier: c.tier,
      source_ids: { qbo: `qbo_${c.name.replace(/\W+/g, '_').toLowerCase()}`, harvest: `h_${c.name.replace(/\W+/g, '_').toLowerCase()}` },
      email_domains: [`${c.name.split(' ')[0]?.toLowerCase()}.com`],
    })
    .returning()
    .get();
  clientByName[c.name] = inserted.id;
}

// Mirror clients into the QBO mock store as customers, so CDC payment flows
// have a customer-name match path.
const store = getMockStore();

// ----- 3. Projects (read-through join shape). -----
const PROJECTS = [
  { client: 'Petal & Vine', name: 'Spring Campaign', budget: 132, used: 132, days_silent: 9 },
  { client: 'Halford & Co.', name: 'Annual Report 2026', budget: 120, used: 98, days_silent: 17 },
  { client: 'Ridgemoor Group', name: 'Site Redesign', budget: 240, used: 186, days_silent: 3 },
  { client: 'Cypress Labs', name: 'Brand Refresh', budget: 120, used: 62, days_silent: 5 },
  { client: 'Brightside Goods', name: 'Packaging', budget: 60, used: 44, days_silent: 0 },
  { client: 'Northbeam Inc.', name: 'Brand System', budget: 240, used: 0, days_silent: 0 },
  { client: 'Stellate Studios', name: 'Q2 Editorial', budget: 200, used: 88, days_silent: 2 },
  { client: 'Meadowlark Co.', name: 'Wayfinding', budget: 80, used: 12, days_silent: 0 },
  { client: 'Linkwell', name: 'Web Type System', budget: 200, used: 156, days_silent: 4 },
];
const projectByName: Record<string, string> = {};
for (const p of PROJECTS) {
  const existing = db.select().from(schema.projects).where(eq(schema.projects.name, p.name)).all();
  if (existing[0]) {
    projectByName[p.name] = existing[0].id;
    continue;
  }
  const inserted = db
    .insert(schema.projects)
    .values({
      client_id: clientByName[p.client]!,
      name: p.name,
      harvest_project_id: `harvest_${p.name.replace(/\W+/g, '_').toLowerCase()}`,
      airtable_record_id: `rec_${p.name.replace(/\W+/g, '_').toLowerCase()}`,
      status: p.used / Math.max(p.budget, 1) >= 1 ? 'over' : 'active',
      owner: 'Asha',
      budget_hours: p.budget,
      hours_used: p.used,
      last_status_update_at: new Date(Date.now() - p.days_silent * 86_400_000),
    })
    .returning()
    .get();
  projectByName[p.name] = inserted.id;
}

// ----- 4. Invoices. -----
const today = Date.now();
const INVOICES = [
  // overdue / aging — drive Cash dashboard buckets
  { client: 'Stellate Studios', number: 'INV-1041', amount: 18_400, days_overdue: 62, paid: false },
  { client: 'Halford & Co.', number: 'INV-1029', amount: 14_800, days_overdue: 41, paid: false },
  { client: 'Petal & Vine', number: 'INV-1044', amount: 11_250, days_overdue: 22, paid: false },
  { client: 'Ridgemoor Group', number: 'INV-1048', amount: 9_800, days_overdue: 15, paid: false },
  { client: 'Brightside Goods', number: 'INV-1050', amount: 8_250, days_overdue: 12, paid: false },
  { client: 'Cypress Labs', number: 'INV-1052', amount: 6_400, days_overdue: 4, paid: false },
  { client: 'Stellate Studios', number: 'INV-1015', amount: 14_400, days_overdue: 105, paid: false }, // 90+
  { client: 'Halford & Co.', number: 'INV-1018', amount: 8_200, days_overdue: 95, paid: false }, // 90+
  // recently paid (drive QTD revenue + avg days-to-pay)
  { client: 'Stellate Studios', number: 'INV-1051', amount: 12_000, days_overdue: -10, paid: true },
  { client: 'Petal & Vine', number: 'INV-1049', amount: 9_400, days_overdue: -20, paid: true },
  { client: 'Linkwell', number: 'INV-1042', amount: 8_600, days_overdue: -45, paid: true },
  { client: 'Cypress Labs', number: 'INV-1043', amount: 12_300, days_overdue: -38, paid: true },
];
for (const inv of INVOICES) {
  const number = inv.number;
  const existing = db.select().from(schema.invoices).where(eq(schema.invoices.number, number)).all();
  if (existing[0]) continue;
  const due_at = new Date(today - inv.days_overdue * 86_400_000);
  const issued_at = new Date(due_at.getTime() - 30 * 86_400_000);
  // paid_at: paid invoices closed `days_to_close` days after issue. We
  // generate a believable 10–35 day DSO instead of deriving from the
  // (negative-when-paid-early) days_overdue field.
  const days_to_close = inv.paid ? 10 + Math.abs(inv.days_overdue) % 25 : 0;
  const paid_at = inv.paid ? new Date(issued_at.getTime() + days_to_close * 86_400_000) : null;
  db.insert(schema.invoices)
    .values({
      client_id: clientByName[inv.client]!,
      number,
      amount_cents: inv.amount * 100,
      qbo_invoice_id: `qbo_${number}`,
      harvest_invoice_id: `h_${number}`,
      status: inv.paid ? 'paid' : 'sent',
      issued_at,
      due_at,
      paid_at: paid_at ?? null,
    })
    .run();

  // mirror into mock store so QBO CDC could re-emit if asked
  store.invoices.set(`qbo_${number}`, {
    id: `qbo_${number}`,
    customer_id: `qbo_${inv.client.replace(/\W+/g, '_').toLowerCase()}`,
    customer_name: inv.client,
    doc_number: number,
    amount_cents: inv.amount * 100,
    issued_at: issued_at.toISOString(),
    due_at: due_at.toISOString(),
    paid_at: paid_at?.toISOString() ?? null,
    status: inv.paid ? 'paid' : 'sent',
    source: 'qbo',
  });
}

// ----- 5. Time entries (drive Utilization heatmap). -----
const PEOPLE = ['Neel B.', 'Asha P.', 'Marcus L.', 'Rohan T.', 'Wren H.'];
const HARVEST_USER_BY = Object.fromEntries(
  PEOPLE.map((p) => [p, p.replace(/\W+/g, '_').toLowerCase()]),
);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
for (let i = 13; i >= 0; i--) {
  const d = new Date();
  d.setDate(d.getDate() - i);
  const wd = d.getDay(); // 0 Sun, 6 Sat
  if (wd === 0 || wd === 6) continue;
  for (const p of PEOPLE) {
    const id = `te_${HARVEST_USER_BY[p]}_${dayKey(d)}`;
    if (store.time_entries.has(id)) continue;
    const hours = 3 + Math.floor(Math.random() * 4); // 3-6h
    store.time_entries.set(id, {
      id,
      user_id: HARVEST_USER_BY[p]!,
      project_id: 'harvest_spring_campaign',
      date: dayKey(d),
      hours,
      notes: null,
    });
  }
}

// ----- 6. Drive the same 7 inbox events from the UI sketch. -----
// We trigger them through ingestEvent so agents fire and proposals get drafted.
async function seedEvents(): Promise<void> {
  // 1. Stellate aging_60 — Cash Chaser drafts firm reminder.
  await ingestEvent(ctx, {
    source: 'qbo',
    type: 'invoice.aging_60',
    subject_ref: 'invoice:qbo_INV-1041',
    occurred_at: new Date(),
    payload: {
      invoice_id: 'qbo_INV-1041',
      client_id: clientByName['Stellate Studios']!,
      amount_cents: 1_840_000,
      currency: 'USD',
      issued_at: new Date(Date.now() - 62 * 86_400_000),
      due_at: new Date(Date.now() - 62 * 86_400_000),
      days_overdue: 62,
    },
    dedupe_key: 'aging_60',
  });

  // 2. Northbeam contract.signed — Project Concierge drafts kickoff.
  await ingestEvent(ctx, {
    source: 'dropboxsign',
    type: 'contract.signed',
    subject_ref: 'contract:sig_northbeam_msa',
    occurred_at: new Date(Date.now() - 14 * 60_000),
    payload: {
      signature_request_id: 'sig_northbeam_msa',
      title: 'Northbeam — MSA',
      client_id: clientByName['Northbeam Inc.']!,
      sent_at: new Date(Date.now() - 5 * 86_400_000),
      signed_at: new Date(Date.now() - 14 * 60_000),
    },
    dedupe_key: 'signed',
  });

  // 3. Brightside invoice.draft_ready (the queued send in the UI sketch).
  await ingestEvent(ctx, {
    source: 'harvest',
    type: 'invoice.draft_ready_to_send',
    subject_ref: 'invoice:h_H-0427',
    occurred_at: new Date(Date.now() - 26 * 60 * 60 * 1000),
    payload: {
      harvest_invoice_id: 'H-0427',
      client_id: clientByName['Brightside Goods']!,
      amount_cents: 825_000,
      drafted_at: new Date(Date.now() - 26 * 60 * 60 * 1000),
    },
    dedupe_key: 'ready',
  });

  // 4. Petal & Vine budget threshold 100.
  await ingestEvent(ctx, {
    source: 'harvest',
    type: 'time.budget_threshold_100',
    subject_ref: 'project:' + projectByName['Spring Campaign'],
    occurred_at: new Date(),
    payload: {
      project_id: projectByName['Spring Campaign']!,
      harvest_project_id: 'harvest_spring_campaign',
      hours_used: 132,
      hours_budgeted: 132,
      pct: 1.0,
    },
    dedupe_key: 't100',
  });

  // 5. Halford status_stale.
  await ingestEvent(ctx, {
    source: 'airtable',
    type: 'project.status_stale',
    subject_ref: 'project:' + projectByName['Annual Report 2026'],
    occurred_at: new Date(),
    payload: {
      project_id: projectByName['Annual Report 2026']!,
      airtable_record_id: 'rec_annual_report_2026',
      days_silent: 17,
    },
    dedupe_key: 'stale_17',
  });

  // 6. payment.received_unapplied (Reconciler will leave it manual at low confidence).
  store.payments.set('qbo_pay_1', {
    id: 'qbo_pay_1',
    customer_name_raw: 'STELLATE STUDIOS LLC',
    amount_cents: 640_000,
    received_at: new Date().toISOString(),
    applied_to_invoice_id: null,
  });
  await ingestEvent(ctx, {
    source: 'qbo',
    type: 'payment.received_unapplied',
    subject_ref: 'payment:qbo_pay_1',
    occurred_at: new Date(),
    payload: {
      qbo_payment_id: 'qbo_pay_1',
      customer_name_raw: 'STELLATE STUDIOS LLC',
      amount_cents: 640_000,
      received_at: new Date(),
      candidate_invoice_ids: ['qbo_INV-1041', 'qbo_INV-1015'],
    },
    dedupe_key: 'unapplied',
  });

  // 7. time.missing_yesterday (Time Sentinel proposes self-nudge).
  const y = new Date();
  y.setDate(y.getDate() - 1);
  await ingestEvent(ctx, {
    source: 'harvest',
    type: 'time.missing_yesterday',
    subject_ref: 'time_entry:neel-' + dayKey(y),
    occurred_at: new Date(),
    payload: {
      harvest_user_id: 'neel_b',
      date: dayKey(y),
      hours_logged: 2.5,
    },
    dedupe_key: 'missing',
  });
}

await seedEvents();

console.log('seed complete');
db.$client.close?.();
