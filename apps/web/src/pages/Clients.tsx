import type { ClientsView } from '../lib/types';
import { fmtCents } from '../lib/format';
import { PageShell } from './Cash';
import { useResource } from '../lib/useResource';
import { Loading, ErrorState } from '../components/States';

export function Clients() {
  const r = useResource<ClientsView>('/dashboard/clients', 0);
  if (r.state === 'loading') return <PageShell title="Clients"><Loading /></PageShell>;
  if (r.state === 'error') return <PageShell title="Clients"><ErrorState error={r.error} onRetry={r.retry} /></PageShell>;
  const data = r.data;

  return (
    <PageShell title="Clients" subtitle={`${data.clients.length} total`}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Client</th>
            <th style={{ textAlign: 'right' }}>Lifetime</th>
            <th style={{ textAlign: 'right' }}>Open A/R</th>
            <th style={{ textAlign: 'right' }}>Tier</th>
          </tr>
        </thead>
        <tbody>
          {data.clients.map((c) => (
            <tr key={c.id}>
              <td className="name"><b>{c.name}</b></td>
              <td className="nu" style={{ textAlign: 'right' }}>{fmtCents(c.lifetime_cents)}</td>
              <td className="nu" style={{ textAlign: 'right' }}>{c.open_ar_cents > 0 ? <span className="neg">{fmtCents(c.open_ar_cents)}</span> : '—'}</td>
              <td style={{ textAlign: 'right' }}>{c.tier ? <span className={`tier ${c.tier === 1 ? '' : c.tier === 2 ? 't2' : 't3'}`}>tier {['', 'A', 'B', 'C'][c.tier]}</span> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </PageShell>
  );
}
