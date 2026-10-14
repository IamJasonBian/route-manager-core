export const DESIGNATED_SYMBOLS = ['MU', 'NBIS'] as const;
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
  type: 'risk' | 'activity' | string;
  id?: string;
  code?: string;
  symbol?: string;
  severity?: 'critical' | 'warning' | 'info' | string;
  message?: string;
  order_id?: string | null;
  event_type?: string;
  status?: string;
  quantity?: number;
  created_at?: string | null;
  uncovered_qty?: number;
  covered_qty?: number;
  weight_pct?: number;
  room_pct?: number;
}

export interface StopRiskSnapshot {
  as_of: string;
  names: CoverageName[];
  events: StopRiskEvent[];
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

export function applySseFrame(current: StopRiskSnapshot, frame: SseFrame): StopRiskSnapshot {
  if (frame.event === 'snapshot' && frame.data && typeof frame.data === 'object') {
    return frame.data as StopRiskSnapshot;
  }
  if (frame.event === 'coverage' && frame.data && typeof frame.data === 'object') {
    const name = frame.data as CoverageName;
    const rest = current.names.filter((n) => n.symbol !== name.symbol);
    return { ...current, names: [...rest, name] };
  }
  if ((frame.event === 'risk' || frame.event === 'activity') && frame.data && typeof frame.data === 'object') {
    const incoming = frame.data as StopRiskEvent;
    const key = incoming.id || `${incoming.code || incoming.type}-${incoming.symbol}`;
    const events = current.events.filter((e) => (e.id || `${e.code || e.type}-${e.symbol}`) !== key);
    return { ...current, events: [...events, incoming] };
  }
  return current;
}

export const EMPTY_SNAPSHOT: StopRiskSnapshot = { as_of: '', names: [], events: [] };

export function stopEventsUrl(format: 'sse' | 'json' = 'sse', base = '/.netlify/functions'): string {
  return `${base}/stop-events-sse?format=${format}`;
}
