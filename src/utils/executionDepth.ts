// Market depth around one execution, from the market-context `depth` action:
// every NBBO update and every consolidated trade within ±30s.
//
// Equity depth-of-book (L2) isn't in any feed the site has, so depth here is
// the displayed top of book (sizes per venue) plus the tape: how much traded at
// each price around our fill, and whether buyers or sellers initiated it.

import type { StockFill } from './tickerPnl';
import { utcMs } from './time';

export interface DepthQuote {
  t: string;
  bid: number | null;
  ask: number | null;
  bid_size: number | null;
  ask_size: number | null;
  bid_exchange: string | null;
  ask_exchange: string | null;
}

export interface DepthTrade {
  t: string;
  price: number;
  size: number;
  exchange: string | null;
  conditions: string[];
}

export interface ExecutionDepth {
  ok: boolean;
  symbol: string;
  t: string;
  session: string;
  feed: string | null;
  window_ms: { quotes: number; trades: number };
  quotes: DepthQuote[];
  trades: DepthTrade[];
  truncated: { quotes: boolean; trades: boolean };
  cached?: boolean;
}

export type Aggressor = 'buy' | 'sell' | 'mid';

export interface LadderLevel {
  price: number;
  /** Volume classified against the NBBO in force at each trade */
  buy: number;
  sell: number;
  mid: number;
  total: number;
  trades: number;
  /** Our fill's price level */
  ours: boolean;
}

export interface DepthProfile {
  /** NBBO in force at the fill (last update at or before it) */
  nbbo: DepthQuote | null;
  /** Ladder of traded volume by price, highest price first */
  ladder: LadderLevel[];
  volume: number;
  trades: number;
  vwap: number | null;
  /** Traded volume in the window before / after the fill */
  volume_before: number;
  volume_after: number;
  /** Our quantity ÷ all volume traded in the window */
  share_of_volume: number | null;
  /** Our quantity ÷ size displayed on the side we took at the fill */
  share_of_displayed: number | null;
  /** Quote updates within ±5s of the fill */
  quote_updates: number;
  /** Best bid / ask range within ±5s of the fill */
  bid_range: [number, number] | null;
  ask_range: [number, number] | null;
  /** NBBO mid 5s after the fill vs. our price, bps; + = the market moved against us after */
  markout_bps: number | null;
  /** Prints within ±2s at our price and size, closest in time first */
  matching_prints: DepthTrade[];
  /** The closest of those — most likely our own execution */
  likely_print: DepthTrade | null;
}

const CENT = 0.01;
/** Horizon for the quote summary and the markout. */
export const NEAR_MS = 5_000;

function prevailing(quotes: DepthQuote[], atMs: number): DepthQuote | null {
  let best: DepthQuote | null = null;
  for (const q of quotes) {
    if (utcMs(q.t) <= atMs) best = q;
    else break;
  }
  return best;
}

/** Classify a print against the NBBO in force when it printed (quote rule). */
export function aggressorOf(price: number, quote: DepthQuote | null): Aggressor {
  if (!quote || quote.bid == null || quote.ask == null) return 'mid';
  if (price >= quote.ask - 1e-9) return 'buy';
  if (price <= quote.bid + 1e-9) return 'sell';
  return 'mid';
}

export function depthProfile(depth: ExecutionDepth, fill: StockFill): DepthProfile {
  const atMs = utcMs(depth.t);
  const quotes = [...depth.quotes].sort((a, b) => utcMs(a.t) - utcMs(b.t));
  const trades = [...depth.trades].sort((a, b) => utcMs(a.t) - utcMs(b.t));
  const nbbo = prevailing(quotes, atMs);

  const levels = new Map<number, LadderLevel>();
  const ourLevel = Math.round(fill.price / CENT);
  let volume = 0;
  let notional = 0;
  let before = 0;
  let after = 0;
  // Walk quotes alongside trades so each print is classified against its own NBBO
  let qi = 0;
  let current: DepthQuote | null = null;
  for (const tr of trades) {
    const tMs = utcMs(tr.t);
    while (qi < quotes.length && utcMs(quotes[qi].t) <= tMs) current = quotes[qi++];
    const key = Math.round(tr.price / CENT);
    const level = levels.get(key) ?? { price: key * CENT, buy: 0, sell: 0, mid: 0, total: 0, trades: 0, ours: key === ourLevel };
    level[aggressorOf(tr.price, current)] += tr.size;
    level.total += tr.size;
    level.trades++;
    levels.set(key, level);
    volume += tr.size;
    notional += tr.size * tr.price;
    if (tMs < atMs) before += tr.size; else after += tr.size;
  }
  if (!levels.has(ourLevel)) levels.set(ourLevel, { price: ourLevel * CENT, buy: 0, sell: 0, mid: 0, total: 0, trades: 0, ours: true });

  const near = quotes.filter(q => Math.abs(utcMs(q.t) - atMs) <= NEAR_MS);
  const bids = near.map(q => q.bid).filter((x): x is number => x != null && x > 0);
  const asks = near.map(q => q.ask).filter((x): x is number => x != null && x > 0);
  const displayed = fill.side === 'BUY' ? nbbo?.ask_size : nbbo?.bid_size;

  // Markout: the NBBO mid in force 5s after the fill
  const later = prevailing(quotes, atMs + NEAR_MS);
  const laterMid = later && later.bid != null && later.ask != null ? (later.bid + later.ask) / 2 : null;
  const s = fill.side === 'BUY' ? 1 : -1;

  // Small or round-lot orders can match several identical prints: rank by time
  const matching = trades
    .filter(tr =>
      Math.abs(utcMs(tr.t) - fill.time) <= 2000 &&
      Math.abs(tr.price - fill.price) < CENT / 2 + 1e-9 &&
      (tr.size === fill.quantity || tr.size === Math.round(fill.quantity)))
    .sort((a, b) => Math.abs(utcMs(a.t) - fill.time) - Math.abs(utcMs(b.t) - fill.time));

  return {
    nbbo,
    ladder: [...levels.values()].sort((a, b) => b.price - a.price),
    volume,
    trades: trades.length,
    vwap: volume > 0 ? notional / volume : null,
    volume_before: before,
    volume_after: after,
    share_of_volume: volume > 0 ? fill.quantity / volume : null,
    share_of_displayed: displayed != null && displayed > 0 ? fill.quantity / displayed : null,
    quote_updates: near.length,
    bid_range: bids.length ? [Math.min(...bids), Math.max(...bids)] : null,
    ask_range: asks.length ? [Math.min(...asks), Math.max(...asks)] : null,
    // + = the market moved away from us after we traded (we bought before a drop / sold before a rise)
    markout_bps: laterMid ? -s * (laterMid - fill.price) / fill.price * 10_000 : null,
    matching_prints: matching,
    likely_print: matching[0] ?? null,
  };
}
