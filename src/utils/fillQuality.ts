// Fill quality: each fill measured against the market in force when it
// executed — the consolidated NBBO (last quote at/before the fill) and the
// 1-minute bar containing it — from the market-context function.
//
// Sign convention: positive bps / dollars = cost to us (paid above the
// reference on a buy, sold below it on a sell); negative = price improvement.

import type { StockFill } from './tickerPnl';

export type Session = 'pre' | 'regular' | 'post' | 'overnight' | 'closed';

export interface MarketQuote {
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  bid_exchange: string | null;
  ask_exchange: string | null;
  time: string | null;
  age_ms: number | null;
}

export interface MinuteBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
  trades: number | null;
}

export interface FillMarketContext {
  t: string;
  session: Session;
  feed: string | null;
  quote: MarketQuote | null;
  bar: MinuteBar | null;
  error: string | null;
  cached?: boolean;
}

/** Where the fill printed relative to the NBBO, from our side's point of view. */
export type Placement = 'better' | 'inside' | 'touch' | 'through' | 'stale' | 'no-quote';

export const PLACEMENT_LABEL: Record<Placement, string> = {
  better: 'Better than NBBO',
  inside: 'Inside spread',
  touch: 'At the touch',
  through: 'Through the NBBO',
  stale: 'Stale quote',
  'no-quote': 'No quote',
};

/**
 * Quotes older than this at execution are not a usable reference (e.g. the
 * last post-market quote before an overnight 24 Hour Market fill): they are
 * shown but excluded from slippage and placement.
 */
export const STALE_QUOTE_MS = 60_000;
const TICK = 0.005; // half a cent: tolerance for "at the touch"

export interface FillAssessment {
  fill: StockFill;
  session: Session | null;
  feed: string | null;
  quote: MarketQuote | null;
  bar: MinuteBar | null;
  mid: number | null;
  spread_bps: number | null;
  quote_stale: boolean;
  /** Signed vs NBBO mid, bps (+ = cost) */
  vs_mid_bps: number | null;
  /** Signed vs NBBO mid, dollars over the fill quantity (+ = cost) */
  vs_mid_usd: number | null;
  /** Signed vs the minute VWAP, bps (+ = cost) */
  vs_vwap_bps: number | null;
  placement: Placement;
  /** 0 = best price of the minute for our side, 1 = worst */
  bar_position: number | null;
  /** Fill quantity ÷ displayed size on the side we took (as reported by the feed) */
  size_vs_displayed: number | null;
  /** Limit orders: improvement vs the limit price, bps (+ = better than the limit) */
  limit_improvement_bps: number | null;
}

const bps = (x: number) => x * 10_000;

export function assessFill(fill: StockFill, ctx: FillMarketContext | null | undefined): FillAssessment {
  const s = fill.side === 'BUY' ? 1 : -1;
  const quote = ctx?.quote ?? null;
  const bar = ctx?.bar ?? null;
  const bid = quote?.bid != null && quote.bid > 0 ? quote.bid : null;
  const ask = quote?.ask != null && quote.ask > 0 ? quote.ask : null;
  const stale = quote?.age_ms != null && quote.age_ms > STALE_QUOTE_MS;
  const valid = bid != null && ask != null && ask >= bid && !stale;
  const mid = valid ? (bid! + ask!) / 2 : null;

  let placement: Placement = bid != null && ask != null && stale ? 'stale' : 'no-quote';
  if (valid) {
    const near = fill.side === 'BUY' ? ask! : bid!; // the side we lift/hit
    const far = fill.side === 'BUY' ? bid! : ask!;
    const beyondNear = s * (fill.price - near);
    if (Math.abs(fill.price - near) <= TICK) placement = 'touch';
    else if (beyondNear > 0) placement = 'through';
    else if (s * (fill.price - far) < -TICK) placement = 'better';
    else placement = 'inside';
  }

  const vwap = bar?.vwap != null && bar.vwap > 0 ? bar.vwap : null;
  let barPosition: number | null = null;
  if (bar && bar.high > bar.low) {
    const pos = (fill.price - bar.low) / (bar.high - bar.low);
    barPosition = Math.min(1, Math.max(0, s === 1 ? pos : 1 - pos));
  }
  const displayed = fill.side === 'BUY' ? quote?.ask_size : quote?.bid_size;

  return {
    fill,
    session: ctx?.session ?? null,
    feed: ctx?.feed ?? null,
    quote,
    bar,
    mid,
    spread_bps: valid && mid ? bps((ask! - bid!) / mid) : null,
    quote_stale: stale,
    vs_mid_bps: mid ? bps(s * (fill.price - mid) / mid) : null,
    vs_mid_usd: mid ? s * (fill.price - mid) * fill.quantity : null,
    vs_vwap_bps: vwap ? bps(s * (fill.price - vwap) / vwap) : null,
    placement,
    bar_position: barPosition,
    size_vs_displayed: displayed != null && displayed > 0 ? fill.quantity / displayed : null,
    limit_improvement_bps: fill.limit_price ? bps(-s * (fill.price - fill.limit_price) / fill.limit_price) : null,
  };
}

export interface QualityGroup {
  key: string;
  fills: number;
  with_quote: number;
  notional: number;
  /** Notional-weighted vs mid, bps */
  vs_mid_bps: number | null;
  vs_mid_usd: number;
  vs_vwap_bps: number | null;
}

export interface FillQualitySummary {
  fills: number;
  with_quote: number;
  with_bar: number;
  notional: number;
  vs_mid_bps: number | null;
  vs_mid_usd: number;
  vs_vwap_bps: number | null;
  avg_spread_bps: number | null;
  placements: Record<Placement, number>;
  stale_quotes: number;
  by_kind: QualityGroup[];
  by_session: QualityGroup[];
  /** Stop orders vs. the NBBO mid at execution (notional-weighted, bps). Trailing
   *  stops store the trail's starting level, not the trigger, so the NBBO is
   *  the only meaningful reference. */
  stops_vs_mid_bps: number | null;
  stop_fills: number;
}

function weighted(rows: FillAssessment[], pick: (a: FillAssessment) => number | null): number | null {
  let num = 0;
  let den = 0;
  for (const a of rows) {
    const v = pick(a);
    if (v == null || !Number.isFinite(v)) continue;
    num += v * a.fill.notional;
    den += a.fill.notional;
  }
  return den > 0 ? num / den : null;
}

function group(rows: FillAssessment[], keyOf: (a: FillAssessment) => string): QualityGroup[] {
  const map = new Map<string, FillAssessment[]>();
  for (const a of rows) {
    const k = keyOf(a);
    map.set(k, [...(map.get(k) ?? []), a]);
  }
  return [...map.entries()].map(([key, list]) => ({
    key,
    fills: list.length,
    with_quote: list.filter(a => a.mid != null).length,
    notional: list.reduce((s, a) => s + a.fill.notional, 0),
    vs_mid_bps: weighted(list, a => a.vs_mid_bps),
    vs_mid_usd: list.reduce((s, a) => s + (a.vs_mid_usd ?? 0), 0),
    vs_vwap_bps: weighted(list, a => a.vs_vwap_bps),
  })).sort((a, b) => b.notional - a.notional);
}

export function summarizeFillQuality(rows: FillAssessment[]): FillQualitySummary {
  const placements: Record<Placement, number> = { better: 0, inside: 0, touch: 0, through: 0, stale: 0, 'no-quote': 0 };
  for (const a of rows) placements[a.placement]++;
  const spreads = rows.map(a => a.spread_bps).filter((x): x is number => x != null);
  const stops = rows.filter(a => a.fill.kind === 'Stop' || a.fill.kind === 'Stop limit');
  return {
    fills: rows.length,
    with_quote: rows.filter(a => a.mid != null).length,
    with_bar: rows.filter(a => a.bar != null).length,
    notional: rows.reduce((s, a) => s + a.fill.notional, 0),
    vs_mid_bps: weighted(rows, a => a.vs_mid_bps),
    vs_mid_usd: rows.reduce((s, a) => s + (a.vs_mid_usd ?? 0), 0),
    vs_vwap_bps: weighted(rows, a => a.vs_vwap_bps),
    avg_spread_bps: spreads.length ? spreads.reduce((s, x) => s + x, 0) / spreads.length : null,
    placements,
    stale_quotes: rows.filter(a => a.quote_stale).length,
    by_kind: group(rows, a => a.fill.kind),
    by_session: group(rows, a => a.session ?? 'unknown'),
    stops_vs_mid_bps: weighted(stops, a => a.vs_mid_bps),
    stop_fills: stops.length,
  };
}

/** OCC option symbol, e.g. NBIS261127C00220000. */
export function occSymbol(chain: string, expiration: string, type: string, strike: number): string | null {
  const m = expiration.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !Number.isFinite(strike)) return null;
  const cp = type.toLowerCase() === 'put' ? 'P' : 'C';
  const strikeField = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${chain.toUpperCase()}${m[1].slice(2)}${m[2]}${m[3]}${cp}${strikeField}`;
}
