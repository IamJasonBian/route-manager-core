// Per-ticker P&L, Sharpe and risk for the Ticker P&L page.
//
// Everything here is pure so it can be unit-tested against real order history:
//   buildStockLedger   — fill-by-fill average-cost ledger (realized P&L per sell)
//   buildOptionLedger  — per-contract ledger for option fills (incl. expiries)
//   buildDailyPnl      — daily mark-to-market P&L curve from fills + closes
//   computeRiskStats   — Sharpe / Sortino / drawdown / VaR off that curve
//   analyzeOpenOrders  — what each queued order does to the position if filled
//
// Cost basis uses the average-cost method, matching computeStockPnl in
// netlify/functions/enriched-snapshot.cjs. Fills are dated by their fill time
// (updated_at) rather than submission time, so a GTC order that fills days
// after it was placed lands on the right day of the curve.

import type {
  SnapshotOrder,
  SnapshotOptionOrder,
  SnapshotPosition,
  OptionPosition,
} from '../services/robinhoodService';
import { utcMs } from './time';

export const TRADING_DAYS = 252;
/** Below this many daily observations Sharpe/VaR are shown but flagged as noisy. */
export const MIN_RELIABLE_DAYS = 20;
/** Window (trading days) for the underlying's realized volatility. */
export const VOL_WINDOW = 30;
const Z_95 = 1.645;

/** Share counts closer than this are equal (fractional-share float noise). */
const SHARE_EPSILON = 1e-6;

const OPEN_STATES = new Set(['queued', 'unconfirmed', 'confirmed', 'pending', 'partially_filled', 'new']);

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Exchange-local (New York) calendar date, YYYY-MM-DD, for an epoch ms. */
export function etDate(ms: number): string {
  return ET_DATE.format(new Date(ms));
}

export function isOpenState(state: string | null | undefined): boolean {
  return state != null && OPEN_STATES.has(state);
}

// ─── Stock ledger ─────────────────────────────────────────────────────────────

export interface StockFill {
  order_id: string;
  /** Epoch ms of the fill */
  time: number;
  /** New York trading date of the fill */
  date: string;
  side: 'BUY' | 'SELL';
  /** Human label, e.g. "Limit", "Market", "Stop" */
  kind: string;
  quantity: number;
  price: number;
  notional: number;
  shares_after: number;
  avg_cost_after: number;
  /** Realized P&L booked by this fill (sells only; null for buys) */
  realized: number | null;
  cumulative_realized: number;
  /** Shares sold that had no tracked cost basis (history starts mid-position) */
  unmatched_quantity: number;
  /** True for a partial fill of an order that is still working or was cancelled */
  partial: boolean;
  /** Order's limit / stop price (null when absent) and submission time (epoch ms) */
  limit_price: number | null;
  stop_price: number | null;
  submitted: number | null;
}

export interface StockLedger {
  fills: StockFill[];
  shares_held: number;
  avg_cost: number;
  cost_basis: number;
  realized_pnl: number;
  total_bought: number;
  total_sold: number;
  buy_count: number;
  sell_count: number;
  /** Closing sells that booked a gain / loss */
  wins: number;
  losses: number;
  gross_win: number;
  gross_loss: number;
  /** Shares assumed held before the first tracked fill (see seedOpening) */
  opening_shares: number;
  opening_mark: number | null;
  /** Shares sold with no known cost basis — excluded from realized P&L */
  unmatched_quantity: number;
  /** Shares still held with no known cost basis (unmarked opening inventory) */
  unknown_basis_shares: number;
  /** Filled orders skipped because they carry no usable price */
  skipped_fills: number;
}

export function orderKind(order: Pick<SnapshotOrder, 'order_type' | 'trigger'>): string {
  const type = (order.order_type || '').toLowerCase();
  if ((order.trigger || '').toLowerCase() === 'stop') return type === 'limit' ? 'Stop limit' : 'Stop';
  if (type === 'limit') return 'Limit';
  if (type === 'market') return 'Market';
  return type ? type[0].toUpperCase() + type.slice(1) : '—';
}

/** Filled quantity of a stock order — including partial fills on cancelled or still-working orders. */
export function filledQuantity(order: SnapshotOrder): number {
  const filled = order.filled_quantity;
  if (order.state === 'filled') return Number(filled ?? order.quantity) || 0;
  return Number(filled ?? 0) || 0;
}

function fillTime(order: { created_at: string | null; updated_at: string | null; state: string | null }): number {
  const created = utcMs(order.created_at);
  const updated = utcMs(order.updated_at);
  // A fill can only happen after submission; updated_at is the last
  // transaction for a terminal order. Fall back to created_at when absent.
  if (Number.isFinite(updated) && (!Number.isFinite(created) || updated >= created)) return updated;
  return created;
}

interface StockFillInput {
  order: SnapshotOrder;
  time: number;
  qty: number;
  price: number;
}

function stockFillInputs(orders: SnapshotOrder[], symbol: string): { inputs: StockFillInput[]; skipped: number } {
  const seen = new Set<string>();
  const inputs: StockFillInput[] = [];
  let skipped = 0;
  for (const order of orders) {
    if ((order.symbol || '').toUpperCase() !== symbol) continue;
    if (order.order_id && seen.has(order.order_id)) continue;
    if (order.order_id) seen.add(order.order_id);
    const qty = filledQuantity(order);
    if (qty <= 0) continue;
    const price = Number(order.average_price ?? order.limit_price) || 0;
    const time = fillTime(order);
    if (price <= 0 || !Number.isFinite(time)) { skipped++; continue; }
    inputs.push({ order, time, qty, price });
  }
  inputs.sort((a, b) => a.time - b.time);
  return { inputs, skipped };
}

/**
 * Shares that must have been held before the first tracked fill: enough to
 * cover any sell that outruns the tracked buys, and enough to reconcile the
 * ledger's ending share count with the broker's current position.
 */
export function inferOpeningShares(orders: SnapshotOrder[], symbol: string, brokerQuantity: number | null): number {
  const { inputs } = stockFillInputs(orders, symbol.toUpperCase());
  let shares = 0;
  let shortfall = 0;
  for (const f of inputs) {
    shares += (f.order.side || '').toUpperCase() === 'BUY' ? f.qty : -f.qty;
    if (shares < -shortfall) shortfall = -shares;
  }
  const reconcile = brokerQuantity != null ? brokerQuantity - shares : 0;
  const opening = Math.max(shortfall, reconcile, 0);
  // Fractional share counts leave float dust (52.126027 − 52.12602699999999)
  return opening < SHARE_EPSILON ? 0 : opening;
}

/**
 * @param seedOpening Opening inventory held before the first tracked fill, and
 *   the price it is marked at (the close before the first fill). Its P&L is
 *   measured from that mark, consistent with the daily curve. With no mark the
 *   seed's cost basis is unknown and sells against it are excluded from
 *   realized P&L instead.
 */
export function buildStockLedger(
  orders: SnapshotOrder[],
  symbol: string,
  seedOpening?: { shares: number; mark: number | null },
): StockLedger {
  const sym = symbol.toUpperCase();
  const { inputs, skipped } = stockFillInputs(orders, sym);

  const openingShares = Math.max(seedOpening?.shares ?? 0, 0);
  const openingMark = seedOpening?.mark ?? null;
  // Tracked lots (known basis) vs. unknown-basis lots from an unmarked seed
  let shares = 0;
  let cost = 0;
  let unknownShares = 0;
  if (openingShares > 0) {
    if (openingMark != null && openingMark > 0) { shares = openingShares; cost = openingShares * openingMark; }
    else unknownShares = openingShares;
  }

  const ledger: StockLedger = {
    fills: [], shares_held: 0, avg_cost: 0, cost_basis: 0,
    realized_pnl: 0, total_bought: 0, total_sold: 0, buy_count: 0, sell_count: 0,
    wins: 0, losses: 0, gross_win: 0, gross_loss: 0,
    opening_shares: openingShares, opening_mark: openingMark,
    unmatched_quantity: 0, unknown_basis_shares: 0, skipped_fills: skipped,
  };

  let cumulative = 0;
  for (const { order, time, qty, price } of inputs) {
    const side = (order.side || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    const notional = qty * price;
    let realized: number | null = null;
    let unmatched = 0;

    if (side === 'BUY') {
      shares += qty;
      cost += notional;
      ledger.total_bought += notional;
      ledger.buy_count++;
    } else {
      ledger.total_sold += notional;
      ledger.sell_count++;
      // Unknown-basis inventory is sold first: it is the oldest stock held
      const fromUnknown = Math.min(unknownShares, qty);
      unknownShares -= fromUnknown;
      const fromTracked = Math.min(shares, qty - fromUnknown);
      unmatched = fromUnknown + (qty - fromUnknown - fromTracked);
      ledger.unmatched_quantity += unmatched;
      if (fromTracked > 0) {
        const avg = cost / shares;
        const booked = (price - avg) * fromTracked;
        cost -= avg * fromTracked;
        shares -= fromTracked;
        cumulative += booked;
        ledger.realized_pnl += booked;
        if (booked > 0) { ledger.wins++; ledger.gross_win += booked; }
        else if (booked < 0) { ledger.losses++; ledger.gross_loss += -booked; }
        realized = booked;
      }
    }

    if (shares < 1e-9) { shares = 0; cost = 0; }
    ledger.fills.push({
      order_id: order.order_id,
      time,
      date: etDate(time),
      side,
      kind: orderKind(order),
      quantity: qty,
      price,
      notional: r2(notional),
      shares_after: shares + unknownShares,
      avg_cost_after: shares > 0 ? cost / shares : 0,
      realized: realized == null ? null : r2(realized),
      cumulative_realized: r2(cumulative),
      unmatched_quantity: unmatched,
      partial: order.state !== 'filled',
      limit_price: order.limit_price > 0 && (order.order_type || '').toLowerCase() === 'limit' ? order.limit_price : null,
      stop_price: order.stop_price != null && order.stop_price > 0 ? order.stop_price : null,
      submitted: Number.isFinite(utcMs(order.created_at)) ? utcMs(order.created_at) : null,
    });
  }

  ledger.shares_held = shares + unknownShares;
  ledger.unknown_basis_shares = unknownShares;
  ledger.avg_cost = shares > 0 ? cost / shares : 0;
  ledger.cost_basis = r2(cost);
  ledger.realized_pnl = r2(ledger.realized_pnl);
  ledger.total_bought = r2(ledger.total_bought);
  ledger.total_sold = r2(ledger.total_sold);
  ledger.gross_win = r2(ledger.gross_win);
  ledger.gross_loss = r2(ledger.gross_loss);
  return ledger;
}

// ─── Option ledger ────────────────────────────────────────────────────────────

export interface OptionContract {
  key: string;
  label: string;
  option_type: string;
  strike: number | null;
  expiration: string | null;
}

export interface OptionFill {
  order_id: string;
  time: number;
  date: string;
  contract: OptionContract;
  /** BUY / SELL of the contract */
  side: 'BUY' | 'SELL';
  position_effect: string | null;
  quantity: number;
  /** Per-share premium (contract price) */
  price: number;
  /** Total cash premium: negative = paid (debit), positive = received (credit) */
  cash: number;
  realized: number | null;
  /** Synthetic close booked when a contract passed expiry with no closing order */
  expired: boolean;
}

export interface OptionContractState {
  contract: OptionContract;
  /** Signed contracts: + long, − short */
  position: number;
  /** Signed cash basis: + paid for longs, − received for shorts */
  basis: number;
  realized: number;
}

export interface OptionLedger {
  fills: OptionFill[];
  contracts: OptionContractState[];
  realized_pnl: number;
  premium_paid: number;
  premium_received: number;
  filled_count: number;
}

const MULTIPLIER = 100;

function legOf(order: SnapshotOptionOrder) {
  return (order.legs ?? [])[0] ?? null;
}

function contractOf(order: SnapshotOptionOrder): OptionContract {
  const legs = order.legs ?? [];
  const leg = legs[0];
  const describe = (l: NonNullable<typeof leg>) => {
    const strike = Number(l.strike_price ?? l.strike);
    const exp = l.expiration_date ?? l.expiration ?? null;
    const type = (l.option_type || '').toLowerCase();
    const expLabel = exp ? `${Number(exp.slice(5, 7))}/${Number(exp.slice(8, 10))}` : '?';
    return {
      strike: Number.isFinite(strike) ? strike : null,
      exp,
      type,
      text: `$${Number.isFinite(strike) ? strike : '?'} ${type === 'put' ? 'Put' : 'Call'} ${expLabel}`,
    };
  };
  if (!leg) {
    return { key: `order:${order.order_id}`, label: 'Option', option_type: '', strike: null, expiration: null };
  }
  if (legs.length > 1) {
    // Multi-leg strategy: track the spread as one unit
    const parts = legs.map(l => `${(l.side || '').toUpperCase()} ${describe(l).text}`);
    return {
      key: parts.slice().sort().join(' / '),
      label: order.opening_strategy ? `${order.opening_strategy.replace(/_/g, ' ')}: ${parts.join(' / ')}` : parts.join(' / '),
      option_type: 'spread',
      strike: null,
      expiration: legs.map(l => l.expiration_date ?? l.expiration ?? '').sort()[0] || null,
    };
  }
  const d = describe(leg);
  return { key: `${d.type}|${d.strike}|${d.exp}`, label: d.text, option_type: d.type, strike: d.strike, expiration: d.exp };
}

/** Total premium of an option order in dollars (positive). */
export function optionPremium(order: SnapshotOptionOrder): number {
  const processed = Number(order.processed_premium);
  if (Number.isFinite(processed) && processed > 0) return processed;
  return (Number(order.price ?? 0) * Number(order.quantity ?? 1) * MULTIPLIER) || 0;
}

/** Contract side (BUY/SELL) of an option order, from the first leg or the cash direction. */
function optionSide(order: SnapshotOptionOrder): 'BUY' | 'SELL' {
  const legSide = (legOf(order)?.side || '').toUpperCase();
  if (legSide === 'BUY' || legSide === 'SELL') return legSide;
  return (order.direction || '').toLowerCase() === 'debit' ? 'BUY' : 'SELL';
}

export function describeOptionOrder(order: SnapshotOptionOrder): OptionContract {
  return contractOf(order);
}

/**
 * @param openContractKeys Contract keys the broker still reports as held. A
 *   tracked position past its expiration that the broker no longer holds is
 *   closed as expired worthless.
 * @param today YYYY-MM-DD (New York) used for the expiry check.
 */
export function buildOptionLedger(
  orders: SnapshotOptionOrder[],
  symbol: string,
  opts: { openContractKeys?: Set<string>; today?: string } = {},
): OptionLedger {
  const sym = symbol.toUpperCase();
  const seen = new Set<string>();
  const filled = orders
    .filter(o => (o.chain_symbol || legOf(o)?.chain_symbol || '').toUpperCase() === sym)
    .filter(o => o.state === 'filled')
    .filter(o => {
      if (seen.has(o.order_id)) return false;
      seen.add(o.order_id);
      return true;
    })
    .map(o => ({ order: o, time: fillTime(o) }))
    .filter(x => Number.isFinite(x.time))
    .sort((a, b) => a.time - b.time);

  const states = new Map<string, OptionContractState>();
  const ledger: OptionLedger = { fills: [], contracts: [], realized_pnl: 0, premium_paid: 0, premium_received: 0, filled_count: 0 };

  const apply = (state: OptionContractState, signedQty: number, unitPrice: number): number => {
    // Signed average-cost: reducing trades realize against the average, a
    // trade larger than the position flips it at the trade price.
    let realized = 0;
    let q = signedQty;
    if (state.position !== 0 && Math.sign(q) !== Math.sign(state.position)) {
      const closing = Math.min(Math.abs(q), Math.abs(state.position));
      const avg = state.basis / state.position; // per-contract, positive
      const dir = Math.sign(state.position);
      realized = closing * (unitPrice - avg) * dir;
      state.basis -= avg * closing * dir;
      state.position -= closing * dir;
      q += closing * dir;
      if (Math.abs(state.position) < 1e-9) { state.position = 0; state.basis = 0; }
    }
    if (q !== 0) {
      state.position += q;
      state.basis += q * unitPrice;
    }
    state.realized += realized;
    return realized;
  };

  for (const { order, time } of filled) {
    const contract = contractOf(order);
    const side = optionSide(order);
    const qty = Number(order.quantity) || 0;
    if (qty <= 0) continue;
    const premium = optionPremium(order);
    const isDebit = (order.direction || '').toLowerCase() === 'debit' || (!order.direction && side === 'BUY');
    const cash = isDebit ? -premium : premium;
    if (isDebit) ledger.premium_paid += premium; else ledger.premium_received += premium;
    ledger.filled_count++;

    let state = states.get(contract.key);
    if (!state) { state = { contract, position: 0, basis: 0, realized: 0 }; states.set(contract.key, state); }
    const unit = premium / qty; // dollars per contract
    const realizedBefore = state.realized;
    apply(state, side === 'BUY' ? qty : -qty, unit);
    const realized = state.realized - realizedBefore;
    const closing = (legOf(order)?.position_effect || '').toLowerCase() === 'close' || realized !== 0;

    ledger.fills.push({
      order_id: order.order_id,
      time,
      date: etDate(time),
      contract,
      side,
      position_effect: legOf(order)?.position_effect ?? null,
      quantity: qty,
      price: unit / MULTIPLIER,
      cash: r2(cash),
      realized: closing ? r2(realized) : null,
      expired: false,
    });
  }

  // Expired contracts the broker no longer reports: close at zero premium
  if (opts.today) {
    for (const state of states.values()) {
      const exp = state.contract.expiration;
      if (state.position === 0 || !exp || exp >= opts.today) continue;
      if (opts.openContractKeys?.has(state.contract.key)) continue;
      const before = state.realized;
      const contracts = Math.abs(state.position);
      const expiredSide: 'BUY' | 'SELL' = state.position > 0 ? 'SELL' : 'BUY';
      apply(state, -state.position, 0);
      const expiryMs = utcMs(`${exp}T21:00:00Z`);
      ledger.fills.push({
        order_id: `expired:${state.contract.key}`,
        time: expiryMs,
        date: exp,
        contract: state.contract,
        side: expiredSide,
        position_effect: 'close',
        quantity: contracts,
        price: 0,
        cash: 0,
        realized: r2(state.realized - before),
        expired: true,
      });
    }
    ledger.fills.sort((a, b) => a.time - b.time);
  }

  ledger.contracts = [...states.values()];
  ledger.realized_pnl = r2(ledger.contracts.reduce((s, c) => s + c.realized, 0));
  ledger.premium_paid = r2(ledger.premium_paid);
  ledger.premium_received = r2(ledger.premium_received);
  return ledger;
}

/** Contract key for a broker option position, matching the option ledger's keys. */
export function optionPositionKey(p: OptionPosition): string {
  const strike = Number(p.strike_price ?? p.strike);
  const exp = p.expiration_date ?? p.expiration ?? null;
  return `${(p.option_type || '').toLowerCase()}|${Number.isFinite(strike) ? strike : null}|${exp}`;
}

// ─── Daily P&L curve ──────────────────────────────────────────────────────────

export interface PriceBar {
  /** YYYY-MM-DD */
  date: string;
  close: number;
}

export interface DailyPnlPoint {
  date: string;
  close: number;
  shares: number;
  /** Market value of the position at the close */
  market_value: number;
  /** Mark-to-market P&L for the day (includes intraday round trips) */
  pnl: number;
  /** Cumulative P&L since the first tracked fill */
  cumulative: number;
  /** Shares bought / sold that day */
  bought: number;
  sold: number;
  /** True for the trailing point marked at the live price rather than a close */
  live: boolean;
  /**
   * First point when fills predate the price history: it absorbs all earlier
   * P&L, so its day P&L is zeroed and it is excluded from daily stats.
   */
  baseline: boolean;
}

/**
 * Daily mark-to-market P&L of the stock position:
 *   cumulative_d = Σ sell cash − Σ buy cash (through d) + shares_d × close_d − opening value
 *
 * Starts on the first trading day with a fill. Opening inventory (see
 * inferOpeningShares) is valued at `openingMark` so only P&L earned while
 * tracking counts. When `livePrice` is given and today has no bar yet, a
 * trailing point marks the position at it (an existing bar for today is
 * re-marked instead).
 */
export function buildDailyPnl(
  ledger: StockLedger,
  bars: PriceBar[],
  opts: { livePrice?: number | null; today?: string } = {},
): DailyPnlPoint[] {
  if (!ledger.fills.length || !bars.length) return [];
  const sorted = [...bars].filter(b => Number.isFinite(b.close) && b.close > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return [];

  const firstFillDate = ledger.fills[0].date;
  const days: PriceBar[] = sorted.filter(b => b.date >= firstFillDate);
  const live = opts.livePrice != null && opts.livePrice > 0 ? opts.livePrice : null;
  const today = opts.today;
  if (live && today) {
    const last = days[days.length - 1];
    if (last && last.date === today) days[days.length - 1] = { ...last, close: live };
    else if (!last || today > last.date) days.push({ date: today, close: live });
  }
  // Fills after the last available close with no live price: mark at the last fill price
  const lastFill = ledger.fills[ledger.fills.length - 1];
  if (!days.length || lastFill.date > days[days.length - 1].date) {
    days.push({ date: lastFill.date, close: lastFill.price });
  }

  // Unmarked opening inventory is marked at the first close instead, so the
  // curve never books the value of shares bought before tracking as profit
  const openingValue = ledger.opening_shares * (ledger.opening_mark ?? days[0].close);
  const predates = firstFillDate < sorted[0].date;
  let fi = 0;
  let shares = ledger.opening_shares;
  let cash = 0;
  let prevCumulative = 0;
  const points: DailyPnlPoint[] = [];

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    let bought = 0;
    let sold = 0;
    // Fills dated on or before this bar (fills on non-trading days roll forward)
    while (fi < ledger.fills.length && ledger.fills[fi].date <= day.date) {
      const f = ledger.fills[fi++];
      if (f.side === 'BUY') { shares += f.quantity; cash -= f.notional; bought += f.quantity; }
      else { shares -= f.quantity; cash += f.notional; sold += f.quantity; }
    }
    if (Math.abs(shares) < 1e-9) shares = 0;
    const mv = shares * day.close;
    const cumulative = cash + mv - openingValue;
    points.push({
      date: day.date,
      close: day.close,
      shares,
      market_value: r2(mv),
      pnl: r2(cumulative - prevCumulative),
      cumulative: r2(cumulative),
      bought,
      sold,
      live: live != null && i === days.length - 1 && day.close === live,
      baseline: predates && i === 0,
    });
    if (predates && i === 0) points[0].pnl = 0;
    prevCumulative = cumulative;
  }
  return points;
}

// ─── Risk stats ───────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Linear-interpolated quantile, q in [0, 1]. */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export interface RiskStats {
  days: number;
  reliable: boolean;
  total_pnl: number;
  mean_daily_pnl: number;
  /** Annualized σ of daily dollar P&L */
  ann_vol_pnl: number;
  /** Annualized, rf = 0, on daily dollar P&L */
  sharpe: number | null;
  sortino: number | null;
  max_drawdown: number;
  current_drawdown: number;
  best_day: number;
  worst_day: number;
  up_days: number;
  down_days: number;
  /** 1-day 95% historical VaR from the P&L curve (positive = loss) */
  var95_hist: number | null;
  /** Peak market value deployed */
  peak_exposure: number;
  /** Total P&L / peak exposure */
  return_on_peak: number | null;
}

export function computeRiskStats(points: DailyPnlPoint[]): RiskStats {
  const daily = points.filter(p => !p.baseline);
  const pnls = daily.map(p => p.pnl);
  const sd = stdev(pnls);
  const m = mean(pnls);
  const downside = pnls.filter(x => x < 0);
  const downDev = downside.length ? Math.sqrt(downside.reduce((s, x) => s + x * x, 0) / pnls.length) : 0;

  let peak = 0;
  let maxDd = 0;
  for (const p of points) {
    peak = Math.max(peak, p.cumulative);
    maxDd = Math.max(maxDd, peak - p.cumulative);
  }
  const last = points[points.length - 1];
  const peakExposure = points.reduce((s, p) => Math.max(s, Math.abs(p.market_value)), 0);
  const total = last ? last.cumulative : 0;

  return {
    days: daily.length,
    reliable: daily.length >= MIN_RELIABLE_DAYS,
    total_pnl: r2(total),
    mean_daily_pnl: r2(m),
    ann_vol_pnl: r2(sd * Math.sqrt(TRADING_DAYS)),
    sharpe: daily.length >= 2 && sd > 0 ? (m / sd) * Math.sqrt(TRADING_DAYS) : null,
    sortino: daily.length >= 2 && downDev > 0 ? (m / downDev) * Math.sqrt(TRADING_DAYS) : null,
    max_drawdown: r2(maxDd),
    current_drawdown: r2(last ? peak - last.cumulative : 0),
    best_day: r2(pnls.length ? Math.max(...pnls) : 0),
    worst_day: r2(pnls.length ? Math.min(...pnls) : 0),
    up_days: pnls.filter(x => x > 0).length,
    down_days: pnls.filter(x => x < 0).length,
    var95_hist: daily.length >= 2 ? r2(Math.max(-quantile(pnls, 0.05), 0)) : null,
    peak_exposure: r2(peakExposure),
    return_on_peak: peakExposure > 0 ? total / peakExposure : null,
  };
}

/** Annualized realized volatility of daily log returns over the last `window` closes. */
export function realizedVol(bars: PriceBar[], window = VOL_WINDOW): number | null {
  const closes = [...bars].sort((a, b) => a.date.localeCompare(b.date)).map(b => b.close).filter(c => c > 0);
  const recent = closes.slice(-(window + 1));
  if (recent.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < recent.length; i++) rets.push(Math.log(recent[i] / recent[i - 1]));
  return stdev(rets) * Math.sqrt(TRADING_DAYS);
}

export interface ExposureSummary {
  stock_value: number;
  /** Σ delta × 100 × contracts × underlying (sign-aware) */
  option_delta_dollars: number;
  option_market_value: number;
  option_unrealized: number;
  net_delta_dollars: number;
  pct_of_equity: number | null;
  /** 1-day 95% parametric VaR on net delta dollars using the underlying's realized vol */
  var95_param: number | null;
}

export function summarizeExposure(args: {
  shares: number;
  price: number | null;
  options: OptionPosition[];
  equity: number | null;
  annVol: number | null;
}): ExposureSummary {
  const price = args.price ?? 0;
  const stockValue = args.shares * price;
  let deltaDollars = 0;
  let optionValue = 0;
  let optionUnrealized = 0;
  for (const p of args.options) {
    const sign = (p.position_type || '').toLowerCase() === 'short' ? -1 : 1;
    const qty = Math.abs(Number(p.quantity) || 0);
    const mult = Number(p.multiplier) || MULTIPLIER;
    const delta = Number(p.greeks?.delta);
    const under = Number(p.underlying_price) || price;
    if (Number.isFinite(delta)) deltaDollars += sign * delta * qty * mult * under;
    optionValue += Number(p.current_value) || 0;
    optionUnrealized += Number(p.unrealized_pl) || 0;
  }
  const net = stockValue + deltaDollars;
  const dailyVol = args.annVol != null ? args.annVol / Math.sqrt(TRADING_DAYS) : null;
  return {
    stock_value: r2(stockValue),
    option_delta_dollars: r2(deltaDollars),
    option_market_value: r2(optionValue),
    option_unrealized: r2(optionUnrealized),
    net_delta_dollars: r2(net),
    pct_of_equity: args.equity && args.equity > 0 ? (Math.abs(stockValue) + Math.abs(optionValue)) / args.equity : null,
    var95_param: dailyVol != null ? r2(Math.abs(net) * dailyVol * Z_95) : null,
  };
}

// ─── Queued orders ────────────────────────────────────────────────────────────

export interface QueuedStockOrder {
  order: SnapshotOrder;
  side: 'BUY' | 'SELL';
  kind: string;
  /** Unfilled quantity still working */
  remaining: number;
  /** Price used for the projection: limit, else stop, else live price */
  price: number | null;
  notional: number | null;
  /** % distance of the working price from the live price */
  distance_pct: number | null;
  /** BUY: average cost after the fill. SELL: null */
  avg_cost_after: number | null;
  /** SELL: realized P&L at the working price vs. the current average cost */
  projected_realized: number | null;
  /** Placement stub never confirmed by the broker */
  untracked: boolean;
}

export interface QueuedOptionOrder {
  order: SnapshotOptionOrder;
  contract: OptionContract;
  side: 'BUY' | 'SELL';
  position_effect: string | null;
  quantity: number;
  limit_price: number;
  /** Premium paid (BUY) or received (SELL) if filled, in dollars */
  premium: number;
  /** Underlying price at expiry where the position breaks even */
  breakeven: number | null;
  /** Calendar days to expiry */
  dte: number | null;
  /** % the underlying must move to reach the strike (+ = up) */
  to_strike_pct: number | null;
  untracked: boolean;
}

export interface QueueSummary {
  stock: QueuedStockOrder[];
  options: QueuedOptionOrder[];
  /** Notional of all working stock buys */
  buy_notional: number;
  /** Notional of all working stock sells */
  sell_notional: number;
  /** Shares held if every working order filled */
  shares_if_filled: number;
  /** Premium at risk across working long option orders */
  option_premium_at_risk: number;
  option_premium_credit: number;
}

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round((utcMs(toDate) - utcMs(fromDate)) / 86_400_000);
}

export function analyzeOpenOrders(args: {
  stockOrders: SnapshotOrder[];
  optionOrders: SnapshotOptionOrder[];
  untrackedStock?: SnapshotOrder[];
  untrackedOptions?: SnapshotOptionOrder[];
  symbol: string;
  shares: number;
  avgCost: number;
  livePrice: number | null;
  today: string;
}): QueueSummary {
  const sym = args.symbol.toUpperCase();
  const live = args.livePrice != null && args.livePrice > 0 ? args.livePrice : null;
  const stockRows = [
    ...args.stockOrders.map(o => ({ o, untracked: false })),
    ...(args.untrackedStock ?? []).map(o => ({ o, untracked: true })),
  ].filter(({ o }) => (o.symbol || '').toUpperCase() === sym);

  // Working orders are projected one after another, in the order given
  let shares = args.shares;
  let cost = args.shares * args.avgCost;
  const seen = new Set<string>();
  const stock: QueuedStockOrder[] = [];
  for (const { o, untracked } of stockRows) {
    if (seen.has(o.order_id)) continue;
    seen.add(o.order_id);
    const side = (o.side || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    const remaining = Math.max((Number(o.quantity) || 0) - (Number(o.filled_quantity) || 0), 0);
    const price = (o.limit_price > 0 ? o.limit_price : null) ?? (o.stop_price && o.stop_price > 0 ? o.stop_price : null) ?? live;
    let avgAfter: number | null = null;
    let projected: number | null = null;
    if (price != null && remaining > 0) {
      if (side === 'BUY') {
        shares += remaining;
        cost += remaining * price;
        avgAfter = shares > 0 ? cost / shares : null;
      } else {
        const closing = Math.min(remaining, shares);
        const avg = shares > 0 ? cost / shares : 0;
        projected = r2((price - avg) * closing);
        cost -= avg * closing;
        shares -= closing;
      }
    }
    stock.push({
      order: o,
      side,
      kind: orderKind(o),
      remaining,
      price,
      notional: price != null ? r2(price * remaining) : null,
      distance_pct: price != null && live ? (price - live) / live : null,
      avg_cost_after: avgAfter,
      projected_realized: projected,
      untracked,
    });
  }

  const optionRows = [
    ...args.optionOrders.map(o => ({ o, untracked: false })),
    ...(args.untrackedOptions ?? []).map(o => ({ o, untracked: true })),
  ].filter(({ o }) => (o.chain_symbol || legOf(o)?.chain_symbol || '').toUpperCase() === sym);

  const options: QueuedOptionOrder[] = [];
  const seenOpt = new Set<string>();
  for (const { o, untracked } of optionRows) {
    if (seenOpt.has(o.order_id)) continue;
    seenOpt.add(o.order_id);
    const contract = contractOf(o);
    const side = optionSide(o);
    const qty = Number(o.quantity) || 0;
    const limit = Number(o.price) || 0;
    const premium = r2(limit * qty * MULTIPLIER);
    const strike = contract.strike;
    const breakeven = strike != null && contract.option_type !== 'spread'
      ? (contract.option_type === 'put' ? strike - limit : strike + limit)
      : null;
    options.push({
      order: o,
      contract,
      side,
      position_effect: legOf(o)?.position_effect ?? null,
      quantity: qty,
      limit_price: limit,
      premium,
      breakeven,
      dte: contract.expiration ? daysBetween(args.today, contract.expiration) : null,
      to_strike_pct: strike != null && live ? (strike - live) / live : null,
      untracked,
    });
  }

  return {
    stock,
    options,
    buy_notional: r2(stock.filter(s => s.side === 'BUY').reduce((s, x) => s + (x.notional ?? 0), 0)),
    sell_notional: r2(stock.filter(s => s.side === 'SELL').reduce((s, x) => s + (x.notional ?? 0), 0)),
    shares_if_filled: shares,
    option_premium_at_risk: r2(options.filter(o => o.side === 'BUY').reduce((s, x) => s + x.premium, 0)),
    option_premium_credit: r2(options.filter(o => o.side === 'SELL').reduce((s, x) => s + x.premium, 0)),
  };
}

// ─── Convenience: broker position lookup ─────────────────────────────────────

export function findPosition(positions: SnapshotPosition[] | undefined, symbol: string): SnapshotPosition | null {
  const sym = symbol.toUpperCase();
  return (positions ?? []).find(p => !p.shadow && (p.symbol || '').toUpperCase() === sym) ?? null;
}

export function optionPositionsFor(options: OptionPosition[] | undefined, symbol: string): OptionPosition[] {
  const sym = symbol.toUpperCase();
  return (options ?? []).filter(p => (p.chain_symbol || p.symbol || '').toUpperCase() === sym);
}
