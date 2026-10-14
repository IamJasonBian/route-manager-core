import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getIntradaySeries } from '../services/twelveDataService';
import { eventTs, type CoverageName, type PriceTick, type StopRiskEvent } from '../services/stopEventStream';

const BUY = '#10b981';
const SELL = '#ef4444';
const PRICE = '#71717a';
const STOP = '#f59e0b';
const LIVE = '#3b82f6';

interface PricePoint {
  t: number;
  price: number;
}

export interface EventPoint {
  t: number;
  price: number;
  event: StopRiskEvent;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS = { '1D': DAY_MS, '5D': 5 * DAY_MS, All: Infinity } as const;
type WindowKey = keyof typeof WINDOWS;

function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
}

function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

function fmtStamp(t: number): string {
  return `${fmtDay(t)}, ${fmtClock(t)}`;
}

/** Engine events for one symbol that carry a price and a timestamp. */
export function eventPoints(events: StopRiskEvent[], symbol: string): EventPoint[] {
  return events
    .filter((e) => e.symbol === symbol && (e.price ?? 0) > 0 && eventTs(e) > 0)
    .map((e) => ({ t: eventTs(e), price: e.price as number, event: e }))
    .sort((a, b) => a.t - b.t);
}

/** Symbols in the event tail, most active first, then designated names. */
export function chartSymbols(events: StopRiskEvent[], designated: string[]): string[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (!e.symbol) continue;
    counts.set(e.symbol, (counts.get(e.symbol) || 0) + 1);
  }
  const active = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  return [...new Set([...active, ...designated])];
}

/** Tag shape: ▲ buy, ▼ sell, ◆ stop; hollow until filled. */
function EventTag(props: { cx?: number; cy?: number; payload?: EventPoint }) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload) return null;
  const sell = payload.event.side === 'SELL';
  const color = sell ? SELL : BUY;
  const filled = payload.event.status === 'filled';
  const r = 6;
  const points =
    payload.event.order_type === 'stop'
      ? `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`
      : sell
        ? `${cx - r},${cy - r} ${cx + r},${cy - r} ${cx},${cy + r}`
        : `${cx - r},${cy + r} ${cx + r},${cy + r} ${cx},${cy - r}`;
  return (
    <polygon
      data-testid="event-tag"
      points={points}
      fill={filled ? color : 'var(--chart-surface, #09090b)'}
      stroke={color}
      strokeWidth={2}
      strokeLinejoin="round"
    />
  );
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: PricePoint | EventPoint }[] }) {
  if (!active || !payload?.length) return null;
  const hit = payload.find((p) => 'event' in p.payload)?.payload as EventPoint | undefined;
  const point = hit || (payload[0].payload as PricePoint);
  return (
    <div className="rounded border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-xs shadow-sm">
      <p className="text-gray-400 dark:text-zinc-500">{fmtStamp(point.t)} ET</p>
      {hit ? (
        <>
          <p className="font-medium text-gray-900 dark:text-white mt-0.5">{hit.event.message}</p>
          <p className="text-gray-500 dark:text-zinc-400">{hit.event.status}</p>
        </>
      ) : (
        <p className="font-medium text-gray-900 dark:text-white mt-0.5">${point.price.toFixed(2)}</p>
      )}
    </div>
  );
}

export default function EventPriceChart({
  events,
  ticks,
  names,
  designated,
  focusSymbol,
  loadBackfill = getIntradaySeries,
}: {
  events: StopRiskEvent[];
  ticks: Record<string, PriceTick[]>;
  names: CoverageName[];
  designated: string[];
  focusSymbol?: string;
  loadBackfill?: (symbol: string) => Promise<{ timestamp: number; price: number }[]>;
}) {
  const symbols = useMemo(() => chartSymbols(events, designated), [events, designated]);
  const [picked, setPicked] = useState<string | null>(null);
  const [windowKey, setWindowKey] = useState<WindowKey>('1D');
  const symbol = picked || (focusSymbol && symbols.includes(focusSymbol) ? focusSymbol : symbols[0]) || '';

  const [backfill, setBackfill] = useState<PricePoint[]>([]);
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    setBackfill([]);
    loadBackfill(symbol)
      .then((rows) => {
        if (!cancelled) setBackfill(rows.map((r) => ({ t: r.timestamp, price: r.price })));
      })
      .catch(() => {
        /* live ticks + event tags still render without a backfill */
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, loadBackfill]);

  const live = (ticks[symbol] || []).map((tk) => ({ t: Date.parse(tk.ts), price: tk.price }));
  const lastBackfill = backfill.length ? backfill[backfill.length - 1].t : 0;
  const since = Date.now() - WINDOWS[windowKey];
  // Kept as separate series: the engine quote and the 1-min closes come from
  // different sources and shouldn't be joined across the gap between them.
  const intraday = backfill.filter((p) => p.t >= since);
  const liveLine = live.filter((p) => p.t > lastBackfill && p.t >= since);
  const line = [...intraday, ...liveLine];
  const allTags = eventPoints(events, symbol);
  const tags = allTags.filter((p) => p.t >= since);
  const xs = [...line, ...tags].map((p) => p.t);
  const multiDay = xs.length > 1 && Math.max(...xs) - Math.min(...xs) > 1.5 * DAY_MS;
  const stop = names.find((n) => n.symbol === symbol)?.stop_price || null;
  const lastPrice = line.length ? line[line.length - 1].price : null;

  return (
    <div className="bg-white dark:bg-zinc-950 rounded-lg border border-gray-200 dark:border-zinc-800 p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">Engine events on price</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {tags.length} of {allTags.length} {symbol || '—'} events in the tail ({windowKey}) over the live quote
            {lastPrice != null && <> · ${lastPrice.toFixed(2)}</>}
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Time window">
          {(Object.keys(WINDOWS) as WindowKey[]).map((w) => (
            <button
              key={w}
              aria-pressed={w === windowKey}
              onClick={() => setWindowKey(w)}
              className={`text-xs px-2 py-1 rounded border ${
                w === windowKey
                  ? 'border-gray-900 dark:border-white text-gray-900 dark:text-white'
                  : 'border-gray-200 dark:border-zinc-800 text-gray-500 dark:text-zinc-400 hover:border-gray-400'
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-1 flex-wrap mb-3" role="tablist">
          {symbols.map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={s === symbol}
              onClick={() => setPicked(s)}
              className={`text-xs px-2 py-1 rounded border ${
                s === symbol
                  ? 'border-gray-900 dark:border-white text-gray-900 dark:text-white'
                  : 'border-gray-200 dark:border-zinc-800 text-gray-500 dark:text-zinc-400 hover:border-gray-400'
              }`}
            >
              {s}
            </button>
          ))}
      </div>

      <div className="flex gap-x-4 gap-y-1 flex-wrap text-xs text-gray-500 dark:text-zinc-400 mb-2">
        <span className="inline-flex items-center gap-1">
          <svg width="10" height="10"><polygon points="0,10 10,10 5,0" fill={BUY} /></svg> Buy
        </span>
        <span className="inline-flex items-center gap-1">
          <svg width="10" height="10"><polygon points="0,0 10,0 5,10" fill={SELL} /></svg> Sell
        </span>
        <span className="inline-flex items-center gap-1">
          <svg width="10" height="10"><polygon points="5,0 10,5 5,10 0,5" fill={PRICE} /></svg> Stop order
        </span>
        <span className="inline-flex items-center gap-1">
          <svg width="10" height="10"><polygon points="1,1 9,1 5,9" fill="none" stroke={PRICE} strokeWidth="1.5" /></svg> Open (hollow)
        </span>
        <span className="inline-flex items-center gap-1">
          <svg width="14" height="10"><line x1="0" y1="5" x2="14" y2="5" stroke={PRICE} strokeWidth="2" /></svg> 1-min close
        </span>
        <span className="inline-flex items-center gap-1">
          <svg width="14" height="10"><line x1="0" y1="5" x2="14" y2="5" stroke={LIVE} strokeWidth="2" /><circle cx="7" cy="5" r="2.5" fill={LIVE} /></svg> Engine quote (live)
        </span>
        {stop && (
          <span className="inline-flex items-center gap-1">
            <svg width="14" height="10"><line x1="0" y1="5" x2="14" y2="5" stroke={STOP} strokeWidth="2" strokeDasharray="3 2" /></svg> Trail stop
          </span>
        )}
      </div>

      <div className="h-72" data-testid="event-price-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 16, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" strokeOpacity={0.4} vertical={false} />
            <XAxis
              type="number"
              dataKey="t"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={multiDay ? fmtDay : fmtClock}
              stroke="#a1a1aa"
              fontSize={11}
              allowDuplicatedCategory={false}
            />
            <YAxis
              type="number"
              dataKey="price"
              domain={['auto', 'auto']}
              stroke="#a1a1aa"
              fontSize={11}
              width={56}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            />
            <Tooltip content={<ChartTooltip />} />
            {stop && <ReferenceLine y={stop} stroke={STOP} strokeWidth={2} strokeDasharray="4 3" />}
            <Line
              data={intraday}
              dataKey="price"
              stroke={PRICE}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              name="1-min close"
            />
            <Line
              data={liveLine}
              dataKey="price"
              stroke={LIVE}
              strokeWidth={2}
              dot={{ r: 3, fill: LIVE, strokeWidth: 0 }}
              isAnimationActive={false}
              name="Engine quote"
            />
            <Scatter data={tags} dataKey="price" shape={<EventTag />} isAnimationActive={false} name="Events" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {tags.length === 0 && allTags.length > 0 && (
        <p className="text-xs text-gray-400 dark:text-zinc-600 mt-2">
          No {symbol} events in the last {windowKey} — switch to All to see the full tail.
        </p>
      )}
      {line.length === 0 && (
        <p className="text-xs text-gray-400 dark:text-zinc-600 mt-2">
          Waiting for live quotes — tags are placed at each order's fill / limit / stop price.
        </p>
      )}
    </div>
  );
}
