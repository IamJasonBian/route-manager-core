// Vol-calibration and fill-quality panels for the Ticker P&L page.

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { useTheme } from '../contexts/ThemeContext';
import { formatCurrency, getGainColor } from '../services/robinhoodService';
import { formatSignedUsd, formatBps as fmtBps } from '../utils/formatters';
import type { VarBacktest, VarBacktestDay } from '../utils/volCalibration';
import { PLACEMENT_LABEL, type FillAssessment, type FillQualitySummary, type Placement } from '../utils/fillQuality';
import { depthProfile, type ExecutionDepth, type DepthProfile } from '../utils/executionDepth';
import { getExecutionDepth } from '../services/marketContextService';
import type { StockFill } from '../utils/tickerPnl';

const PALETTE = {
  light: { gain: '#16a34a', loss: '#dc2626', lossMuted: '#fca5a5', gainMuted: '#86efac', var: '#27272a', axis: '#6B7280', grid: '#E5E7EB' },
  dark:  { gain: '#22c55e', loss: '#ef4444', lossMuted: '#7f1d1d', gainMuted: '#14532d', var: '#e4e4e7', axis: '#a1a1aa', grid: '#27272a' },
};

const TH = 'px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap';
const TD = 'px-3 py-2 text-sm whitespace-nowrap tabular-nums';
const ROW = 'border-t border-gray-100 dark:border-zinc-800';

function fmtDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function fmtCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function costColor(v: number | null | undefined): string {
  // + = cost (bad), − = improvement (good)
  return getGainColor(v == null ? null : -v);
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-center text-gray-500 dark:text-gray-400">{children}</p>;
}

// ─── VaR backtest chart ───────────────────────────────────────────────────────

export function VarBacktestChart({ backtest }: { backtest: VarBacktest }) {
  const { isDark } = useTheme();
  const p = isDark ? PALETTE.dark : PALETTE.light;
  if (!backtest.days.length) return <Empty>No days with a position held overnight yet, so there's nothing to backtest.</Empty>;
  const data = backtest.days.map(d => ({ ...d, neg_var: -d.var95 }));

  const VarTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: VarBacktestDay }> }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-lg p-3 text-sm">
        <p className="text-gray-500 dark:text-gray-400 mb-1">{fmtDate(d.date)}{d.exceeded ? ' · VaR breach' : ''}</p>
        <p className="text-gray-900 dark:text-gray-100">Day P&amp;L <span className={`font-medium ${getGainColor(d.pnl)}`}>{formatSignedUsd(d.pnl)}</span></p>
        <p className="text-gray-900 dark:text-gray-100">VaR 95% {formatCurrency(d.var95)}</p>
        <p className="text-gray-500 dark:text-gray-400">{formatCurrency(d.exposure)} held · σ {(d.sigma * 100).toFixed(2)}%/day</p>
      </div>
    );
  };

  return (
    <div className="p-2 sm:p-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-2 pb-2 text-xs text-gray-600 dark:text-gray-400">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: p.gainMuted }} />Day P&amp;L</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: p.loss }} />VaR breach</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-0.5" style={{ backgroundColor: p.var }} />−VaR 95% (from prior close)</span>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={p.grid} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} stroke={p.axis} tick={{ fontSize: 11 }} tickLine={false} minTickGap={24} />
          <YAxis tickFormatter={fmtCompact} stroke={p.axis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
          <ReferenceLine y={0} stroke={p.axis} />
          <Tooltip content={<VarTooltip />} cursor={{ fill: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }} />
          <Bar dataKey="pnl" name="Day P&L" maxBarSize={24} isAnimationActive={false}>
            {data.map(d => (
              <Cell key={d.date} fill={d.exceeded ? p.loss : d.pnl >= 0 ? p.gainMuted : p.lossMuted} />
            ))}
          </Bar>
          <Line dataKey="neg_var" name="−VaR 95%" type="stepAfter" stroke={p.var} strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Fill quality ─────────────────────────────────────────────────────────────

const SESSION_LABEL: Record<string, string> = {
  regular: 'Regular', pre: 'Pre-market', post: 'After hours', overnight: 'Overnight', closed: 'Closed', unknown: '—',
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' });
}

function fmtAge(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function fmtSize(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US');
}

function PlacementBadge({ placement }: { placement: Placement }) {
  const tone: Record<Placement, string> = {
    better: 'text-green-700 dark:text-green-400',
    inside: 'text-green-700 dark:text-green-400',
    touch: 'text-gray-700 dark:text-gray-300',
    through: 'text-red-600 dark:text-red-400',
    stale: 'text-amber-600 dark:text-amber-400',
    'no-quote': 'text-gray-500 dark:text-gray-400',
  };
  return <span className={tone[placement]}>{PLACEMENT_LABEL[placement]}</span>;
}

export function FillQualityGroups({ summary }: { summary: FillQualitySummary }) {
  const groups = [
    ...summary.by_kind.map(g => ({ ...g, dim: 'Order type', label: g.key })),
    ...summary.by_session.map(g => ({ ...g, dim: 'Session', label: SESSION_LABEL[g.key] ?? g.key })),
  ];
  if (!groups.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-50 dark:bg-zinc-800">
          <tr>
            <th className={`${TH} text-left`}>Group</th>
            <th className={`${TH} text-right`}>Fills</th>
            <th className={`${TH} text-right`}>With NBBO</th>
            <th className={`${TH} text-right`}>Notional</th>
            <th className={`${TH} text-right`}>vs mid</th>
            <th className={`${TH} text-right`}>Cost vs mid</th>
            <th className={`${TH} text-right`}>vs 1-min VWAP</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(g => (
            <tr key={`${g.dim}:${g.key}`} className={ROW}>
              <td className={`${TD} text-gray-900 dark:text-gray-100`}><span className="text-xs text-gray-500 dark:text-gray-400 mr-1.5">{g.dim}</span>{g.label}</td>
              <td className={`${TD} text-right text-gray-900 dark:text-gray-100`}>{g.fills}</td>
              <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{g.with_quote}</td>
              <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{formatCurrency(g.notional)}</td>
              <td className={`${TD} text-right font-medium ${costColor(g.vs_mid_bps)}`}>{fmtBps(g.vs_mid_bps)}</td>
              <td className={`${TD} text-right ${costColor(g.vs_mid_usd)}`}>{g.with_quote ? formatSignedUsd(g.vs_mid_usd) : '—'}</td>
              <td className={`${TD} text-right ${costColor(g.vs_vwap_bps)}`}>{fmtBps(g.vs_vwap_bps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Depth at execution ───────────────────────────────────────────────────────

const MAX_LADDER_LEVELS = 24;

function fmtClock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' })
    + `.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}

function DepthLadder({ profile, fill }: { profile: DepthProfile; fill: StockFill }) {
  const { isDark } = useTheme();
  const colors = isDark
    ? { buy: '#3987e5', sell: '#d95926', mid: '#71717a' }
    : { buy: '#2a78d6', sell: '#eb6834', mid: '#a1a1aa' };
  // Keep the levels nearest our fill when the window traded across many prices
  let levels = profile.ladder;
  if (levels.length > MAX_LADDER_LEVELS) {
    const i = levels.findIndex(l => l.ours);
    const start = Math.max(0, Math.min(levels.length - MAX_LADDER_LEVELS, i - Math.floor(MAX_LADDER_LEVELS / 2)));
    levels = levels.slice(start, start + MAX_LADDER_LEVELS);
  }
  const max = Math.max(1, ...levels.map(l => l.total));
  const bid = profile.nbbo?.bid ?? null;
  const ask = profile.nbbo?.ask ?? null;
  return (
    <div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 pb-2 text-xs text-gray-600 dark:text-gray-400">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colors.buy }} />Buyer-initiated (at/above ask)</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colors.sell }} />Seller-initiated (at/below bid)</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colors.mid }} />Inside the spread</span>
      </div>
      <table className="w-full max-w-3xl" aria-label="Volume traded by price within 30 seconds of the fill">
        <thead>
          <tr>
            <th className={`${TH} text-left`}>Price</th>
            <th className={`${TH} text-left w-full`}>Volume ±30 s</th>
            <th className={`${TH} text-right`}>Shares</th>
            <th className={`${TH} text-right`}>Prints</th>
          </tr>
        </thead>
        <tbody>
          {levels.map(l => {
            const isBid = bid != null && Math.abs(l.price - bid) < 0.005;
            const isAsk = ask != null && Math.abs(l.price - ask) < 0.005;
            return (
              <tr key={l.price} className={l.ours ? 'bg-amber-50 dark:bg-amber-950/30' : undefined}>
                <td className="px-3 py-0.5 text-xs whitespace-nowrap tabular-nums text-gray-900 dark:text-gray-100">
                  {formatCurrency(l.price)}
                  {isAsk && <span className="ml-1.5 text-[10px] uppercase text-gray-500 dark:text-gray-400">ask</span>}
                  {isBid && <span className="ml-1.5 text-[10px] uppercase text-gray-500 dark:text-gray-400">bid</span>}
                  {l.ours && <span className="ml-1.5 text-[10px] uppercase font-semibold text-amber-700 dark:text-amber-400">our {fill.side === 'BUY' ? 'buy' : 'sell'}</span>}
                </td>
                <td className="px-3 py-0.5">
                  <div className="flex h-3 rounded-sm overflow-hidden" style={{ width: `${Math.max(2, (l.total / max) * 100)}%` }} title={`${l.buy} buyer · ${l.sell} seller · ${l.mid} inside`}>
                    {l.buy > 0 && <div style={{ width: `${(l.buy / l.total) * 100}%`, backgroundColor: colors.buy }} />}
                    {l.sell > 0 && <div style={{ width: `${(l.sell / l.total) * 100}%`, backgroundColor: colors.sell }} />}
                    {l.mid > 0 && <div style={{ width: `${(l.mid / l.total) * 100}%`, backgroundColor: colors.mid }} />}
                    {l.total === 0 && <div className="w-full bg-gray-200 dark:bg-zinc-700" />}
                  </div>
                </td>
                <td className="px-3 py-0.5 text-xs text-right tabular-nums text-gray-600 dark:text-gray-400">{l.total.toLocaleString('en-US')}</td>
                <td className="px-3 py-0.5 text-xs text-right tabular-nums text-gray-600 dark:text-gray-400">{l.trades}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ExecutionDepthPanel({ symbol, fill }: { symbol: string; fill: StockFill }) {
  const [state, setState] = useState<{ depth: ExecutionDepth | null; error: string | null }>({ depth: null, error: null });
  const at = new Date(fill.time).toISOString();
  useEffect(() => {
    let cancelled = false;
    setState({ depth: null, error: null });
    getExecutionDepth(symbol, at)
      .then(depth => { if (!cancelled) setState({ depth, error: null }); })
      .catch(err => { if (!cancelled) setState({ depth: null, error: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [symbol, at]);

  if (state.error) return <p className="text-sm text-red-600 dark:text-red-400">Depth unavailable: {state.error}</p>;
  if (!state.depth) return <p className="text-sm text-gray-500 dark:text-gray-400">Loading the NBBO and the tape ±30 s around this fill…</p>;

  const depth = state.depth;
  const p = depthProfile(depth, fill);
  const nbbo = p.nbbo;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">NBBO at the fill</div>
          <div className="text-gray-900 dark:text-gray-100 tabular-nums">
            {nbbo?.bid != null ? `${formatCurrency(nbbo.bid)} × ${nbbo.bid_size ?? '—'}` : '—'}
            <span className="text-gray-400 mx-1">/</span>
            {nbbo?.ask != null ? `${formatCurrency(nbbo.ask)} × ${nbbo.ask_size ?? '—'}` : '—'}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {nbbo ? `${nbbo.bid_exchange ?? '?'} / ${nbbo.ask_exchange ?? '?'} · as of ${fmtClock(nbbo.t)}` : 'No quote in the 5 s before the fill'}
            {' · '}{p.quote_updates} updates ±5 s
            {p.bid_range && p.ask_range ? ` · bid ${formatCurrency(p.bid_range[0])}–${formatCurrency(p.bid_range[1])}, ask ${formatCurrency(p.ask_range[0])}–${formatCurrency(p.ask_range[1])}` : ''}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Tape ±30 s</div>
          <div className="text-gray-900 dark:text-gray-100 tabular-nums">
            {p.volume.toLocaleString('en-US')} sh in {p.trades} prints{p.vwap != null ? ` · VWAP ${formatCurrency(p.vwap)}` : ''}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {p.volume_before.toLocaleString('en-US')} before / {p.volume_after.toLocaleString('en-US')} after
            {p.share_of_volume != null ? ` · ours ${(p.share_of_volume * 100).toFixed(1)}% of volume` : ''}
            {depth.truncated.trades ? ' · window truncated' : ''}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">Size vs. displayed · markout</div>
          <div className="text-gray-900 dark:text-gray-100 tabular-nums">
            {p.share_of_displayed != null ? `${p.share_of_displayed.toFixed(2)}× the ${fill.side === 'BUY' ? 'ask' : 'bid'} size` : '—'}
            {' · '}
            <span className={costColor(p.markout_bps)}>{fmtBps(p.markout_bps)} at +5 s</span>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {p.likely_print
              ? `Our print: ${fmtClock(p.likely_print.t)} on ${p.likely_print.exchange ?? '?'}${p.matching_prints.length > 1 ? ` (closest of ${p.matching_prints.length} at our price and size)` : ''}`
              : 'No print matching our price and size within ±2 s'}
          </div>
        </div>
      </div>
      {p.trades > 0 ? <DepthLadder profile={p} fill={fill} /> : <p className="text-sm text-gray-500 dark:text-gray-400">No consolidated trades within ±30 s (e.g. the overnight session trades off-exchange).</p>}
    </div>
  );
}

export function FillQualityTable({ rows, symbol }: { rows: FillAssessment[]; symbol: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <Empty>No fills to assess.</Empty>;
  const sorted = [...rows].sort((a, b) => b.fill.time - a.fill.time);
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-50 dark:bg-zinc-800">
          <tr>
            <th className={`${TH} text-left`}><span className="sr-only">Depth</span></th>
            <th className={`${TH} text-left`}>Filled (ET)</th>
            <th className={`${TH} text-left`}>Session</th>
            <th className={`${TH} text-left`}>Fill</th>
            <th className={`${TH} text-right`}>Bid × size</th>
            <th className={`${TH} text-right`}>Ask × size</th>
            <th className={`${TH} text-right`}>Spread</th>
            <th className={`${TH} text-left`}>Placement</th>
            <th className={`${TH} text-right`}>vs mid</th>
            <th className={`${TH} text-right`}>Cost</th>
            <th className={`${TH} text-right`}>vs VWAP</th>
            <th className={`${TH} text-right`}>Minute range</th>
            <th className={`${TH} text-right`}>vs limit</th>
            <th className={`${TH} text-right`}>Quote age</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(a => {
            const f = a.fill;
            const isOpen = open === f.order_id;
            return (
              <Fragment key={f.order_id}>
              <tr className={ROW}>
                <td className={`${TD} pr-0`}>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : f.order_id)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Hide' : 'Show'} market depth at execution`}
                    className="px-2 py-0.5 text-xs rounded border border-gray-300 dark:border-zinc-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-800"
                  >
                    {isOpen ? '▾ Depth' : '▸ Depth'}
                  </button>
                </td>
                <td className={`${TD} text-gray-600 dark:text-gray-400`}>{fmtTime(f.time)}</td>
                <td className={`${TD} text-gray-600 dark:text-gray-400`}>{a.session ? SESSION_LABEL[a.session] : '—'}</td>
                <td className={`${TD} text-gray-900 dark:text-gray-100`}>
                  {f.side === 'BUY' ? 'Buy' : 'Sell'} {+f.quantity.toFixed(4)} @ {formatCurrency(f.price)}
                  <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">{f.kind}</span>
                </td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{a.quote?.bid ? `${formatCurrency(a.quote.bid)} × ${fmtSize(a.quote.bid_size)}` : '—'}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{a.quote?.ask ? `${formatCurrency(a.quote.ask)} × ${fmtSize(a.quote.ask_size)}` : '—'}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`}>{a.spread_bps != null ? `${a.spread_bps.toFixed(1)} bps` : '—'}</td>
                <td className={TD}><PlacementBadge placement={a.placement} /></td>
                <td className={`${TD} text-right font-medium ${costColor(a.vs_mid_bps)}`}>{fmtBps(a.vs_mid_bps)}</td>
                <td className={`${TD} text-right ${costColor(a.vs_mid_usd)}`}>{a.vs_mid_usd != null ? formatSignedUsd(a.vs_mid_usd) : '—'}</td>
                <td className={`${TD} text-right ${costColor(a.vs_vwap_bps)}`}>{fmtBps(a.vs_vwap_bps)}</td>
                <td className={`${TD} text-right text-gray-600 dark:text-gray-400`} title="0% = best price of the minute for this side, 100% = worst">
                  {a.bar ? `${formatCurrency(a.bar.low)}–${formatCurrency(a.bar.high)}` : '—'}
                  {a.bar_position != null && <span className="ml-1 text-xs">({Math.round(a.bar_position * 100)}%)</span>}
                </td>
                <td className={`${TD} text-right ${costColor(a.limit_improvement_bps != null ? -a.limit_improvement_bps : null)}`} title="Improvement vs the limit price (limit orders)">
                  {fmtBps(a.limit_improvement_bps)}
                </td>
                <td className={`${TD} text-right ${a.quote_stale ? 'text-amber-600 dark:text-amber-400' : 'text-gray-600 dark:text-gray-400'}`}>{fmtAge(a.quote?.age_ms)}</td>
              </tr>
              {isOpen && (
                <tr className="bg-gray-50 dark:bg-zinc-800/50">
                  <td colSpan={14} className="p-0">
                    {/* Pinned to the visible width of the scrolling table */}
                    <div className="sticky left-0 px-4 py-3" style={{ width: 'min(calc(100vw - 4.5rem), 1212px)' }}>
                      <ExecutionDepthPanel symbol={symbol} fill={f} />
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
