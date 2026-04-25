import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import type { ActionRow, EventRow, InboxResp } from '../lib/types';
import { ProposalCard } from '../components/ProposalCard';
import { QueuedCountdown } from '../components/QueuedCountdown';
import { ErrorState, Loading } from '../components/States';
import { fmtCents, fmtRelative } from '../lib/format';

const FILTERS = ['all', 'money', 'projects', 'contracts', 'time'] as const;
type Filter = (typeof FILTERS)[number];

export function Inbox() {
  const [filter, setFilter] = useState<Filter>('all');
  const [data, setData] = useState<InboxResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await api<InboxResp>(`/inbox?filter=${filter}`);
      setData(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  return (
    <>
      <div className="topbar">
        <h1>
          Inbox
          <small>
            {data ? `${data.events.length} of ${data.counts.all}` : 'loading'}
          </small>
        </h1>
        <div className="topbar-right">
          <span className="health">
            <span className="dot"></span> 5 / 5 connected
          </span>
        </div>
      </div>

      <div className="page" style={{ paddingTop: 22 }}>
        <div className="filters">
          {FILTERS.map((f) => (
            <button
              key={f}
              className={`pill ${filter === f ? 'on' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f} {data?.counts ? `· ${data.counts[f]}` : ''}
            </button>
          ))}
        </div>

        {error && <ErrorState error={error} onRetry={refresh} />}

        <div className="inbox-grid">
          <PriorityRail events={data?.events ?? []} />
          <section className="feed">
            <div className="events">
              {data === null && !error ? (
                <Loading />
              ) : data?.events.length === 0 ? (
                <div className="empty">
                  You're caught up. <br />
                  <small style={{ fontFamily: 'var(--f-mono)', textTransform: 'uppercase', letterSpacing: '.16em', fontSize: 11, fontStyle: 'normal' }}>
                    No events match · all sources synced
                  </small>
                </div>
              ) : (
                data?.events.map((e) => <EventCard key={e.id} ev={e} onChange={refresh} />)
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function PriorityRail({ events }: { events: EventRow[] }) {
  // 24 slots; fill with actual events at top, dim placeholders below.
  const top = events.slice(0, 24);
  const dim = Math.max(0, 24 - top.length);
  return (
    <aside className="rail">
      <div className="rail-bars">
        {top.map((e, i) => (
          <div key={e.id} className={`rail-bar active`} title={`${e.type} · score ${e.priority_score}`}>
            <span className="num">{e.priority_score}</span>
            <span
              className="fill"
              style={{ width: `${Math.max(4, e.priority_score)}%`, height: 5 }}
            />
            <span style={{ display: 'none' }}>{i}</span>
          </div>
        ))}
        {Array.from({ length: dim }).map((_, i) => (
          <div key={`dim-${i}`} className="rail-bar dim">
            <span className="num">·</span>
            <span className="fill" style={{ width: '8%', height: 5 }} />
          </div>
        ))}
      </div>
      <div className="rail-foot">↑ {top.length}</div>
    </aside>
  );
}

function EventCard({ ev, onChange }: { ev: EventRow; onChange: () => void }) {
  const score = ev.priority_score;
  const cls = score >= 80 ? 'hot' : score < 40 ? 'cold' : '';
  const proposed = ev.proposed_actions.find((a) => a.status === 'drafted');
  const queued = ev.proposed_actions.find((a) => a.status === 'queued_30s');

  return (
    <article className="ev">
      <div className="score-wrap" title={`Score ${score}`}>
        <div className={`score ${cls}`}>{score}</div>
      </div>
      <div className="body">
        <div className="meta-row">
          <span className={`src ${ev.source}`}>◆ {ev.source.toUpperCase()}</span>
          <span className="age">{fmtRelative(ev.occurred_at)}</span>
        </div>
        <div className="title">{titleFor(ev)}</div>
        <div className="sub">{subFor(ev)}</div>

        {proposed && <ProposalCard action={proposed} onChange={onChange} />}
        {queued && <QueuedCountdown action={queued} onChange={onChange} />}
      </div>
      <div className="actions"></div>
    </article>
  );
}

function titleFor(ev: EventRow): React.ReactNode {
  const p = ev.payload as Record<string, unknown>;
  const client = ev.client?.name ?? '';
  const amt = typeof p['amount_cents'] === 'number' ? fmtCents(p['amount_cents'] as number) : '';
  switch (ev.type) {
    case 'invoice.aging_60':
    case 'invoice.aging_30':
    case 'invoice.aging_90':
    case 'invoice.overdue': {
      const id = String(p['invoice_id'] ?? '');
      const days = String(p['days_overdue'] ?? '');
      return (
        <>
          {client} · invoice <b>{id}</b> · {days} days overdue · {amt}
        </>
      );
    }
    case 'invoice.draft_ready_to_send': {
      const id = String(p['harvest_invoice_id'] ?? '');
      return (
        <>
          {client} · Harvest invoice <b>{id}</b> · {amt}
        </>
      );
    }
    case 'contract.signed': {
      const title = String(p['title'] ?? 'agreement');
      return (
        <>
          {client || 'Counterparty'} · <b>{title}</b> signed
        </>
      );
    }
    case 'contract.declined': {
      const title = String(p['title'] ?? 'agreement');
      return (
        <>
          {client || 'Counterparty'} · <b>{title}</b> declined
        </>
      );
    }
    case 'time.budget_threshold_80':
    case 'time.budget_threshold_100':
    case 'time.budget_threshold_120': {
      const used = Number(p['hours_used'] ?? 0);
      const budget = Number(p['hours_budgeted'] ?? 0);
      const pct = Math.round(Number(p['pct'] ?? 0) * 100);
      return (
        <>
          {client || 'Project'} hit <b>{pct}%</b> of budget · {used}h / {budget}h
        </>
      );
    }
    case 'project.status_stale': {
      const days = Number(p['days_silent'] ?? 0);
      return (
        <>
          {client || 'Project'} · no Airtable update for <b>{days} days</b>
        </>
      );
    }
    case 'payment.received_unapplied': {
      return (
        <>
          Wire of <b>{amt}</b> from "{String(p['customer_name_raw'] ?? '')}" — no invoice match
        </>
      );
    }
    case 'time.missing_yesterday': {
      const h = Number(p['hours_logged'] ?? 0);
      return (
        <>
          You logged <b>{h}h</b> · &lt; 4h on a workday
        </>
      );
    }
    case 'agent.needs_approval':
      return <>Agent flagged this for manual review</>;
    case 'action.failed':
      return <>An action failed</>;
    default:
      return ev.type;
  }
}

function subFor(ev: EventRow): React.ReactNode {
  const tier = ev.client?.tier;
  if (tier === 1) return <>Tier A · retainer client</>;
  if (tier === 2) return <>Tier B</>;
  if (tier === 3) return <>Tier C</>;
  return <>{ev.subject_ref}</>;
}

// re-export so the api client can be imported here without unused warning
export { post };
