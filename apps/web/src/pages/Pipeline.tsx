import type { PipelineView } from '../lib/types';
import { fmtCents } from '../lib/format';
import { PageShell, Stat } from './Cash';
import { useResource } from '../lib/useResource';
import { Loading, ErrorState } from '../components/States';

export function Pipeline() {
  const r = useResource<PipelineView>('/dashboard/pipeline', 0);
  if (r.state === 'loading') return <PageShell title="Pipeline"><Loading /></PageShell>;
  if (r.state === 'error') return <PageShell title="Pipeline"><ErrorState error={r.error} onRetry={r.retry} /></PageShell>;
  const data = r.data;

  return (
    <PageShell title="Pipeline" subtitle="last 90 days">
      <div className="stat-grid cols-4">
        <Stat label="Sent" value={String(data.sent)} />
        <Stat label="Signed" value={String(data.signed)} signal />
        <Stat label="Declined" value={String(data.declined)} />
        <Stat label="Conversion" value={`${Math.round(data.conversion_rate * 100)}%`} />
      </div>

      <div className="section-head">
        <h3>Funnel</h3>
        <div className="meta">{fmtCents(data.expected_revenue_cents)} expected</div>
      </div>
      <Funnel sent={data.sent} signed={data.signed} declined={data.declined} />

      {data.open_contracts.length > 0 && (
        <>
          <div className="section-head">
            <h3>Open contracts</h3>
            <div className="meta">awaiting signature</div>
          </div>
          <div className="top-list">
            {data.open_contracts.map((e, i) => (
              <div className="row" key={e.id}>
                <span className="rk">·</span>
                <span className="who">
                  <b>{(e.payload as { title?: string }).title ?? 'contract'}</b>
                  <br />
                  <span>{e.subject_ref}</span>
                </span>
                <span className="age warn">unsigned</span>
                <span className="amt">—</span>
                <span style={{ display: 'none' }}>{i}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </PageShell>
  );
}

function Funnel({ sent, signed, declined }: { sent: number; signed: number; declined: number }) {
  const stages: Array<[string, number]> = [
    ['Sent', sent],
    ['Signed', signed],
    ['Declined', declined],
  ];
  return (
    <div className="top-list">
      {stages.map(([name, n]) => (
        <div className="row" key={name}>
          <span className="rk">·</span>
          <span className="who"><b>{name}</b></span>
          <span className="age" style={{ color: 'var(--bone-3)' }}>·</span>
          <span className="amt">{n}</span>
        </div>
      ))}
    </div>
  );
}
