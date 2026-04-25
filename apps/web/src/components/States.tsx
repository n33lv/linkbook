// Shared loading / error / empty states. Cohesive with the design system.

export function Loading({ label = 'loading' }: { label?: string }) {
  return <div className="loading">{label}…</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div
      style={{
        padding: 24,
        border: '1px solid var(--rule)',
        background: 'var(--ink-1)',
        fontFamily: 'var(--f-mono)',
        fontSize: 12,
        color: 'var(--bad)',
      }}
    >
      <div style={{ textTransform: 'uppercase', letterSpacing: '.18em', marginBottom: 8, color: 'var(--bone-3)' }}>
        couldn't load
      </div>
      <div style={{ color: 'var(--bone)' }}>{error}</div>
      {onRetry && (
        <button className="btn" onClick={onRetry} style={{ marginTop: 12 }}>
          Retry
        </button>
      )}
    </div>
  );
}
