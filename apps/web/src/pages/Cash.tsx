import type { CashView } from '../lib/types';
import { fmtCents, fmtRelative } from '../lib/format';
import { useResource } from '../lib/useResource';
import { Loading, ErrorState } from '../components/States';

export function Cash() {
  const r = useResource<CashView>('/dashboard/cash', 0);
  if (r.state === 'loading') return <PageShell title="Cash"><Loading /></PageShell>;
  if (r.state === 'error') return <PageShell title="Cash"><ErrorState error={r.error} onRetry={r.retry} /></PageShell>;
  const data = r.data;
  return (
    <PageShell title="Cash" subtitle="A/R · QTD · DSO" lastSync={data.last_synced_at}>
      <div className="stat-grid cols-3">
        <Stat label="Outstanding A/R" value={fmtCents(data.ar_total_cents, { compact: true })} signal />
        <Stat label="QTD revenue · cash" value={fmtCents(data.qtd_revenue_cash_cents, { compact: true })} />
        <Stat label="Avg time-to-payment" value={`${data.avg_days_to_payment}d`} />
      </div>

      <div className="two-col">
        <div>
          <div className="section-head">
            <h3>A/R aging</h3>
            <div className="meta">QBO</div>
          </div>
          <AgingBuckets buckets={data.ar_aging} />
        </div>
        <div>
          <div className="section-head">
            <h3>Top outstanding</h3>
            <div className="meta">click → invoice</div>
          </div>
          <div className="top-list">
            {data.top_outstanding.map((inv, i) => (
              <div className="row" key={inv.invoice_id}>
                <span className="rk">{['I', 'II', 'III', 'IV', 'V'][i]}</span>
                <span className="who">
                  <b>{inv.client_name ?? 'Unknown'}</b>
                  <br />
                  <span>{inv.number}</span>
                </span>
                <span className={`age ${inv.days_overdue < 30 ? 'warn' : ''}`}>{inv.days_overdue}d</span>
                <span className="amt">{fmtCents(inv.amount_cents)}</span>
              </div>
            ))}
            {data.top_outstanding.length === 0 && <div className="empty">no outstanding invoices</div>}
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function AgingBuckets({ buckets }: { buckets: CashView['ar_aging'] }) {
  const max = Math.max(buckets['0_30'], buckets['31_60'], buckets['61_90'], buckets['90_plus'], 1);
  const pct = (n: number) => Math.max(2, Math.round((n / max) * 100));
  return (
    <div className="aging-buckets">
      <Bucket label="0–30d" value={buckets['0_30']} h={pct(buckets['0_30'])} />
      <Bucket label="31–60" value={buckets['31_60']} h={pct(buckets['31_60'])} cls="b30" />
      <Bucket label="61–90" value={buckets['61_90']} h={pct(buckets['61_90'])} cls="b60" />
      <Bucket label="90+" value={buckets['90_plus']} h={pct(buckets['90_plus'])} cls="b90" />
    </div>
  );
}

function Bucket({ label, value, h, cls }: { label: string; value: number; h: number; cls?: string }) {
  return (
    <div className={`bucket ${cls ?? ''}`}>
      <div className="bar" style={{ height: `${h}%` }} />
      <div className="v">{fmtCents(value, { compact: true })}</div>
      <div className="k">{label}</div>
    </div>
  );
}

export function Stat({ label, value, signal, delta }: { label: string; value: string; signal?: boolean; delta?: string }) {
  return (
    <div className="stat">
      <div className="lbl">{label}</div>
      <div className={`num ${signal ? 'signal' : ''}`}>{value}</div>
      {delta && <div className="delta">{delta}</div>}
    </div>
  );
}

export function PageShell({ title, subtitle, lastSync, children }: { title: string; subtitle?: string; lastSync?: string; children: React.ReactNode }) {
  return (
    <>
      <div className="topbar">
        <h1>
          {title}
          {subtitle && <small>{subtitle}</small>}
        </h1>
        {lastSync && (
          <div className="topbar-right">
            <span>last sync · {fmtRelative(lastSync)}</span>
          </div>
        )}
      </div>
      <div className="page">{children}</div>
    </>
  );
}
