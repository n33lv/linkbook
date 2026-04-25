import { useState } from 'react';
import { post } from '../lib/api';
import type { IntegrationsResp } from '../lib/types';
import { fmtRelative } from '../lib/format';
import { PageShell } from './Cash';
import { useResource } from '../lib/useResource';
import { Loading, ErrorState } from '../components/States';

export function Integrations() {
  const r = useResource<IntegrationsResp>('/integrations', 0);
  const [probeResult, setProbeResult] = useState<string | null>(null);

  async function runProbe() {
    setProbeResult('running…');
    try {
      const res = await post<{ ok: boolean; propagated_in_seconds: number | null }>('/integrations/harvest_qbo/probe');
      setProbeResult(res.ok ? `propagated in ${res.propagated_in_seconds}s` : 'probe failed');
    } catch (e) {
      setProbeResult((e as Error).message);
    }
  }

  if (r.state === 'loading') return <PageShell title="Integrations"><Loading /></PageShell>;
  if (r.state === 'error') return <PageShell title="Integrations"><ErrorState error={r.error} onRetry={r.retry} /></PageShell>;
  const data = r.data;

  return (
    <PageShell title="Integrations" subtitle={data.mocks ? 'mocked' : 'real'}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Source</th>
            <th>Status</th>
            <th>Last sync</th>
          </tr>
        </thead>
        <tbody>
          {data.connections.map((c) => (
            <tr key={c.id}>
              <td className="name"><b>{c.display_name ?? c.source}</b><span>{c.source}</span></td>
              <td>{c.status}</td>
              <td className="nu">{c.last_sync_at ? fmtRelative(c.last_sync_at) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-head"><h3>Harvest → QuickBooks sync probe</h3><div className="meta">§4.1</div></div>
      <div style={{ background: 'var(--ink-1)', border: '1px solid var(--rule)', padding: 18 }}>
        <button className="btn" onClick={runProbe}>Run probe</button>
        {probeResult && <span style={{ marginLeft: 12, fontFamily: 'var(--f-mono)', fontSize: 11, color: 'var(--bone-2)', textTransform: 'uppercase', letterSpacing: '.16em' }}>{probeResult}</span>}
      </div>
    </PageShell>
  );
}
