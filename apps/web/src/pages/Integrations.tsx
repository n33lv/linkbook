import { useState } from 'react';
import { post, api } from '../lib/api';
import type { IntegrationsResp, Source } from '../lib/types';
import { fmtRelative } from '../lib/format';
import { PageShell } from './Cash';
import { useResource } from '../lib/useResource';
import { Loading, ErrorState } from '../components/States';

const ALL_SOURCES: Source[] = ['qbo', 'harvest', 'dropboxsign', 'airtable', 'gmail'];

const SOURCE_LABEL: Record<string, string> = {
  qbo: 'QuickBooks',
  harvest: 'Harvest',
  dropboxsign: 'Dropbox Sign',
  airtable: 'Airtable',
  gmail: 'Gmail',
};

export function Integrations() {
  const r = useResource<IntegrationsResp>('/integrations', 0);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ source: string; text: string } | null>(null);

  async function runProbe() {
    setProbeResult('running…');
    try {
      const res = await post<{ ok: boolean; propagated_in_seconds: number | null }>(
        '/integrations/harvest_qbo/probe'
      );
      setProbeResult(res.ok ? `propagated in ${res.propagated_in_seconds}s` : 'probe failed');
    } catch (e) {
      setProbeResult((e as Error).message);
    }
  }

  async function connect(source: string) {
    setBusy(source);
    try {
      const res = await post<{ redirect_url: string | null; note?: string }>(
        `/integrations/${source}/connect`
      );
      if (res.redirect_url) {
        // Open the provider's authorize page in a new tab so the user
        // doesn't lose the Linkbook UI state. The browser comes back to
        // localhost:3000/integrations/{source}/callback after authorize.
        window.open(res.redirect_url, '_blank', 'noopener');
      } else {
        setTestResult({
          source,
          text: res.note ?? 'mocks enabled — no OAuth needed',
        });
      }
    } catch (e) {
      setTestResult({ source, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function smokeTest(source: string) {
    setBusy(source);
    setTestResult({ source, text: 'running…' });
    try {
      const res = await api<{ ok: boolean; user?: { email?: string }; project_count?: number }>(
        `/integrations/${source}/test`
      );
      const summary = res.user?.email
        ? `live ✓  ${res.user.email}  ·  ${res.project_count ?? 0} project(s)`
        : 'live ✓';
      setTestResult({ source, text: summary });
      if (r.state === 'ready') r.refresh();
    } catch (e) {
      setTestResult({ source, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (r.state === 'loading')
    return (
      <PageShell title="Integrations">
        <Loading />
      </PageShell>
    );
  if (r.state === 'error')
    return (
      <PageShell title="Integrations">
        <ErrorState error={r.error} onRetry={r.retry} />
      </PageShell>
    );
  const data = r.data;
  const live = new Set(data.live_sources ?? []);
  const connected = new Set(data.connections.map((c) => c.source));

  return (
    <PageShell title="Integrations" subtitle={data.mocks ? 'mocks on' : 'real APIs'}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Source</th>
            <th>Status</th>
            <th>Account</th>
            <th>Last sync</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {ALL_SOURCES.map((source) => {
            const conn = data.connections.find((c) => c.source === source);
            const isLive = live.has(source);
            const isConnected = connected.has(source);
            const supportsTest = source === 'harvest';
            return (
              <tr key={source}>
                <td className="name">
                  <b>{SOURCE_LABEL[source]}</b>
                  <span>
                    {source}
                    {isLive ? ' · live' : ' · mocked'}
                  </span>
                </td>
                <td>
                  {conn ? (
                    <span style={{ color: 'var(--green)' }}>{conn.status}</span>
                  ) : (
                    <span style={{ color: 'var(--bone-2)' }}>not connected</span>
                  )}
                </td>
                <td>
                  {conn?.display_name ?? '—'}
                  {conn?.external_account_id ? (
                    <span
                      style={{
                        marginLeft: 8,
                        fontFamily: 'var(--f-mono)',
                        fontSize: 11,
                        color: 'var(--bone-2)',
                      }}
                    >
                      {conn.external_account_id}
                    </span>
                  ) : null}
                </td>
                <td className="nu">
                  {conn?.last_sync_at ? fmtRelative(conn.last_sync_at) : '—'}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {isLive && (
                      <button
                        className="btn"
                        disabled={busy === source}
                        onClick={() => connect(source)}
                        title={isConnected ? 'Re-authorize this source' : 'Authorize Linkbook on this source'}
                      >
                        {busy === source
                          ? '…'
                          : isConnected
                            ? 'Reconnect'
                            : 'Connect'}
                      </button>
                    )}
                    {isLive && isConnected && supportsTest && (
                      <button
                        className="btn"
                        disabled={busy === source}
                        onClick={() => smokeTest(source)}
                        title="Make a read-only call to verify the live connection"
                      >
                        Test
                      </button>
                    )}
                    {!isLive && !isConnected && (
                      <span style={{ fontSize: 11, color: 'var(--bone-2)' }}>—</span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {testResult && (
        <div
          style={{
            marginTop: 14,
            padding: 12,
            background: 'var(--ink-1)',
            border: '1px solid var(--rule)',
            fontFamily: 'var(--f-mono)',
            fontSize: 12,
            color: 'var(--bone-1)',
          }}
        >
          <b style={{ textTransform: 'uppercase', letterSpacing: '.16em', fontSize: 10 }}>
            {testResult.source}
          </b>
          <div style={{ marginTop: 6 }}>{testResult.text}</div>
        </div>
      )}

      <div className="section-head">
        <h3>Harvest → QuickBooks sync probe</h3>
        <div className="meta">§4.1</div>
      </div>
      <div style={{ background: 'var(--ink-1)', border: '1px solid var(--rule)', padding: 18 }}>
        <button className="btn" onClick={runProbe}>
          Run probe
        </button>
        {probeResult && (
          <span
            style={{
              marginLeft: 12,
              fontFamily: 'var(--f-mono)',
              fontSize: 11,
              color: 'var(--bone-2)',
              textTransform: 'uppercase',
              letterSpacing: '.16em',
            }}
          >
            {probeResult}
          </span>
        )}
      </div>
    </PageShell>
  );
}
