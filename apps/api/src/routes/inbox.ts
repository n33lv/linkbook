import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@linkbook/db';
import { z } from 'zod';
import { setEventState } from '../db/events-repo.js';

// §1 — Inbox routes. The default ranking: state in unread/read,
// priority desc, occurred desc.

const FILTER_PILLS = ['all', 'money', 'projects', 'contracts', 'time'] as const;
type FilterPill = (typeof FILTER_PILLS)[number];

const TYPE_GROUPS: Record<FilterPill, string[]> = {
  all: [],
  money: [
    'invoice.overdue',
    'invoice.aging_30',
    'invoice.aging_60',
    'invoice.aging_90',
    'invoice.draft_ready_to_send',
    'invoice.paid',
    'payment.received_unapplied',
    'bill.due_in_3_days',
    'expense.uncategorized',
  ],
  projects: [
    'project.status_stale',
    'project.milestone_due_soon',
    'project.milestone_overdue',
    'time.budget_threshold_80',
    'time.budget_threshold_100',
    'time.budget_threshold_120',
  ],
  contracts: ['contract.sent_unsigned_5d', 'contract.signed', 'contract.declined'],
  time: ['time.missing_yesterday', 'time.uninvoiced_over_threshold'],
};

export const inboxRoutes: FastifyPluginAsync = async (app) => {
  app.get('/inbox', async (req, _reply) => {
    const q = z
      .object({
        filter: z.enum(FILTER_PILLS).default('all'),
        // include resolved (done/dismissed) for the "show resolved" toggle
        include_resolved: z.enum(['true', 'false']).default('false'),
      })
      .parse(req.query);
    const db = app.db;

    const stateFilter =
      q.include_resolved === 'true'
        ? sql`${schema.events.state} IN ('unread','read','snoozed','waiting','done','dismissed')`
        : sql`${schema.events.state} IN ('unread','read','snoozed','waiting')`;

    const types = TYPE_GROUPS[q.filter];
    const whereTypes =
      types.length > 0
        ? inArray(schema.events.type, types as Array<typeof schema.events.$inferSelect.type>)
        : sql`1=1`;

    const events = db
      .select()
      .from(schema.events)
      .where(and(stateFilter, whereTypes))
      .orderBy(desc(schema.events.priority_score), desc(schema.events.occurred_at))
      .all();

    if (events.length === 0) {
      return { events: [], counts: emptyCounts() };
    }

    // Attach drafted proposed actions per event (one round trip).
    const eventIds = events.map((e) => e.id);
    const drafted = db
      .select()
      .from(schema.actions)
      .where(
        and(
          inArray(schema.actions.originating_event_id, eventIds),
          sql`${schema.actions.status} IN ('drafted','queued_30s','approved','executing')`,
        ),
      )
      .all();

    // Attach client names for ranking display.
    const subjectClients = collectSubjectClients(db, events);

    const counts = computeCounts(db);

    return {
      events: events.map((e) => ({
        ...e,
        proposed_actions: drafted.filter((a) => a.originating_event_id === e.id),
        client: subjectClients[e.subject_ref] ?? null,
      })),
      counts,
    };
  });

  app.get('/inbox/:event_id', async (req, _reply) => {
    const { event_id } = z.object({ event_id: z.string().uuid() }).parse(req.params);
    const db = app.db;
    const event = db.select().from(schema.events).where(eq(schema.events.id, event_id)).all()[0];
    if (!event) return { event: null, thread: [], audit: [] };

    // Thread: all events with the same subject_ref.
    const thread = db
      .select()
      .from(schema.events)
      .where(eq(schema.events.subject_ref, event.subject_ref))
      .orderBy(desc(schema.events.occurred_at))
      .all();

    const audit = db
      .select()
      .from(schema.audit_events)
      .where(eq(schema.audit_events.subject_ref, event.subject_ref))
      .orderBy(desc(schema.audit_events.created_at))
      .all();

    return { event, thread, audit };
  });

  app.post('/inbox/:event_id/state', async (req, reply) => {
    const { event_id } = z.object({ event_id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        state: z.enum(['read', 'done', 'snoozed', 'dismissed']),
        wake_at: z.coerce.date().optional(),
      })
      .parse(req.body);
    const db = app.db;
    const cur = db.select().from(schema.events).where(eq(schema.events.id, event_id)).all()[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });

    if (body.state === 'snoozed') {
      const wake = body.wake_at ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      db.update(schema.events)
        .set({ state: 'snoozed', snoozed_until: wake, updated_at: new Date() })
        .where(eq(schema.events.id, event_id))
        .run();
    } else {
      await setEventState({ db, cfg: app.cfg, log: app.log }, event_id, body.state, 'user');
    }
    return { ok: true };
  });
};

function collectSubjectClients(
  db: import('@linkbook/db').Db,
  events: Array<typeof schema.events.$inferSelect>,
): Record<string, { name: string; tier: number | null }> {
  // crude: payload may carry client_id; for v1 we look up by name match
  // when subject_ref is not invoice-shaped.
  const clientIds = new Set<string>();
  for (const e of events) {
    const p = e.payload as { client_id?: string };
    if (p?.client_id) clientIds.add(p.client_id);
  }
  if (clientIds.size === 0) return {};
  const rows = db
    .select()
    .from(schema.clients)
    .where(inArray(schema.clients.id, Array.from(clientIds)))
    .all();
  const byId: Record<string, { name: string; tier: number | null }> = {};
  for (const c of rows) byId[c.id] = { name: c.name, tier: c.tier ?? null };
  const out: Record<string, { name: string; tier: number | null }> = {};
  for (const e of events) {
    const p = e.payload as { client_id?: string };
    if (!p?.client_id) continue;
    const found = byId[p.client_id];
    if (found) out[e.subject_ref] = found;
  }
  return out;
}

function emptyCounts() {
  return { all: 0, money: 0, projects: 0, contracts: 0, time: 0 };
}

function computeCounts(db: import('@linkbook/db').Db) {
  const counts = emptyCounts();
  const grouped = db
    .select({ type: schema.events.type, n: sql<number>`count(*)` })
    .from(schema.events)
    .where(sql`${schema.events.state} IN ('unread','read')`)
    .groupBy(schema.events.type)
    .all();
  for (const r of grouped) {
    counts.all += Number(r.n);
    for (const pill of FILTER_PILLS) {
      if (pill === 'all') continue;
      if (TYPE_GROUPS[pill].includes(r.type as string)) counts[pill] += Number(r.n);
    }
  }
  return counts;
}
