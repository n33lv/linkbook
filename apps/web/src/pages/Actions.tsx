import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import type { ActionsResp, ActionRow } from '../lib/types';
import { fmtRelative } from '../lib/format';
import { PageShell } from './Cash';

const TABS = ['open', 'failed', 'done', 'all'] as const;
type Tab = (typeof TABS)[number];

export function Actions() {
  const [tab, setTab] = useState<Tab>('open');
  const [data, setData] = useState<ActionsResp | null>(null);
  const [selected, setSelected] = useState<ActionRow | null>(null);

  async function refresh() {
    const r = await api<ActionsResp>(`/actions?status=${tab}`);
    setData(r);
  }
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <PageShell title="Actions" subtitle="queue · drafted by agents and humans">
      {data && (
        <div className="queue-stats">
          <Stat label="Awaiting approval" v={data.stats.open} signal />
          <Stat label="In flight" v={data.stats.in_flight} />
          <Stat label="Failed" v={data.stats.failed_today} />
          <Stat label="Done" v={data.stats.done_today} />
        </div>
      )}

      <div className="toggles" style={{ marginBottom: 14 }}>
        {TABS.map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="queue-list">
        {(data?.actions ?? []).map((a) => (
          <Row key={a.id} action={a} expanded={selected?.id === a.id} onSelect={() => setSelected(selected?.id === a.id ? null : a)} onChange={refresh} />
        ))}
        {data && data.actions.length === 0 && <div className="empty">no actions in this tab</div>}
      </div>
    </PageShell>
  );
}

function Stat({ label, v, signal }: { label: string; v: number; signal?: boolean }) {
  return (
    <div className="queue-stat">
      <div className="lbl">{label}</div>
      <div className={`num ${signal ? 'signal' : ''}`}>{v}</div>
    </div>
  );
}

function Row({
  action,
  expanded,
  onSelect,
  onChange,
}: {
  action: ActionRow;
  expanded: boolean;
  onSelect: () => void;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const isDraft = action.status === 'drafted';

  async function approve() {
    setBusy(true);
    try {
      await post(`/actions/${action.id}/approve`);
      onChange();
    } finally {
      setBusy(false);
    }
  }
  async function reject() {
    setBusy(true);
    try {
      await post(`/actions/${action.id}/reject`);
      onChange();
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    setBusy(true);
    try {
      await post(`/actions/${action.id}/undo`);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={`qrow ${action.status}`} onClick={onSelect}>
        <div className="stripe" />
        <div className="state">{action.status}</div>
        <div className="head">
          {labelFor(action)}
          <span>
            {action.type} · {action.drafted_by}
          </span>
        </div>
        <div className="when">{fmtRelative(action.created_at)}</div>
        <div></div>
      </div>
      {expanded && (
        <div style={{ padding: '14px 18px', background: 'rgba(0,0,0,.2)', borderBottom: '1px solid var(--rule-soft)' }}>
          {action.agent_rationale && (
            <div style={{ fontFamily: 'var(--f-display)', fontStyle: 'italic', color: 'var(--bone-2)', marginBottom: 10 }}>
              {action.agent_rationale}
            </div>
          )}
          <pre style={{ fontFamily: 'var(--f-mono)', fontSize: 11, color: 'var(--bone-2)', overflow: 'auto', margin: 0 }}>
            {action.preview || JSON.stringify(action.params, null, 2)}
          </pre>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            {isDraft && (
              <>
                <button className="btn primary" disabled={busy} onClick={approve}>Approve</button>
                <button className="btn ghost" disabled={busy} onClick={reject}>Reject</button>
              </>
            )}
            {(action.status === 'queued_30s' || action.status === 'succeeded') && action.reversal_class !== 'no_undo' && (
              <button className="btn" disabled={busy} onClick={undo}>Undo</button>
            )}
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--f-mono)', fontSize: 10, color: 'var(--bone-4)', textTransform: 'uppercase', letterSpacing: '.14em' }}>
              idem · {action.idempotency_key.slice(0, 16)}…
            </span>
          </div>
        </div>
      )}
    </>
  );
}

function labelFor(a: ActionRow): React.ReactNode {
  const p = a.params as Record<string, unknown>;
  if (a.type === 'invoice.remind') {
    return <>Reminder · invoice {String(p['invoice_id'])} · tone {String(p['tone'])}</>;
  }
  if (a.type === 'project.kickoff') {
    return <>Kickoff · {String(p['project_name'])}</>;
  }
  if (a.type === 'time.self_nudge') {
    return <>Self-nudge to log time</>;
  }
  if (a.type === 'payment.apply') {
    return <>Apply payment {String(p['payment_id'])} → {String(p['invoice_id'])}</>;
  }
  return a.type;
}
