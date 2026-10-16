// Vol-calibration and fill-quality panels for the Ticker P&L page.

import type { ReactNode } from 'react';
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

export function FillQualityTable({ rows }: { rows: FillAssessment[] }) {
  if (!rows.length) return <Empty>No fills to assess.</Empty>;
  const sorted = [...rows].sort((a, b) => b.fill.time - a.fill.time);
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-50 dark:bg-zinc-800">
          <tr>
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
            return (
              <tr key={f.order_id} className={ROW}>
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
