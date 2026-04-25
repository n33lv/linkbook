// Display helpers shared across pages.

export function fmtCents(cents: number, opts?: { compact?: boolean }): string {
  if (cents === 0) return '$0';
  const dollars = cents / 100;
  if (opts?.compact && Math.abs(dollars) >= 10_000) {
    return '$' + (dollars / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function fmtRelative(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
