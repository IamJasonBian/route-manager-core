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
}

// Polls `fetcher` on an interval while `enabled` is true and the tab is
// visible. Skips ticks if a previous fetch is still in flight.
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

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (inFlightRef.current) return;

      inFlightRef.current = true;
      setIsRefreshing(true);
      try {
        await fetcherRef.current();
        if (!cancelled) setLastUpdated(new Date());
      } finally {
        inFlightRef.current = false;
        if (!cancelled) setIsRefreshing(false);
      }
    };

    const intervalId = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs]);

  return { isRefreshing, lastUpdated, markUpdated };
}
