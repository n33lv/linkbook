import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@linkbook/db';

// §3 — five canned views.

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  // §3.1.1 Cash
  app.get('/dashboard/cash', async () => {
    const db = app.db;
    const open = db
      .select()
      .from(schema.invoices)
      .where(sql`${schema.invoices.status} != 'paid'`)
      .all();

    const now = Date.now();
    const buckets = { '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 };
    let total = 0;
    for (const inv of open) {
      const due = inv.due_at ? inv.due_at.getTime() : now;
      const days = Math.max(0, Math.floor((now - due) / 86_400_000));
      total += inv.amount_cents;
      if (days <= 30) buckets['0_30'] += inv.amount_cents;
      else if (days <= 60) buckets['31_60'] += inv.amount_cents;
      else if (days <= 90) buckets['61_90'] += inv.amount_cents;
      else buckets['90_plus'] += inv.amount_cents;
    }

    // QTD revenue (cash basis = paid_at-based; accrual = issued_at-based)
    const startOfQuarter = startOfThisQuarter();
    const paidThisQ = db
      .select()
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.status, 'paid'),
          sql`${schema.invoices.paid_at} >= ${startOfQuarter.getTime()}`,
        ),
      )
      .all();
    const qtd_cash = paidThisQ.reduce((s, i) => s + i.amount_cents, 0);

    const issuedThisQ = db
      .select()
      .from(schema.invoices)
      .where(sql`${schema.invoices.issued_at} >= ${startOfQuarter.getTime()}`)
      .all();
    const qtd_accrual = issuedThisQ.reduce((s, i) => s + i.amount_cents, 0);

    // Top 5 outstanding by amount.
    const top = open
      .slice()
      .sort((a, b) => b.amount_cents - a.amount_cents)
      .slice(0, 5);
    const clientById = new Map(
      db.select().from(schema.clients).all().map((c) => [c.id, c]),
    );

    // Avg time-to-payment (paid invoices, issued vs paid_at, last 90d)
    const since = new Date(Date.now() - 90 * 86_400_000);
    const recentPaid = db
      .select()
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.status, 'paid'),
          sql`${schema.invoices.paid_at} >= ${since.getTime()}`,
        ),
      )
      .all();
    const days = recentPaid
      .filter((i) => i.issued_at && i.paid_at)
      .map((i) => (i.paid_at!.getTime() - i.issued_at!.getTime()) / 86_400_000);
    const avg_days_to_payment = days.length === 0 ? 0 : Math.round(days.reduce((a, b) => a + b, 0) / days.length);

    return {
      ar_aging: buckets,
      ar_total_cents: total,
      qtd_revenue_cash_cents: qtd_cash,
      qtd_revenue_accrual_cents: qtd_accrual,
      top_outstanding: top.map((inv) => ({
        invoice_id: inv.id,
        number: inv.number,
        amount_cents: inv.amount_cents,
        days_overdue: inv.due_at ? Math.max(0, Math.floor((now - inv.due_at.getTime()) / 86_400_000)) : 0,
        client_name: clientById.get(inv.client_id)?.name ?? null,
      })),
      avg_days_to_payment,
      last_synced_at: new Date(),
    };
  });

  // §3.1.2 Pipeline (mock-friendly: read from contracts as recorded by the dropbox sign mocks)
  app.get('/dashboard/pipeline', async () => {
    const db = app.db;
    // We thread contracts through events for simplicity in v1.
    const events = db
      .select()
      .from(schema.events)
      .where(sql`${schema.events.type} IN ('contract.sent_unsigned_5d','contract.signed','contract.declined')`)
      .all();
    const sent = events.length;
    const signed = events.filter((e) => e.type === 'contract.signed').length;
    const declined = events.filter((e) => e.type === 'contract.declined').length;
    const conversion = sent === 0 ? 0 : signed / sent;
    return {
      sent,
      signed,
      declined,
      expected_revenue_cents: 0, // TODO(integration:dropboxsign): read from contract metadata
      conversion_rate: conversion,
      open_contracts: events.filter((e) => e.type === 'contract.sent_unsigned_5d').slice(0, 10),
    };
  });

  // §3.1.3 Utilization
  app.get('/dashboard/utilization', async () => {
    // Read from the integration mock store directly for v1 (we don't
    // mirror time entries to the local cache yet).
    const { getMockStore } = await import('../integrations/_mocks/index.js');
    const store = getMockStore();
    const entries = Array.from(store.time_entries.values());
    const total_hours = entries.reduce((s, e) => s + e.hours, 0);
    const billable_hours = total_hours; // mock: assume all billable
    const billable_pct = total_hours === 0 ? 0 : Math.round((billable_hours / Math.max(total_hours, 1)) * 100);
    // 14-day heatmap
    const today = new Date();
    const days: string[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const byUser = new Map<string, Map<string, number>>();
    for (const e of entries) {
      if (!byUser.has(e.user_id)) byUser.set(e.user_id, new Map());
      byUser.get(e.user_id)!.set(e.date, (byUser.get(e.user_id)!.get(e.date) ?? 0) + e.hours);
    }
    const heatmap = Array.from(byUser.entries()).map(([user_id, m]) => ({
      user_id,
      daily: days.map((d) => m.get(d) ?? 0),
    }));
    return {
      billable_pct,
      logged_hours: Math.round(total_hours),
      retainer_cap_pct: 0,
      heatmap,
      days,
    };
  });

  // §3.1.4 Project health
  app.get('/dashboard/projects', async () => {
    const db = app.db;
    const rows = db.select().from(schema.projects).all();
    const clients = new Map(db.select().from(schema.clients).all().map((c) => [c.id, c]));

    const now = Date.now();
    const out = rows.map((p) => {
      const days_silent = p.last_status_update_at
        ? Math.floor((now - p.last_status_update_at.getTime()) / 86_400_000)
        : 999;
      const pct = p.budget_hours && p.hours_used != null ? p.hours_used / p.budget_hours : 0;
      let rag: 'red' | 'amber' | 'green' = 'green';
      if (pct >= 1.0 || days_silent > 14) rag = 'red';
      else if (pct >= 0.75 || days_silent > 7) rag = 'amber';
      return {
        ...p,
        client_name: clients.get(p.client_id)?.name ?? null,
        days_silent,
        budget_pct: Math.round(pct * 100),
        rag,
      };
    });
    return { projects: out };
  });

  // §3.1.5 Clients
  app.get('/dashboard/clients', async () => {
    const db = app.db;
    const rows = db.select().from(schema.clients).all();
    const invoices = db.select().from(schema.invoices).all();
    return {
      clients: rows.map((c) => {
        const ci = invoices.filter((i) => i.client_id === c.id);
        const lifetime = ci.filter((i) => i.status === 'paid').reduce((s, i) => s + i.amount_cents, 0);
        const open_ar = ci.filter((i) => i.status !== 'paid').reduce((s, i) => s + i.amount_cents, 0);
        return {
          ...c,
          lifetime_cents: lifetime,
          open_ar_cents: open_ar,
        };
      }),
    };
  });
};

function startOfThisQuarter(): Date {
  const now = new Date();
  const m = now.getMonth();
  const qStartMonth = m - (m % 3);
  return new Date(now.getFullYear(), qStartMonth, 1);
}
