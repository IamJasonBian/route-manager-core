import { useEffect, useState } from 'react';
import {
  appendTick,
  applySseFrame,
  EMPTY_SNAPSHOT,
  parseSseFrames,
  stopEventsUrl,
  type PriceTick,
  type StopRiskSnapshot,
} from '../services/stopEventStream';

export type PriceTicks = Record<string, PriceTick[]>;

function isTick(value: unknown): value is PriceTick {
  const t = value as PriceTick;
  return !!t && typeof t.symbol === 'string' && typeof t.price === 'number' && !!t.ts;
}

export function useStopEventStream(): {
  snapshot: StopRiskSnapshot;
  ticks: PriceTicks;
  connected: boolean;
  error: string | null;
} {
  const [snapshot, setSnapshot] = useState<StopRiskSnapshot>(EMPTY_SNAPSHOT);
  const [ticks, setTicks] = useState<PriceTicks>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Each EventSource reconnect (retry: 8000) delivers a fresh quote, so the
    // series grows into a live price line.
    const recordTicks = (incoming: PriceTick[]) => {
      if (!incoming.length) return;
      setTicks((prev) => {
        const next = { ...prev };
        for (const tick of incoming) next[tick.symbol] = appendTick(next[tick.symbol] || [], tick);
        return next;
      });
    };

    const url = stopEventsUrl('sse');
    let source: EventSource | null = null;
    let cancelled = false;

    const applyRaw = (event: string, ev: MessageEvent<string>) => {
      let data: unknown = ev.data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        /* keep string */
      }
      setSnapshot((prev) => applySseFrame(prev, { event, id: ev.lastEventId, data }));
      if (event === 'price' && isTick(data)) recordTicks([data]);
    };

    if (typeof EventSource !== 'undefined') {
      source = new EventSource(url);
      source.addEventListener('snapshot', (ev) => applyRaw('snapshot', ev as MessageEvent<string>));
      source.addEventListener('coverage', (ev) => applyRaw('coverage', ev as MessageEvent<string>));
      source.addEventListener('engine', (ev) => applyRaw('engine', ev as MessageEvent<string>));
      source.addEventListener('price', (ev) => applyRaw('price', ev as MessageEvent<string>));
      source.onopen = () => {
        if (!cancelled) {
          setConnected(true);
          setError(null);
        }
      };
      source.onerror = () => {
        if (!cancelled) setConnected(false);
      };
    } else {
      fetch(stopEventsUrl('json'))
        .then((r) => r.text())
        .then((text) => {
          if (cancelled) return;
          try {
            const snap = applySseFrame(EMPTY_SNAPSHOT, { event: 'snapshot', data: JSON.parse(text) });
            setSnapshot(snap);
            recordTicks(Object.values(snap.prices || {}));
          } catch {
            const frames = parseSseFrames(text);
            let next = EMPTY_SNAPSHOT;
            for (const frame of frames) next = applySseFrame(next, frame);
            setSnapshot(next);
          }
          setConnected(true);
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message);
        });
    }

    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  return { snapshot, ticks, connected, error };
}
