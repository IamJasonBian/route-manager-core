import {
  buildStockLedger,
  buildOptionLedger,
  buildDailyPnl,
  computeRiskStats,
  analyzeOpenOrders,
  inferOpeningShares,
  realizedVol,
  summarizeExposure,
  optionPositionKey,
  etDate,
  quantile,
  type DailyPnlPoint,
} from './tickerPnl';
import type { SnapshotOrder, SnapshotOptionOrder, OptionPosition } from '../services/robinhoodService';

let seq = 0;
function stock(side: 'BUY' | 'SELL', qty: number, price: number, at: string, extra: Partial<SnapshotOrder> = {}): SnapshotOrder {
  seq++;
  return {
    order_id: `o${seq}`,
    symbol: 'NBIS',
    side,
    order_type: 'limit',
    trigger: 'immediate',
    state: 'filled',
    quantity: qty,
    limit_price: price,
    stop_price: null,
    filled_quantity: qty,
    average_price: price,
    created_at: at,
    updated_at: at,
    ...extra,
  };
}

// NBIS order history from the Robinhood app, Oct 5–15 2026 (times are UTC)
const NBIS_HISTORY: SnapshotOrder[] = [
  stock('BUY', 35, 225.0, '2026-10-05T14:00:00Z'),
  stock('BUY', 0, 220.0, '2026-10-05T15:00:00Z', { state: 'cancelled', filled_quantity: 0, average_price: null }),
  stock('BUY', 10, 205.0, '2026-10-10T15:00:00Z'), // a Saturday — rolls to Monday's close
  stock('SELL', 35, 195.14, '2026-10-12T15:00:00Z', { order_type: 'market', trigger: 'stop', stop_price: 195.5 }),
  stock('BUY', 75, 207.11, '2026-10-13T14:00:00Z', { order_type: 'market' }),
  stock('BUY', 45, 186.6, '2026-10-14T13:35:00Z'),
  stock('SELL', 50, 180.11, '2026-10-14T14:00:00Z'),
  stock('BUY', 50, 170.0, '2026-10-14T15:00:00Z'),
  stock('SELL', 20, 175.01, '2026-10-14T16:00:00Z', { order_type: 'market', trigger: 'stop', stop_price: 175.2 }),
  stock('BUY', 1, 178.5, '2026-10-14T17:00:00Z'),
  stock('BUY', 1, 178.3, '2026-10-14T18:00:00Z'),
  stock('SELL', 110, 185.0, '2026-10-15T15:00:00Z'),
];

const BARS = [
  { date: '2026-10-02', close: 228 },
  { date: '2026-10-05', close: 224 },
  { date: '2026-10-06', close: 219 },
  { date: '2026-10-07', close: 214 },
  { date: '2026-10-08', close: 210 },
  { date: '2026-10-09', close: 206 },
  { date: '2026-10-12', close: 196 },
  { date: '2026-10-13', close: 205 },
  { date: '2026-10-14', close: 179 },
  { date: '2026-10-15', close: 184 },
];

describe('etDate', () => {
  it('converts UTC instants to the New York trading date', () => {
    expect(etDate(Date.parse('2026-10-15T03:30:00Z'))).toBe('2026-10-14');
    expect(etDate(Date.parse('2026-10-15T15:00:00Z'))).toBe('2026-10-15');
  });
});

describe('buildStockLedger', () => {
  const ledger = buildStockLedger(NBIS_HISTORY, 'NBIS');

  it('books average-cost realized P&L on every sell', () => {
    const sells = ledger.fills.filter(f => f.side === 'SELL').map(f => f.realized);
    expect(sells).toEqual([-889.54, -1046.73, -281.89, -430.46]);
    expect(ledger.realized_pnl).toBe(-2648.62);
    expect(ledger.losses).toBe(4);
    expect(ledger.wins).toBe(0);
  });

  it('tracks the remaining position and its average cost', () => {
    expect(ledger.shares_held).toBe(2);
    expect(ledger.avg_cost).toBeCloseTo(188.913, 3);
    expect(ledger.buy_count).toBe(7);
    expect(ledger.sell_count).toBe(4);
    expect(ledger.unmatched_quantity).toBe(0);
  });

  it('skips cancelled orders with no fills and labels order kinds', () => {
    expect(ledger.fills).toHaveLength(11);
    expect(ledger.fills[2].kind).toBe('Stop');
    expect(ledger.fills[3].kind).toBe('Market');
  });

  it('counts the filled part of a cancelled order', () => {
    const partial = buildStockLedger([
      stock('BUY', 10, 100, '2026-10-01T15:00:00Z', { state: 'cancelled', filled_quantity: 4, average_price: 99 }),
    ], 'NBIS');
    expect(partial.shares_held).toBe(4);
    expect(partial.fills[0].partial).toBe(true);
    expect(partial.total_bought).toBe(396);
  });

  it('dates a fill by its fill time, not its submission time', () => {
    const gtc = buildStockLedger([
      stock('BUY', 1, 100, '2026-10-01T15:00:00Z', { updated_at: '2026-10-06T15:00:00Z' }),
    ], 'NBIS');
    expect(gtc.fills[0].date).toBe('2026-10-06');
  });

  it('excludes sells with no known cost basis from realized P&L', () => {
    const orders = [stock('SELL', 10, 50, '2026-10-02T15:00:00Z'), stock('BUY', 5, 40, '2026-10-03T15:00:00Z')];
    const l = buildStockLedger(orders, 'NBIS');
    expect(l.unmatched_quantity).toBe(10);
    expect(l.realized_pnl).toBe(0);
    expect(l.fills[0].realized).toBeNull();
  });

  it('measures opening inventory from its mark', () => {
    const orders = [stock('SELL', 10, 50, '2026-10-02T15:00:00Z')];
    const opening = inferOpeningShares(orders, 'NBIS', 0);
    expect(opening).toBe(10);
    const l = buildStockLedger(orders, 'NBIS', { shares: opening, mark: 45 });
    expect(l.realized_pnl).toBe(50);
    expect(l.shares_held).toBe(0);
  });
});

describe('inferOpeningShares', () => {
  it('ignores fractional-share float noise', () => {
    // 0.7 + 0.1 = 0.7999999999999999 in floating point, 1.1e-16 short of the broker's 0.8
    const orders = [stock('BUY', 0.7, 186.75, '2026-10-01T15:00:00Z'), stock('BUY', 0.1, 185, '2026-10-03T15:00:00Z')];
    expect(inferOpeningShares(orders, 'NBIS', 0.8)).toBe(0);
    expect(inferOpeningShares(orders, 'NBIS', 0.9)).toBeCloseTo(0.1, 10);
  });

  it('reconciles the ledger with the broker position', () => {
    expect(inferOpeningShares(NBIS_HISTORY, 'NBIS', 2)).toBe(0);
    expect(inferOpeningShares(NBIS_HISTORY, 'NBIS', 12)).toBe(10);
    expect(inferOpeningShares(NBIS_HISTORY, 'NBIS', null)).toBe(0);
  });
});

describe('buildDailyPnl', () => {
  const ledger = buildStockLedger(NBIS_HISTORY, 'NBIS');
  const live = 190;
  const points = buildDailyPnl(ledger, BARS, { livePrice: live, today: '2026-10-16' });

  it('starts on the first fill day and appends a live point', () => {
    expect(points[0].date).toBe('2026-10-05');
    const last = points[points.length - 1];
    expect(last.date).toBe('2026-10-16');
    expect(last.live).toBe(true);
    expect(last.shares).toBe(2);
  });

  it('rolls a weekend fill into the next trading day', () => {
    const fri = points.find(p => p.date === '2026-10-09')!;
    const mon = points.find(p => p.date === '2026-10-12')!;
    expect(fri.shares).toBe(35);
    expect(mon.bought).toBe(10);
    expect(mon.sold).toBe(35);
    expect(mon.shares).toBe(10);
  });

  it('ends at realized + unrealized P&L', () => {
    const last = points[points.length - 1];
    const expected = ledger.realized_pnl + ledger.shares_held * (live - ledger.avg_cost);
    expect(last.cumulative).toBeCloseTo(expected, 1);
    const sumDaily = points.reduce((s, p) => s + p.pnl, 0);
    expect(sumDaily).toBeCloseTo(last.cumulative, 1);
  });

  it('marks a day-one position against the day-one close', () => {
    // 35 sh bought at 225, closed at 224
    expect(points[0].pnl).toBe(-35);
  });

  it('re-marks today\'s bar at the live price instead of appending', () => {
    const withToday = buildDailyPnl(ledger, [...BARS, { date: '2026-10-16', close: 188 }], { livePrice: live, today: '2026-10-16' });
    expect(withToday.filter(p => p.date === '2026-10-16')).toHaveLength(1);
    expect(withToday[withToday.length - 1].close).toBe(live);
  });

  it('flags a baseline point when fills predate the price history', () => {
    const early = buildStockLedger([stock('BUY', 1, 100, '2026-09-01T15:00:00Z')], 'NBIS');
    const pts = buildDailyPnl(early, BARS);
    expect(pts[0].baseline).toBe(true);
    expect(pts[0].pnl).toBe(0);
    expect(computeRiskStats(pts).days).toBe(BARS.length - 1);
  });
});

describe('computeRiskStats', () => {
  const mk = (pnls: number[]): DailyPnlPoint[] => {
    let cum = 0;
    return pnls.map((pnl, i) => {
      cum += pnl;
      return { date: `2026-01-${String(i + 1).padStart(2, '0')}`, close: 1, shares: 1, market_value: 1000, pnl, cumulative: cum, bought: 0, sold: 0, live: false, baseline: false };
    });
  };

  it('annualizes Sharpe on daily dollar P&L', () => {
    const stats = computeRiskStats(mk([10, -5, 20, -10, 5]));
    const m = 4;
    const sd = Math.sqrt([6, -9, 16, -14, 1].reduce((s, x) => s + x * x, 0) / 4);
    expect(stats.sharpe).toBeCloseTo((m / sd) * Math.sqrt(252), 6);
    expect(stats.total_pnl).toBe(20);
    expect(stats.best_day).toBe(20);
    expect(stats.worst_day).toBe(-10);
    expect(stats.up_days).toBe(3);
    expect(stats.reliable).toBe(false);
  });

  it('measures peak-to-trough drawdown of cumulative P&L', () => {
    const stats = computeRiskStats(mk([100, -30, -50, 20, -60, 200]));
    // peak 100 → trough 100−30−50+20−60 = −20 → drawdown 120
    expect(stats.max_drawdown).toBe(120);
    expect(stats.current_drawdown).toBe(0);
  });

  it('returns null Sharpe for a flat series', () => {
    expect(computeRiskStats(mk([0, 0, 0])).sharpe).toBeNull();
  });

  it('computes historical VaR from the loss tail', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    const stats = computeRiskStats(mk([-100, 10, 20, 30, 40, 50, 60, 70, 80, 90]));
    expect(stats.var95_hist).toBeGreaterThan(0);
  });
});

function option(direction: 'debit' | 'credit', price: number, at: string, leg: Partial<NonNullable<SnapshotOptionOrder['legs']>[number]> = {}, extra: Partial<SnapshotOptionOrder> = {}): SnapshotOptionOrder {
  seq++;
  return {
    order_id: `opt${seq}`,
    chain_symbol: 'NBIS',
    state: 'filled',
    quantity: 1,
    price,
    processed_premium: price * 100,
    direction,
    created_at: at,
    updated_at: at,
    legs: [{
      side: direction === 'debit' ? 'BUY' : 'SELL',
      position_effect: direction === 'debit' ? 'open' : 'close',
      option_type: 'call',
      strike_price: '220.0000',
      expiration_date: '2026-11-27',
      chain_symbol: 'NBIS',
      ...leg,
    }],
    ...extra,
  };
}

describe('buildOptionLedger', () => {
  it('realizes a closed round trip against its average cost', () => {
    const l = buildOptionLedger([
      option('debit', 11, '2026-10-16T14:00:00Z'),
      option('credit', 14, '2026-10-20T14:00:00Z'),
    ], 'NBIS');
    expect(l.realized_pnl).toBe(300);
    expect(l.contracts[0].position).toBe(0);
    expect(l.fills[0].realized).toBeNull();
    expect(l.fills[1].realized).toBe(300);
    expect(l.fills[0].contract.label).toBe('$220 Call 11/27');
  });

  it('writes off a long contract that expired without a closing order', () => {
    const l = buildOptionLedger(
      [option('debit', 3, '2026-09-01T14:00:00Z', { expiration_date: '2026-09-18' })],
      'NBIS',
      { today: '2026-10-16', openContractKeys: new Set() },
    );
    expect(l.realized_pnl).toBe(-300);
    expect(l.fills[l.fills.length - 1].expired).toBe(true);
    expect(l.fills[l.fills.length - 1].quantity).toBe(1);
  });

  it('keeps a still-held contract open past the expiry check', () => {
    const buy = option('debit', 3, '2026-09-01T14:00:00Z', { expiration_date: '2026-09-18' });
    const key = buildOptionLedger([buy], 'NBIS').contracts[0].contract.key;
    const l = buildOptionLedger([buy], 'NBIS', { today: '2026-10-16', openContractKeys: new Set([key]) });
    expect(l.realized_pnl).toBe(0);
  });

  it('books a short premium as profit when it expires', () => {
    const l = buildOptionLedger(
      [option('credit', 2, '2026-09-01T14:00:00Z', { position_effect: 'open', expiration_date: '2026-09-18' })],
      'NBIS',
      { today: '2026-10-16' },
    );
    expect(l.realized_pnl).toBe(200);
  });

  it('matches broker position keys', () => {
    const l = buildOptionLedger([option('debit', 11, '2026-10-16T14:00:00Z')], 'NBIS');
    const pos = { option_type: 'call', strike_price: '220.0000', expiration_date: '2026-11-27', quantity: 1, cost_basis: 1100, current_value: 1200, unrealized_pl: 100 } as OptionPosition;
    expect(optionPositionKey(pos)).toBe(l.contracts[0].contract.key);
  });
});

describe('analyzeOpenOrders', () => {
  it('projects queued stock and option orders', () => {
    const q = analyzeOpenOrders({
      stockOrders: [
        stock('SELL', 2, 200, '2026-10-16T08:00:00Z', { state: 'confirmed', filled_quantity: 0, average_price: null }),
        stock('BUY', 10, 180, '2026-10-16T08:00:00Z', { state: 'queued', filled_quantity: 0, average_price: null }),
      ],
      optionOrders: [
        option('debit', 11, '2026-10-16T08:15:00Z', {}, { state: 'queued', processed_premium: 0 }),
      ],
      symbol: 'NBIS',
      shares: 2,
      avgCost: 188.913,
      livePrice: 190,
      today: '2026-10-16',
    });
    expect(q.stock[0].projected_realized).toBeCloseTo(22.17, 2);
    expect(q.stock[1].avg_cost_after).toBe(180);
    expect(q.shares_if_filled).toBe(10);
    expect(q.buy_notional).toBe(1800);
    expect(q.options[0].premium).toBe(1100);
    expect(q.options[0].breakeven).toBe(231);
    expect(q.options[0].dte).toBe(42);
    expect(q.options[0].to_strike_pct).toBeCloseTo(30 / 190, 6);
    expect(q.option_premium_at_risk).toBe(1100);
  });
});

describe('exposure and volatility', () => {
  it('annualizes realized volatility of log returns', () => {
    const bars = [100, 101, 99, 102, 100].map((close, i) => ({ date: `2026-01-0${i + 1}`, close }));
    const vol = realizedVol(bars)!;
    expect(vol).toBeGreaterThan(0.2);
    expect(vol).toBeLessThan(0.5);
  });

  it('nets option delta dollars against stock exposure', () => {
    const exp = summarizeExposure({
      shares: 10,
      price: 100,
      options: [
        { option_type: 'call', quantity: 2, position_type: 'long', cost_basis: 500, current_value: 600, unrealized_pl: 100, greeks: { delta: 0.5, gamma: 0, theta: 0, vega: 0 } } as OptionPosition,
        { option_type: 'call', quantity: 1, position_type: 'short', cost_basis: -200, current_value: -150, unrealized_pl: 50, greeks: { delta: 0.25, gamma: 0, theta: 0, vega: 0 } } as OptionPosition,
      ],
      equity: 10_000,
      annVol: 0.5,
    });
    expect(exp.stock_value).toBe(1000);
    expect(exp.option_delta_dollars).toBe(10_000 - 2_500);
    expect(exp.net_delta_dollars).toBe(8_500);
    expect(exp.var95_param).toBeCloseTo(8_500 * (0.5 / Math.sqrt(252)) * 1.645, 1);
  });
});
