import { useCallback, useEffect, useRef, useState } from 'react';

interface UseLivePollingOptions {
  enabled: boolean;
  intervalMs?: number;
  fetcher: () => Promise<void>;
}

interface UseLivePollingResult {
  isRefreshing: boolean;
  lastUpdated: Date | null;
  markUpdated: () => void;
  refresh: () => Promise<void>;
}

// Polls `fetcher` on an interval while `enabled` is true and the tab is
// visible. Skips ticks if a previous fetch is still in flight. `refresh`
// runs the fetcher on demand with the same in-flight guard.
export function useLivePolling({
  enabled,
  intervalMs = 5000,
  fetcher,
}: UseLivePollingOptions): UseLivePollingResult {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const fetcherRef = useRef(fetcher);
  const inFlightRef = useRef(false);

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  const markUpdated = useCallback(() => setLastUpdated(new Date()), []);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsRefreshing(true);
    try {
      await fetcherRef.current();
      if (mountedRef.current) setLastUpdated(new Date());
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refresh();
    };

    const intervalId = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(intervalId);
  }, [enabled, intervalMs, refresh]);

  return { isRefreshing, lastUpdated, markUpdated, refresh };
}
