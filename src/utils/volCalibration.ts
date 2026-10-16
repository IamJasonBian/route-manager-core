// Volatility calibration for the Ticker P&L page: is the risk model
// (exposure × the underlying's vol) consistent with the P&L we actually got,
// and how does realized vol compare with what the options market implies?
//
//   realizedVolWindows — close-to-close realized vol over several lookbacks
//   varBacktest        — 1-day 95% VaR predicted from prior-close exposure and
//                        trailing vol, vs. realized day P&L (Kupiec POF test)
//   impliedVolAt       — interpolate a vol surface grid (dte × strike)
//   expectedMove       — ±1σ move implied by a vol over a horizon

import type { DailyPnlPoint, PriceBar } from './tickerPnl';

export const TRADING_DAYS = 252;
const Z_95 = 1.645;

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Daily log returns keyed by the later bar's date. */
export function logReturns(bars: PriceBar[]): { date: string; r: number }[] {
  const sorted = [...bars].filter(b => b.close > 0).sort((a, b) => a.date.localeCompare(b.date));
  const out: { date: string; r: number }[] = [];
  for (let i = 1; i < sorted.length; i++) out.push({ date: sorted[i].date, r: Math.log(sorted[i].close / sorted[i - 1].close) });
  return out;
}

export interface VolWindow {
  label: string;
  days: number;
  /** Annualized; null when the history is shorter than the window */
  vol: number | null;
}

export const VOL_WINDOWS: { label: string; days: number }[] = [
  { label: '10D', days: 10 },
  { label: '1M', days: 21 },
  { label: '3M', days: 63 },
  { label: '1Y', days: 252 },
];

export function realizedVolWindows(bars: PriceBar[], windows = VOL_WINDOWS): VolWindow[] {
  const rets = logReturns(bars).map(x => x.r);
  return windows.map(w => ({
    ...w,
    vol: rets.length >= w.days ? stdev(rets.slice(-w.days)) * Math.sqrt(TRADING_DAYS) : null,
  }));
}

// ─── VaR backtest ─────────────────────────────────────────────────────────────

export interface VarBacktestDay {
  date: string;
  /** Market value held at the prior close */
  exposure: number;
  /** Trailing daily σ of the underlying used for the forecast */
  sigma: number;
  /** Predicted 1-day 95% VaR (positive = loss) */
  var95: number;
  /** Predicted 1σ day P&L in dollars */
  predicted_sd: number;
  pnl: number;
  exceeded: boolean;
}

export interface VarBacktest {
  days: VarBacktestDay[];
  /** Days with a VaR forecast (exposure held into the day) */
  n: number;
  exceedances: number;
  /** Expected at 95%: 0.05 × n */
  expected: number;
  /** Kupiec proportion-of-failures likelihood-ratio p-value (null when n = 0) */
  kupiec_p: number | null;
  /** σ of realized day P&L ÷ RMS of predicted σ, over forecast days (1 = calibrated) */
  vol_ratio: number | null;
  /** Days whose P&L came mostly from trading that day rather than overnight exposure */
  trading_days: number;
}

/** Chi-square(1) survival function via the complementary error function. */
function chi2Sf1(x: number): number {
  if (x <= 0) return 1;
  return erfc(Math.sqrt(x / 2));
}

// Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7)
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return x >= 0 ? y : 2 - y;
}

/** Kupiec POF test: p-value that `x` exceedances in `n` days fit a `p` failure rate. */
export function kupiecPValue(n: number, x: number, p = 0.05): number | null {
  if (n <= 0) return null;
  const phat = x / n;
  const ll = (q: number) => (n - x) * Math.log(1 - q) + x * Math.log(q);
  // At x = 0 or x = n the unrestricted likelihood is exactly 1 (log 0)
  const llHat = x === 0 || x === n ? 0 : ll(phat);
  const lr = -2 * (ll(p) - llHat);
  return chi2Sf1(lr);
}

/**
 * Backtest a parametric VaR on the daily P&L curve. Each day's forecast uses
 * only what was known at the prior close: the position's market value then,
 * and the underlying's σ over the `window` returns ending that day.
 */
export function varBacktest(points: DailyPnlPoint[], bars: PriceBar[], window = 21): VarBacktest {
  const rets = logReturns(bars);
  const retIdx = new Map(rets.map((x, i) => [x.date, i]));
  const days: VarBacktestDay[] = [];
  let tradingDays = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const day = points[i];
    if (day.baseline) continue;
    const exposure = Math.abs(prev.market_value);
    // σ from returns strictly before this day
    const idx = retIdx.get(day.date) ?? rets.findIndex(x => x.date > prev.date);
    const end = idx >= 0 ? idx : rets.length;
    const hist = rets.slice(Math.max(0, end - window), end).map(x => x.r);
    if (exposure <= 0 || hist.length < 5) {
      if (day.bought + day.sold > 0) tradingDays++;
      continue;
    }
    const sigma = stdev(hist);
    const predicted = exposure * sigma;
    const var95 = Z_95 * predicted;
    // Overnight-only P&L would be prev shares × (close − prev close); a large
    // gap to the realized P&L means the day was driven by intraday trades
    const overnight = prev.shares * (day.close - prev.close);
    if (day.bought + day.sold > 0 && Math.abs(day.pnl - overnight) > Math.abs(overnight)) tradingDays++;
    days.push({
      date: day.date,
      exposure: Math.round(exposure * 100) / 100,
      sigma,
      var95: Math.round(var95 * 100) / 100,
      predicted_sd: Math.round(predicted * 100) / 100,
      pnl: day.pnl,
      exceeded: day.pnl < -var95,
    });
  }

  const n = days.length;
  const exceedances = days.filter(d => d.exceeded).length;
  const realizedSd = stdev(days.map(d => d.pnl));
  const predictedRms = n ? Math.sqrt(days.reduce((s, d) => s + d.predicted_sd ** 2, 0) / n) : 0;
  return {
    days,
    n,
    exceedances,
    expected: 0.05 * n,
    kupiec_p: kupiecPValue(n, exceedances),
    vol_ratio: n >= 2 && predictedRms > 0 ? realizedSd / predictedRms : null,
    trading_days: tradingDays,
  };
}

// ─── Implied vol ──────────────────────────────────────────────────────────────

export interface VolSurfaceGrid {
  underlying: string;
  spot: number;
  strikes: number[];
  dtes: number[];
  /** iv[dteIndex][strikeIndex], decimal (0.65 = 65%) */
  iv: (number | null)[][];
  source?: string;
}

function bracket(xs: number[], x: number): [number, number, number] {
  if (x <= xs[0]) return [0, 0, 0];
  if (x >= xs[xs.length - 1]) return [xs.length - 1, xs.length - 1, 0];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      const w = xs[i + 1] === xs[i] ? 0 : (x - xs[i]) / (xs[i + 1] - xs[i]);
      return [i, i + 1, w];
    }
  }
  return [xs.length - 1, xs.length - 1, 0];
}

/** Bilinear IV at (dte, strike), clamped to the grid; null on a gap. */
export function impliedVolAt(surface: VolSurfaceGrid, dte: number, strike: number): number | null {
  if (!surface.dtes.length || !surface.strikes.length) return null;
  const [d0, d1, wd] = bracket(surface.dtes, dte);
  const [k0, k1, wk] = bracket(surface.strikes, strike);
  const at = (d: number, k: number) => {
    const v = surface.iv[d]?.[k];
    return v != null && Number.isFinite(v) && v > 0 ? (v > 3 ? v / 100 : v) : null;
  };
  const corners = [at(d0, k0), at(d0, k1), at(d1, k0), at(d1, k1)];
  if (corners.some(c => c == null)) {
    const known = corners.filter((c): c is number => c != null);
    return known.length ? known.reduce((s, c) => s + c, 0) / known.length : null;
  }
  const [a, b, c, d] = corners as number[];
  const top = a + (b - a) * wk;
  const bottom = c + (d - c) * wk;
  return top + (bottom - top) * wd;
}

/** ±1σ fractional move over `days` calendar days implied by an annualized vol. */
export function expectedMove(vol: number, days: number): number {
  return vol * Math.sqrt(Math.max(days, 0) / 365);
}
