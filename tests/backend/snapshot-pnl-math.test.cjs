// Pins enriched-snapshot math bugs that skewed dashboard numbers:
//   - realized stock P&L for a period dropped cost basis of shares bought
//     before the period, so a sell inside it counted full proceeds as profit
//   - profit_loss_pct (already a percent) was re-scaled ×100 when |pct| < 1
//   - fills were ordered by submission time, so stops that triggered days
//     after they were placed were matched against the wrong average cost

const es = require('../../netlify/functions/enriched-snapshot.cjs');

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const order = (side, qty, price, daysAgo, symbol = 'AAPL') => ({
  symbol, side, state: 'filled',
  filled_quantity: qty, average_price: price, created_at: ago(daysAgo),
});

describe('computeStockPnl', () => {
  const cutoff = new Date(Date.now() - 7 * DAY);

  test('sell inside the window uses cost basis from a buy before it', () => {
    const pnl = es.computeStockPnl([
      order('buy', 10, 100, 30),
      order('sell', 10, 110, 2),
    ], cutoff);

    expect(pnl.total_realized_pnl).toBe(100); // (110 - 100) × 10, not 1100 proceeds
    expect(pnl.total_buy_volume).toBe(0);     // the buy is outside the window
    expect(pnl.total_sell_volume).toBe(1100);
    expect(pnl.filled_count).toBe(1);
    expect(pnl.symbols).toHaveLength(1);
  });

  test('sells before the window move cost basis but are not counted', () => {
    const pnl = es.computeStockPnl([
      order('buy', 10, 100, 40),
      order('sell', 5, 150, 20),   // realized outside the window
      order('buy', 5, 200, 10),    // basis now 5@100 + 5@200 → avg 150
      order('sell', 10, 160, 1),
    ], cutoff);

    expect(pnl.total_realized_pnl).toBe(100); // (160 - 150) × 10
  });

  test('orders are matched in fill order, not submission order', () => {
    // A stop placed 20 days ago that only triggered 2 days ago must be
    // matched against the add-on bought 10 days ago, as the broker does
    const stop = { ...order('sell', 20, 90, 20), updated_at: ago(2) };
    const pnl = es.computeStockPnl([
      order('buy', 10, 100, 30),
      stop,
      order('buy', 10, 80, 10),   // avg cost now (1000 + 800) / 20 = 90
    ], new Date(0));

    expect(pnl.total_realized_pnl).toBe(0); // (90 − 90) × 20, not a loss at the old 100 basis
    expect(pnl.symbols[0].shares_held).toBe(0);
  });

  test('the period window uses the fill time', () => {
    const stop = { ...order('sell', 10, 110, 20), updated_at: ago(2) };
    const pnl = es.computeStockPnl([order('buy', 10, 100, 30), stop], cutoff);
    expect(pnl.total_realized_pnl).toBe(100);
    expect(pnl.filled_count).toBe(1);
  });

  test('symbols with no fills in the window are omitted', () => {
    const pnl = es.computeStockPnl([
      order('buy', 10, 100, 30, 'MSFT'),
      order('buy', 1, 50, 1, 'AAPL'),
    ], cutoff);

    expect(pnl.symbols.map(s => s.symbol)).toEqual(['AAPL']);
  });
});

describe('normalizePosition profit_loss_pct', () => {
  test('profit_loss_pct is already a percent and is not re-scaled', () => {
    expect(es.normalizePosition({ symbol: 'AAPL', profit_loss_pct: 0.5 }).profit_loss_pct).toBe(0.5);
    expect(es.normalizePosition({ symbol: 'AAPL', profit_loss_pct: -0.8 }).profit_loss_pct).toBe(-0.8);
    expect(es.normalizePosition({ symbol: 'AAPL', profit_loss_pct: 12.34 }).profit_loss_pct).toBe(12.34);
  });

  test('legacy unrealized_pl_pct is a fraction and is scaled to percent', () => {
    expect(es.normalizePosition({ symbol: 'AAPL', unrealized_pl_pct: 0.09 }).profit_loss_pct).toBe(9);
    expect(es.normalizePosition({ symbol: 'AAPL', unrealized_pl_pct: 1.5 }).profit_loss_pct).toBe(150);
  });
});
