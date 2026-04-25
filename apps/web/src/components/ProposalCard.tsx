import { useMemo, useState } from 'react';
import type { ActionRow } from '../lib/types';
import { post } from '../lib/api';

type ApproveResp =
  | { ok: true; status: 'queued_30s' }
  | { ok: true; status: 'succeeded'; undo_token: string | null }
  | { ok: true; status: 'cancelled'; reason: string };

export function ProposalCard({ action, onChange }: { action: ActionRow; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ kind: 'cancelled'; reason: string } | null>(null);

  const conf = action.agent_confidence ? Number(action.agent_confidence) : 0;
  const agentLabel = action.drafted_by.startsWith('agent:')
    ? action.drafted_by.slice('agent:'.length).split('@')[0]
    : action.drafted_by;
  const agentName = (agentLabel ?? '').replace(/_/g, ' ');

  const safe = useMemo(() => {
    if (action.reversal_class === 'no_undo') return 'no undo · double-confirm to send';
    if (
      action.type === 'invoice.remind' ||
      action.type === 'email.send_draft' ||
      action.type === 'time.self_nudge'
    )
      return 'undo · 30s soft window · re-checks subject on send';
    if (action.reversal_class === 'compensating') return 'compensating undo within 24h';
    return 'true undo within 24h';
  }, [action]);

  async function approve() {
    setBusy(true);
    setErr(null);
    setOutcome(null);
    try {
      const r = await post<ApproveResp>(`/actions/${action.id}/approve`);
      if (r.ok && r.status === 'cancelled') {
        // §5.3 hallucination guard cancelled the send — surface why.
        setOutcome({ kind: 'cancelled', reason: r.reason });
      }
      onChange();
    } catch (e) {
      const msg = (e as Error).message;
      // Server returns 409 with { error: 'not_drafted', status: 'queued_30s' }
      // when someone else already approved. Show a friendlier message.
      if (msg.includes('409')) {
        setErr('Already in flight or done — refresh to see the latest status.');
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }
  async function reject() {
    setBusy(true);
    setErr(null);
    try {
      await post(`/actions/${action.id}/reject`);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="proposal">
      <div className="proposal-head">
        <span className="agent">{agentName || 'agent'}</span>
        <span>· {action.type.replace(/\./g, ' ')}</span>
        <span className="conf">
          conf{' '}
          <span className="bar">
            <i style={{ width: `${Math.round(conf * 100)}%` }} />
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--bone)' }}>
            {conf.toFixed(2)}
          </span>
        </span>
      </div>
      {action.agent_rationale && <div className="proposal-rationale">{action.agent_rationale}</div>}
      <div className="proposal-preview">{action.preview || formatParams(action.params)}</div>
      <div className="proposal-foot">
        <button className="btn primary" disabled={busy} onClick={approve}>
          Approve & Send
        </button>
        <button className="btn ghost" disabled={busy} onClick={reject}>
          Reject
        </button>
        <span className="safe">{safe}</span>
        {err && (
          <span style={{ color: 'var(--bad)', fontSize: 11, fontFamily: 'var(--f-mono)', marginLeft: 8 }}>
            {err}
          </span>
        )}
      </div>
      {outcome?.kind === 'cancelled' && (
        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--rule)',
            background: 'rgba(127,174,110,.06)',
            fontFamily: 'var(--f-mono)',
            fontSize: 11,
            color: 'var(--good)',
            textTransform: 'uppercase',
            letterSpacing: '.14em',
          }}
        >
          Auto-resolved · {outcome.reason}
        </div>
      )}
    </div>
  );
}

function formatParams(p: Record<string, unknown>): string {
  return JSON.stringify(p, null, 2);
}
