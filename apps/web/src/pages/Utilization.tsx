import type { UtilizationView } from '../lib/types';
import { PageShell, Stat } from './Cash';
import { useResource } from '../lib/useResource';
import { Loading, ErrorState } from '../components/States';

export function Utilization() {
  const r = useResource<UtilizationView>('/dashboard/utilization', 0);
  if (r.state === 'loading') return <PageShell title="Utilization"><Loading /></PageShell>;
  if (r.state === 'error') return <PageShell title="Utilization"><ErrorState error={r.error} onRetry={r.retry} /></PageShell>;
  const data = r.data;

  const heatColor = (h: number): string => {
    if (h <= 0) return 'var(--ink-2)';
    if (h <= 1) return 'rgba(232,180,71,.15)';
    if (h <= 2) return 'rgba(232,180,71,.35)';
    if (h <= 4) return 'rgba(232,180,71,.55)';
    if (h <= 6) return 'rgba(232,180,71,.85)';
    return 'var(--signal)';
  };

  const dayLabel = (d: string) => d.slice(8); // last two digits of day-of-month

  return (
    <PageShell title="Utilization" subtitle="14-day window">
      <div className="stat-grid cols-3">
        <Stat label="Billable %" value={`${data.billable_pct}%`} signal />
        <Stat label="Logged hours" value={`${data.logged_hours}h`} />
        <Stat label="Retainer cap" value={`${data.retainer_cap_pct}%`} />
      </div>

      <div className="section-head">
        <h3>Capacity heatmap</h3>
        <div className="meta">cell = billable hours per day</div>
      </div>

      <div className="heat">
        <div></div>
        {data.days.map((d) => <div className="col-h" key={d}>{dayLabel(d)}</div>)}
        {data.heatmap.map((row) => (
          <FragmentRow key={row.user_id} userId={row.user_id} daily={row.daily} heatColor={heatColor} />
        ))}
        {data.heatmap.length === 0 && (
          <div style={{ gridColumn: '1 / -1', padding: 24, fontFamily: 'var(--f-mono)', fontSize: 11, color: 'var(--bone-4)', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '.18em' }}>
            no time entries — seed time data to populate
          </div>
        )}
      </div>
    </PageShell>
  );
}

function FragmentRow({ userId, daily, heatColor }: { userId: string; daily: number[]; heatColor: (h: number) => string }) {
  return (
    <>
      <div className="row-h">{userId}</div>
      {daily.map((h, i) => (
        <div key={i} className="cell" style={{ background: heatColor(h) }} title={`${userId}: ${h}h`} />
      ))}
    </>
  );
}
