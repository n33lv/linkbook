import { useEffect, useState, useCallback } from 'react';
import { api } from './api';

export type Resource<T> =
  | { state: 'loading'; retry: () => void }
  | { state: 'ready'; data: T; refresh: () => void }
  | { state: 'error'; error: string; retry: () => void };

// Tiny single-purpose fetch hook. Loads on mount, polls every interval,
// surfaces a clean error state. No external deps.
export function useResource<T>(path: string, intervalMs = 5_000): Resource<T> {
  const [s, setS] = useState<{ data?: T; error?: string }>({});
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await api<T>(path);
      setS({ data: r });
    } catch (e) {
      setS({ error: (e as Error).message });
    }
  }, [path]);

  useEffect(() => {
    load();
    if (intervalMs > 0) {
      const t = setInterval(load, intervalMs);
      return () => clearInterval(t);
    }
    return undefined;
  }, [load, intervalMs, tick]);

  if (s.error !== undefined) return { state: 'error', error: s.error, retry: () => setTick((t) => t + 1) };
  if (s.data !== undefined) return { state: 'ready', data: s.data, refresh: () => setTick((t) => t + 1) };
  return { state: 'loading', retry: () => setTick((t) => t + 1) };
}
