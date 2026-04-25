import type { ProjectsView } from '../lib/types';
import { PageShell } from './Cash';
import { useResource } from '../lib/useResource';
import { Loading, ErrorState } from '../components/States';

export function Projects() {
  const r = useResource<ProjectsView>('/dashboard/projects', 0);
  if (r.state === 'loading') return <PageShell title="Projects"><Loading /></PageShell>;
  if (r.state === 'error') return <PageShell title="Projects"><ErrorState error={r.error} onRetry={r.retry} /></PageShell>;
  const data = r.data;

  return (
    <PageShell title="Projects" subtitle={`${data.projects.length} active · health`}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Status</th><th>Project / client</th><th>Budget</th><th>Owner</th><th>Last status</th><th></th>
          </tr>
        </thead>
        <tbody>
          {data.projects.map((p) => (
            <tr key={p.id}>
              <td>
                <span className="ph-status">
                  <span className={`ph-dot ${p.rag}`} /> {p.rag}
                </span>
              </td>
              <td className="name">
                <b>{p.name}</b>
                <span>{p.client_name ?? '—'}</span>
              </td>
              <td>
                <span className="nu">{p.hours_used ?? 0} / {p.budget_hours ?? 0}h</span>
                <div className="budget-bar">
                  <i className={p.budget_pct >= 100 ? 'over' : ''} style={{ width: `${Math.min(100, p.budget_pct)}%` }} />
                </div>
              </td>
              <td className="nu">{p.owner ?? '—'}</td>
              <td className="nu">{p.days_silent === 999 ? '—' : `${p.days_silent}d`}</td>
              <td><button className="btn tiny">Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </PageShell>
  );
}
