// Charts and tables for the Ticker P&L page (pages/TickerPnLPage.tsx).

import { useMemo, type ReactNode } from 'react';
import {
  AreaChart,
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { useTheme } from '../contexts/ThemeContext';
import { formatCurrency, getGainColor } from '../services/robinhoodService';
import type {
  DailyPnlPoint,
  StockFill,
  OptionFill,
  QueueSummary,
  PriceBar,
} from '../utils/tickerPnl';
import type { OptionPosition } from '../services/robinhoodService';
import { optionPositionKey } from '../utils/tickerPnl';
import { formatSignedUsd, formatSignedFraction } from '../utils/formatters';

// Categorical slots (validated for CVD + contrast in both themes)
const SERIES = {
  light: { buy: '#2a78d6', sell: '#eb6834', avg: '#6250d6', price: '#71717a', pnl: '#27272a', surface: '#ffffff', axis: '#6B7280', grid: '#E5E7EB' },
  dark:  { buy: '#3987e5', sell: '#d95926', avg: '#9085e9', price: '#a1a1aa', pnl: '#e4e4e7', surface: '#18181b', axis: '#a1a1aa', grid: '#27272a' },
};

function usePalette() {
  const { isDark } = useTheme();
  return isDark ? SERIES.dark : SERIES.light;
}

const fmtSigned = formatSignedUsd;
const fmtPct = formatSignedFraction;

function fmtCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(4).replace(/0+$/, '');
}

function fmtDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });
}

// ─── Layout primitives ────────────────────────────────────────────────────────

export function Card({ title, subtitle, right, children }: { title: string; subtitle?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-zinc-700 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function StatTile({ label, value, sub, tone, title }: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Colors the value by sign when given */
  tone?: number | null;
  title?: string;
}) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 p-4" title={title}>
      <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      <div className={`text-xl sm:text-2xl font-semibold ${tone !== undefined ? getGainColor(tone) : 'text-gray-900 dark:text-gray-100'}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

const TH = 'px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap';
const TD = 'px-3 py-2 text-sm whitespace-nowrap tabular-nums';
const ROW = 'border-t border-gray-100 dark:border-zinc-800';

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-center text-gray-500 dark:text-gray-400">{children}</p>;
}

function SideBadge({ side, effect }: { side: 'BUY' | 'SELL'; effect?: string | null }) {
  const p = usePalette();
  return (
    <span className="inline-flex items-center gap-1.5 font-medium text-gray-900 dark:text-gray-100">
      <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: side === 'BUY' ? p.buy : p.sell }} aria-hidden />
      {side === 'BUY' ? 'Buy' : 'Sell'}
      {effect && <span className="text-xs font-normal text-gray-500 dark:text-gray-400">to {effect}</span>}
    </span>
  );
}

// ─── Cumulative P&L chart ─────────────────────────────────────────────────────

export function CumulativePnlChart({ points }: { points: DailyPnlPoint[] }) {
  const p = usePalette();
  if (!points.length) return <Empty>No daily P&amp;L yet — needs at least one fill and a price history.</Empty>;

  const PnlTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: DailyPnlPoint }> }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-lg p-3 text-sm">
        <p className="text-gray-500 dark:text-gray-400 mb-1">{fmtDate(d.date)}{d.live ? ' · live' : ''}</p>
        <p className="text-gray-900 dark:text-gray-100">Cumulative <span className={`font-medium ${getGainColor(d.cumulative)}`}>{fmtSigned(d.cumulative)}</span></p>
        <p className="text-gray-900 dark:text-gray-100">Day <span className={`font-medium ${getGainColor(d.pnl)}`}>{d.baseline ? 'baseline' : fmtSigned(d.pnl)}</span></p>
        <p className="text-gray-500 dark:text-gray-400">{fmtQty(d.shares)} sh · close {formatCurrency(d.close)}</p>
        {(d.bought > 0 || d.sold > 0) && (
          <p className="text-gray-500 dark:text-gray-400">
            {d.bought > 0 && `bought ${fmtQty(d.bought)}`}{d.bought > 0 && d.sold > 0 && ' · '}{d.sold > 0 && `sold ${fmtQty(d.sold)}`}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="p-2 sm:p-4">
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={p.grid} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} stroke={p.axis} tick={{ fontSize: 11 }} tickLine={false} minTickGap={24} />
          <YAxis tickFormatter={fmtCompact} stroke={p.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
          <ReferenceLine y={0} stroke={p.axis} />
          <Tooltip content={<PnlTooltip />} cursor={{ stroke: p.axis, strokeWidth: 1 }} />
          <Area
            type="linear"
            dataKey="cumulative"
            name="Cumulative P&L"
            stroke={p.pnl}
            strokeWidth={2}
            fill={p.pnl}
            fillOpacity={0.1}
            dot={false}
            activeDot={{ r: 4, stroke: p.surface, strokeWidth: 2, fill: p.pnl }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Price, average cost & fills ──────────────────────────────────────────────

interface PriceRow {
  t: number;
  close: number | null;
  avg: number | null;
  /** Fill price on fill rows, by side — plotted as markers */
  buy: number | null;
  sell: number | null;
  fill: StockFill | null;
}

const CLOSE_UTC_HOUR = 20; // 4pm New York (EDT) — bars are plotted at the close

function barTime(date: string): number {
  return Date.parse(`${date}T${CLOSE_UTC_HOUR}:00:00Z`);
}

function Triangle({ cx, cy, fill, ring, up }: { cx?: number; cy?: number; fill: string; ring: string; up: boolean }) {
  if (cx == null || cy == null) return null;
  const s = 6;
  const d = up
    ? `M${cx},${cy - s} L${cx + s},${cy + s * 0.8} L${cx - s},${cy + s * 0.8} Z`
    : `M${cx},${cy + s} L${cx + s},${cy - s * 0.8} L${cx - s},${cy - s * 0.8} Z`;
  return <path d={d} fill={fill} stroke={ring} strokeWidth={2} strokeLinejoin="round" />;
}

export function PriceFillsChart({ symbol, bars, fills, livePrice }: {
  symbol: string;
  bars: PriceBar[];
  fills: StockFill[];
  livePrice: number | null;
}) {
  const p = usePalette();

  // One row per close and per fill, all on a shared time axis. Every series
  // reads from these rows (no per-series data), so the axis domain and the
  // tooltip both see every point.
  const rows = useMemo(() => {
    if (!fills.length) return [] as PriceRow[];
    const firstFill = fills[0].date;
    // A week of context before the first fill
    const idx = bars.findIndex(b => b.date >= firstFill);
    const start = idx < 0 ? Math.max(bars.length - 5, 0) : Math.max(idx - 5, 0);

    const out: PriceRow[] = bars.slice(start).map(b => ({ t: barTime(b.date), close: b.close, avg: null, buy: null, sell: null, fill: null }));
    for (const f of fills) {
      out.push({ t: f.time, close: null, avg: null, buy: f.side === 'BUY' ? f.price : null, sell: f.side === 'SELL' ? f.price : null, fill: f });
    }
    const now = Date.now();
    out.sort((a, b) => a.t - b.t);
    if (livePrice && now > out[out.length - 1].t) out.push({ t: now, close: livePrice, avg: null, buy: null, sell: null, fill: null });

    // Carry the position's average cost forward; null while flat
    let fi = 0;
    let avg: number | null = null;
    for (const row of out) {
      while (fi < fills.length && fills[fi].time <= row.t) {
        const f = fills[fi++];
        avg = f.shares_after > 0 && f.avg_cost_after > 0 ? f.avg_cost_after : null;
      }
      row.avg = avg;
    }
    return out;
  }, [bars, fills, livePrice]);

  if (!rows.length) return <Empty>No fills to plot.</Empty>;

  const PriceTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: PriceRow }> }) => {
    if (!active || !payload?.length) return null;
    const row = payload[0].payload;
    return (
      <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-lg p-3 text-sm max-w-xs">
        <p className="text-gray-500 dark:text-gray-400 mb-1">{fmtTime(row.t)}</p>
        {row.close != null && <p className="text-gray-900 dark:text-gray-100">{symbol} {formatCurrency(row.close)}</p>}
        {row.fill && (
          <p className="text-gray-900 dark:text-gray-100">
            <SideBadge side={row.fill.side} /> {fmtQty(row.fill.quantity)} @ {formatCurrency(row.fill.price)}
            {row.fill.realized != null && <span className={`ml-1 ${getGainColor(row.fill.realized)}`}>{fmtSigned(row.fill.realized)}</span>}
          </p>
        )}
        {row.avg != null && <p className="text-gray-500 dark:text-gray-400">Avg cost {formatCurrency(row.avg)}</p>}
      </div>
    );
  };

  const legend = [
    { label: `${symbol} close`, swatch: <span className="inline-block w-4 h-0.5" style={{ backgroundColor: p.price }} /> },
    { label: 'Average cost', swatch: <span className="inline-block w-4 h-0.5" style={{ backgroundColor: p.avg }} /> },
    { label: 'Buy', swatch: <svg width="12" height="12" aria-hidden><path d="M6,1 L11,10 L1,10 Z" fill={p.buy} /></svg> },
    { label: 'Sell', swatch: <svg width="12" height="12" aria-hidden><path d="M6,11 L11,2 L1,2 Z" fill={p.sell} /></svg> },
  ];

  return (
    <div className="p-2 sm:p-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-2 pb-2 text-xs text-gray-600 dark:text-gray-400">
        {legend.map(l => <span key={l.label} className="inline-flex items-center gap-1.5">{l.swatch}{l.label}</span>)}
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={p.grid} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[rows[0].t, rows[rows.length - 1].t]}
            tickFormatter={(t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}
            stroke={p.axis}
            tick={{ fontSize: 11 }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            stroke={p.axis}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <Tooltip content={<PriceTooltip />} cursor={{ stroke: p.axis, strokeWidth: 1 }} />
          <Line dataKey="close" name={`${symbol} close`} stroke={p.price} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          <Line dataKey="avg" name="Average cost" type="stepAfter" stroke={p.avg} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
          {/* Fill markers: stroke-less series that only draw a dot where a fill exists */}
          <Line dataKey="buy" name="Buy" stroke="none" legendType="none" activeDot={false} isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; index?: number; value?: number | null }) => <Triangle key={`b${props.index}`} cx={props.value == null ? undefined : props.cx} cy={props.cy} fill={p.buy} ring={p.surface} up />} />
          <Line dataKey="sell" name="Sell" stroke="none" legendType="none" activeDot={false} isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; index?: number; value?: number | null }) => <Triangle key={`s${props.index}`} cx={props.value == null ? undefined : props.cx} cy={props.cy} fill={p.sell} ring={p.surface} up={false} />} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Tables ───────────────────────────────────────────────────────────────────

export function StockFillsTable({ fills }: { fills: StockFill[] }) {
  if (!fills.length) return <Empty>No filled stock orders.</Empty>;
  const rows = [...fills].reverse();
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-50 dark:bg-zinc-800">
          <tr>
            <th className={`${TH} text-left`}>Filled (ET)</th>
            <th className={`${TH} text-left`}>Side</th>
            <th className={`${TH} text-left`}>Type</th>
            <th className={`${TH} text-right`}>Qty</th>
            <th className={`${TH} text-right`}>Price</th>
            <th className={`${TH} text-right`}>Amount</th>
            <th className={`${TH} text-right`}>Position</th>
            <th className={`${TH} text-right`}>Avg cost</th>
            <th className={`${TH} text-right`}>Realized</th>
            <th className={`${TH} text-right`}>Cum. realized</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(f => (
            <tr key={f.order_id} className={ROW}>
              <td className={`${TD} text-gray-600 dark:text-gray-400`}>{fmtTime(f.time)}</td>
              <td className={TD}><SideBadge side={f.side} /></td>
              <td className={`${TD} text-gray-600 dark:text-gray-400`}>{f.kind}{f.partial && <span className="ml-1 text-xs">(partial)</span>}</td>
              <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{fmtQty(f.quantity)}</td>
              <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{formatCurrency(f.price)}</td>
              <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{f.side === 'BUY' ? '−' : '+'}{formatCurrency(f.notional)}</td>
              <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{fmtQty(f.shares_after)}</td>
              <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{f.avg_cost_after > 0 ? formatCurrency(f.avg_cost_after) : '—'}</td>
              <td className={`${TD} text-right font-medium ${getGainColor(f.realized)}`} title={f.unmatched_quantity > 0 ? `${fmtQty(f.unmatched_quantity)} sh had no tracked cost basis` : undefined}>
                {f.side === 'SELL' ? fmtSigned(f.realized) : ''}
                {f.unmatched_quantity > 0 && <span className="ml-1 text-xs text-gray-500">*</span>}
              </td>
              <td className={`${TD} text-right ${getGainColor(f.cumulative_realized)}`}>{fmtSigned(f.cumulative_realized)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OptionFillsTable({ fills }: { fills: OptionFill[] }) {
  if (!fills.length) return <Empty>No filled option orders.</Empty>;
  const rows = [...fills].reverse();
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-50 dark:bg-zinc-800">
          <tr>
            <th className={`${TH} text-left`}>Filled (ET)</th>
            <th className={`${TH} text-left`}>Contract</th>
            <th className={`${TH} text-left`}>Side</th>
            <th className={`${TH} text-right`}>Contracts</th>
            <th className={`${TH} text-right`}>Price</th>
            <th className={`${TH} text-right`}>Premium</th>
            <th className={`${TH} text-right`}>Realized</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(f => (
            <tr key={f.order_id} className={ROW}>
              <td className={`${TD} text-gray-600 dark:text-gray-400`}>{f.expired ? `${fmtDate(f.date)} · expired` : fmtTime(f.time)}</td>
              <td className={`${TD} text-gray-900 dark:text-gray-100`}>{f.contract.label}</td>
              <td className={TD}><SideBadge side={f.side} effect={f.position_effect} /></td>
              <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{fmtQty(f.quantity)}</td>
              <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{f.expired ? '—' : formatCurrency(f.price)}</td>
              <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{f.expired ? '—' : fmtSigned(f.cash)}</td>
              <td className={`${TD} text-right font-medium ${getGainColor(f.realized)}`}>{f.realized != null ? fmtSigned(f.realized) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function stateLabel(state: string | null | undefined, untracked: boolean): string {
  if (untracked) return 'unconfirmed stub';
  return (state || 'unknown').replace(/_/g, ' ');
}

/** Live market for a working option order (Alpaca snapshot + vol surface). */
export interface OptionMarketView {
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  mid: number | null;
  iv: number | null;
  iv_source: 'contract' | 'surface' | null;
  delta: number | null;
  /** ±1σ fractional move of the underlying by expiry implied by `iv` */
  expected_move: number | null;
  /** Fractional move the underlying needs to reach breakeven at expiry */
  needed_move: number | null;
}

export function QueuedOrdersTables({ queue, livePrice, optionMarket }: {
  queue: QueueSummary;
  livePrice: number | null;
  optionMarket?: Map<string, OptionMarketView>;
}) {
  if (!queue.stock.length && !queue.options.length) return <Empty>No working orders.</Empty>;
  return (
    <div className="divide-y divide-gray-200 dark:divide-zinc-700">
      {queue.stock.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-zinc-800">
              <tr>
                <th className={`${TH} text-left`}>Stock order</th>
                <th className={`${TH} text-left`}>Type</th>
                <th className={`${TH} text-left`}>State</th>
                <th className={`${TH} text-right`}>Qty</th>
                <th className={`${TH} text-right`}>Price</th>
                <th className={`${TH} text-right`}>vs. last</th>
                <th className={`${TH} text-right`}>Notional</th>
                <th className={`${TH} text-right`}>If filled</th>
              </tr>
            </thead>
            <tbody>
              {queue.stock.map(q => (
                <tr key={q.order.order_id} className={ROW}>
                  <td className={TD}><SideBadge side={q.side} /></td>
                  <td className={`${TD} text-gray-600 dark:text-gray-400`}>{q.kind}</td>
                  <td className={`${TD} text-gray-600 dark:text-gray-400`}>{stateLabel(q.order.state, q.untracked)}</td>
                  <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{fmtQty(q.remaining)}</td>
                  <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{q.price != null ? formatCurrency(q.price) : '—'}</td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{fmtPct(q.distance_pct)}</td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{q.notional != null ? formatCurrency(q.notional) : '—'}</td>
                  <td className={`${TD} text-right`}>
                    {q.side === 'BUY'
                      ? <span className="text-gray-600 dark:text-gray-400">{q.avg_cost_after != null ? `avg ${formatCurrency(q.avg_cost_after)}` : '—'}</span>
                      : <span className={`font-medium ${getGainColor(q.projected_realized)}`}>{q.projected_realized != null ? `${fmtSigned(q.projected_realized)} realized` : '—'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {queue.options.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-zinc-800">
              <tr>
                <th className={`${TH} text-left`}>Option order</th>
                <th className={`${TH} text-left`}>Side</th>
                <th className={`${TH} text-left`}>State</th>
                <th className={`${TH} text-right`}>Contracts</th>
                <th className={`${TH} text-right`}>Limit</th>
                <th className={`${TH} text-right`}>Premium</th>
                <th className={`${TH} text-right`}>Bid × size</th>
                <th className={`${TH} text-right`}>Ask × size</th>
                <th className={`${TH} text-right`}>Limit vs mid</th>
                <th className={`${TH} text-right`}>IV</th>
                <th className={`${TH} text-right`}>Delta</th>
                <th className={`${TH} text-right`}>Breakeven</th>
                <th className={`${TH} text-right`}>To strike</th>
                <th className={`${TH} text-right`} title="±1σ move of the underlying by expiry implied by the IV">1σ move to exp.</th>
                <th className={`${TH} text-right`} title="Move needed to breakeven, in implied standard deviations">Needs</th>
                <th className={`${TH} text-right`}>DTE</th>
              </tr>
            </thead>
            <tbody>
              {queue.options.map(q => {
                const m = optionMarket?.get(q.order.order_id);
                const vsMid = m?.mid ? (q.limit_price - m.mid) / m.mid : null;
                const sigmas = m?.needed_move != null && m.expected_move ? m.needed_move / m.expected_move : null;
                return (
                <tr key={q.order.order_id} className={ROW}>
                  <td className={`${TD} text-gray-900 dark:text-gray-100`}>{q.contract.label}</td>
                  <td className={TD}><SideBadge side={q.side} effect={q.position_effect} /></td>
                  <td className={`${TD} text-gray-600 dark:text-gray-400`}>{stateLabel(q.order.state, q.untracked)}</td>
                  <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{fmtQty(q.quantity)}</td>
                  <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{formatCurrency(q.limit_price)}</td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{q.side === 'BUY' ? '−' : '+'}{formatCurrency(q.premium)}</td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{m?.bid != null ? `${formatCurrency(m.bid)} × ${m.bid_size ?? '—'}` : '—'}</td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{m?.ask != null ? `${formatCurrency(m.ask)} × ${m.ask_size ?? '—'}` : '—'}</td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`} title={m?.mid ? `Mid ${formatCurrency(m.mid)}` : undefined}>{fmtPct(vsMid)}</td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`} title={m?.iv_source === 'surface' ? 'Interpolated from the vol surface' : 'Contract IV (Alpaca indicative feed)'}>
                    {m?.iv != null ? `${(m.iv * 100).toFixed(1)}%` : '—'}{m?.iv_source === 'surface' && <span className="ml-0.5 text-xs">*</span>}
                  </td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{m?.delta != null ? m.delta.toFixed(2) : '—'}</td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>
                    {q.breakeven != null ? formatCurrency(q.breakeven) : '—'}
                    {q.breakeven != null && livePrice ? <span className="ml-1 text-xs">({fmtPct((q.breakeven - livePrice) / livePrice)})</span> : null}
                  </td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{fmtPct(q.to_strike_pct)}</td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{m?.expected_move != null ? `±${(m.expected_move * 100).toFixed(1)}%` : '—'}</td>
                  <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{sigmas != null ? `${sigmas.toFixed(2)}σ` : '—'}</td>
                  <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{q.dte ?? '—'}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function OptionPositionsTable({ positions }: { positions: OptionPosition[] }) {
  if (!positions.length) return <Empty>No open option positions.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-50 dark:bg-zinc-800">
          <tr>
            <th className={`${TH} text-left`}>Contract</th>
            <th className={`${TH} text-right`}>Qty</th>
            <th className={`${TH} text-right`}>Avg</th>
            <th className={`${TH} text-right`}>Mark</th>
            <th className={`${TH} text-right`}>Value</th>
            <th className={`${TH} text-right`}>Unrealized</th>
            <th className={`${TH} text-right`}>Delta</th>
            <th className={`${TH} text-right`}>Theta/day</th>
            <th className={`${TH} text-right`}>DTE</th>
          </tr>
        </thead>
        <tbody>
          {positions.map(pos => {
            const strike = Number(pos.strike_price ?? pos.strike);
            const exp = pos.expiration_date ?? pos.expiration ?? '';
            const short = (pos.position_type || '').toLowerCase() === 'short';
            return (
              <tr key={optionPositionKey(pos) + (pos.position_type ?? '')} className={ROW}>
                <td className={`${TD} text-gray-900 dark:text-gray-100`}>
                  {short ? 'Short ' : ''}${Number.isFinite(strike) ? strike : '?'} {(pos.option_type || '').toLowerCase() === 'put' ? 'Put' : 'Call'} {exp ? fmtDate(exp) : ''}
                </td>
                <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{fmtQty(Number(pos.quantity) || 0)}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{pos.avg_price != null ? formatCurrency(pos.avg_price) : '—'}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{pos.mark_price != null ? formatCurrency(pos.mark_price) : '—'}</td>
                <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{formatCurrency(pos.current_value)}</td>
                <td className={`${TD} text-right font-medium ${getGainColor(pos.unrealized_pl)}`}>{fmtSigned(pos.unrealized_pl)}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{pos.greeks?.delta != null ? pos.greeks.delta.toFixed(2) : '—'}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{pos.expected_pl?.theta_daily != null ? fmtSigned(pos.expected_pl.theta_daily) : '—'}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{pos.dte ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DailyPnlTable({ points }: { points: DailyPnlPoint[] }) {
  if (!points.length) return null;
  return (
    <details className="group">
      <summary className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 cursor-pointer select-none hover:text-gray-900 dark:hover:text-gray-200">
        Daily P&amp;L table ({points.length} days)
      </summary>
      <div className="overflow-x-auto max-h-96">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-zinc-800 sticky top-0">
            <tr>
              <th className={`${TH} text-left`}>Date</th>
              <th className={`${TH} text-right`}>Close</th>
              <th className={`${TH} text-right`}>Shares</th>
              <th className={`${TH} text-right`}>Bought</th>
              <th className={`${TH} text-right`}>Sold</th>
              <th className={`${TH} text-right`}>Market value</th>
              <th className={`${TH} text-right`}>Day P&amp;L</th>
              <th className={`${TH} text-right`}>Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {[...points].reverse().map(d => (
              <tr key={d.date} className={ROW}>
                <td className={`${TD} text-gray-600 dark:text-gray-400`}>{fmtDate(d.date)}{d.live ? ' (live)' : ''}</td>
                <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{formatCurrency(d.close)}</td>
                <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{fmtQty(d.shares)}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{d.bought ? fmtQty(d.bought) : ''}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{d.sold ? fmtQty(d.sold) : ''}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{formatCurrency(d.market_value)}</td>
                <td className={`${TD} text-right font-medium ${getGainColor(d.pnl)}`}>{d.baseline ? 'baseline' : fmtSigned(d.pnl)}</td>
                <td className={`${TD} text-right ${getGainColor(d.cumulative)}`}>{fmtSigned(d.cumulative)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
