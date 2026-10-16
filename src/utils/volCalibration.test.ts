import {
  logReturns,
  realizedVolWindows,
  varBacktest,
  kupiecPValue,
  impliedVolAt,
  expectedMove,
  type VolSurfaceGrid,
} from './volCalibration';
import type { DailyPnlPoint, PriceBar } from './tickerPnl';

function bars(closes: number[], start = Date.UTC(2026, 0, 1)): PriceBar[] {
  return closes.map((close, i) => ({ date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), close }));
}

describe('realized vol', () => {
  it('annualizes close-to-close log returns per window', () => {
    // Alternating ±1% moves: σ of log returns ≈ 0.01
    const closes = [100];
    for (let i = 0; i < 300; i++) closes.push(closes[closes.length - 1] * (i % 2 ? 1.01 : 0.99));
    const w = realizedVolWindows(bars(closes));
    expect(w.map(x => x.label)).toEqual(['10D', '1M', '3M', '1Y']);
    // Sample σ (n − 1) of ±1% moves over n days
    for (const x of w) expect(x.vol).toBeCloseTo(0.01 * Math.sqrt(252) * Math.sqrt(x.days / (x.days - 1)), 2);
  });

  it('returns null when the history is shorter than the window', () => {
    const w = realizedVolWindows(bars([100, 101, 102]));
    expect(w.every(x => x.vol === null)).toBe(true);
    expect(logReturns(bars([100, 110]))[0].r).toBeCloseTo(Math.log(1.1), 10);
  });
});

describe('kupiecPValue', () => {
  it('accepts a 5% exceedance rate and rejects a far higher one', () => {
    expect(kupiecPValue(100, 5)!).toBeGreaterThan(0.9);
    expect(kupiecPValue(100, 20)!).toBeLessThan(0.001);
    expect(kupiecPValue(100, 0)!).toBeLessThan(0.05); // zero breaches in 100 days is also unlikely
    expect(kupiecPValue(0, 0)).toBeNull();
  });
});

describe('varBacktest', () => {
  // 40 days of ±1% underlying moves, then a −8% day
  const closes = [100];
  for (let i = 0; i < 40; i++) closes.push(closes[closes.length - 1] * (i % 2 ? 1.01 : 0.99));
  closes.push(closes[closes.length - 1] * 0.92);
  const priceBars = bars(closes);

  // Hold 100 shares the whole time, no trading
  const points: DailyPnlPoint[] = priceBars.slice(1).map((b, i) => ({
    date: b.date, close: b.close, shares: 100, market_value: 100 * b.close,
    pnl: 100 * (b.close - priceBars[i].close), cumulative: 0, bought: 0, sold: 0, live: false, baseline: false,
  }));

  it('forecasts from prior-close exposure and flags the breach', () => {
    const bt = varBacktest(points, priceBars);
    expect(bt.n).toBeGreaterThan(30);
    const last = bt.days[bt.days.length - 1];
    expect(last.exceeded).toBe(true);
    expect(last.var95).toBeCloseTo(1.645 * last.exposure * last.sigma, 1);
    expect(bt.exceedances).toBe(1);
    expect(bt.trading_days).toBe(0);
  });

  it('reports realized ÷ predicted P&L volatility', () => {
    const bt = varBacktest(points.slice(0, -1), priceBars.slice(0, -1));
    expect(bt.vol_ratio).toBeGreaterThan(0.8);
    expect(bt.vol_ratio).toBeLessThan(1.25);
  });

  it('skips flat days', () => {
    const flat = points.map(p => ({ ...p, shares: 0, market_value: 0, pnl: 0 }));
    expect(varBacktest(flat, priceBars).n).toBe(0);
  });
});

describe('impliedVolAt', () => {
  const surface: VolSurfaceGrid = {
    underlying: 'NBIS', spot: 200, strikes: [180, 200, 220], dtes: [14, 42],
    iv: [[0.9, 0.8, 0.85], [0.8, 0.7, 0.75]],
  };

  it('interpolates bilinearly and clamps outside the grid', () => {
    expect(impliedVolAt(surface, 14, 200)).toBeCloseTo(0.8, 10);
    expect(impliedVolAt(surface, 28, 200)).toBeCloseTo(0.75, 10);
    expect(impliedVolAt(surface, 42, 210)).toBeCloseTo(0.725, 10);
    expect(impliedVolAt(surface, 365, 500)).toBeCloseTo(0.75, 10);
  });

  it('reads percent-scaled grids and averages around gaps', () => {
    expect(impliedVolAt({ ...surface, iv: [[90, 80, 85], [80, 70, 75]] }, 14, 200)).toBeCloseTo(0.8, 10);
    expect(impliedVolAt({ ...surface, iv: [[0.9, null, 0.85], [0.8, 0.7, 0.75]] }, 14, 190)).toBeCloseTo(0.9, 10);
  });

  it('turns vol into an expected move', () => {
    expect(expectedMove(0.8, 365)).toBeCloseTo(0.8, 10);
    expect(expectedMove(0.8, 42)).toBeCloseTo(0.8 * Math.sqrt(42 / 365), 10);
  });
});
