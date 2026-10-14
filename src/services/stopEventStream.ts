export const DESIGNATED_SYMBOLS = ['MU', 'NBIS'] as const;
/** Engine events kept in the SSE tail. */
export const EVENT_TAIL = 120;
/** Live price points kept per symbol on the client. */
export const PRICE_TICK_CAP = 720;
export type DesignatedSymbol = (typeof DESIGNATED_SYMBOLS)[number];

export interface CoverageName {
  symbol: DesignatedSymbol | string;
  quantity: number;
  covered_qty: number;
  uncovered_qty: number;
  coverage_pct: number;
  trail_percent: number;
  coded_trail_percent: number;
  stop_price: number | null;
  last_trail_price: number | null;
  mark: number;
  avg_entry: number;
  equity: number;
  profit_loss: number;
  profit_loss_pct: number;
  stop_id: string | null;
  stop_type: string | null;
  stop_state: string | null;
}

export interface StopRiskEvent {
  type: 'engine' | string;
  id?: string;
  code?: string;
  symbol?: string;
  message?: string;
  order_id?: string | null;
  event_type?: string;
  status?: string;
  quantity?: number;
  created_at?: string | null;
  ts?: string | null;
  side?: string;
  order_type?: string;
  price?: number;
  limit_price?: number | null;
  stop_price?: number | null;
  filled_quantity?: number;
}

export interface PriceTick {
  symbol: string;
  price: number;
  ts: string;
}

export interface StopRiskSnapshot {
  as_of: string;
  names: CoverageName[];
  events: StopRiskEvent[];
  prices?: Record<string, PriceTick>;
}

export interface SseFrame {
  event: string;
  id?: string;
  data: unknown;
  retry?: number;
}

export function parseSseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  const blocks = raw.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = 'message';
    let id: string | undefined;
    let retry: number | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('retry:')) retry = Number(line.slice(6).trim());
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    let data: unknown = dataLines.join('\n');
    try {
      data = JSON.parse(String(data));
    } catch {
      /* keep raw string */
    }
    frames.push({ event, id, data, retry });
  }
  return frames;
}

export function eventTs(e: StopRiskEvent): number {
  const t = Date.parse(e.ts || e.created_at || '');
  return Number.isFinite(t) ? t : 0;
}

/** Newest `limit` events, newest first. */
export function tailEvents(events: StopRiskEvent[], limit = EVENT_TAIL): StopRiskEvent[] {
  return [...events].sort((a, b) => eventTs(b) - eventTs(a)).slice(0, limit);
}

/** Append a tick to a symbol's series, dropping duplicates and the oldest past `cap`. */
export function appendTick(series: PriceTick[], tick: PriceTick, cap = PRICE_TICK_CAP): PriceTick[] {
  if (series.length && series[series.length - 1].ts === tick.ts) return series;
  const next = [...series, tick];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function applySseFrame(current: StopRiskSnapshot, frame: SseFrame): StopRiskSnapshot {
  if (frame.event === 'snapshot' && frame.data && typeof frame.data === 'object') {
    const snap = frame.data as StopRiskSnapshot;
    return { ...snap, events: tailEvents(snap.events || []) };
  }
  if (frame.event === 'price' && frame.data && typeof frame.data === 'object') {
    const tick = frame.data as PriceTick;
    return { ...current, prices: { ...(current.prices || {}), [tick.symbol]: tick } };
  }
  if (frame.event === 'coverage' && frame.data && typeof frame.data === 'object') {
    const name = frame.data as CoverageName;
    const rest = current.names.filter((n) => n.symbol !== name.symbol);
    return { ...current, names: [...rest, name] };
  }
  if (frame.event === 'engine' && frame.data && typeof frame.data === 'object') {
    const incoming = frame.data as StopRiskEvent;
    const key = incoming.id || `${incoming.code}-${incoming.symbol}`;
    const events = current.events.filter((e) => (e.id || `${e.code}-${e.symbol}`) !== key);
    return { ...current, events: tailEvents([...events, incoming]) };
  }
  return current;
}

export const EMPTY_SNAPSHOT: StopRiskSnapshot = { as_of: '', names: [], events: [] };

export function stopEventsUrl(format: 'sse' | 'json' = 'sse', base = '/.netlify/functions'): string {
  return `${base}/stop-events-sse?format=${format}`;
}
