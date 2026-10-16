// Per-ticker P&L, Sharpe and risk — /ticker/:symbol (defaults to NBIS).
//
// Orders come from the trading DB (every bucket for the ticker), falling back
// to the blob snapshot's recent orders while the DB is empty or unreachable.
// The broker position, option positions and account equity come from the
// enriched snapshot; daily closes from Twelve Data. The market at each fill
// (NBBO, minute bar), live option quotes and the vol surface come from the
// market-context function (Alpaca). Math lives in utils/tickerPnl.ts,
// utils/volCalibration.ts and utils/fillQuality.ts.

import { useState, useEffect, useCallback, useMemo, useRef, type FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { RefreshCw, AlertTriangle, DownloadCloud } from 'lucide-react';
import {
  getEnrichedSnapshot,
  getDbOrdersForSymbol,
  formatCurrency,
  type EnrichedSnapshot,
  type DbOrders,
  type SnapshotOrder,
  type SnapshotOptionOrder,
} from '../services/robinhoodService';
import { getTimeSeries, getQuotes, type NormalizedPriceData } from '../services/twelveDataService';
import {
  getFillContext,
  getOptionSnapshots,
  getVolSurface,
  triggerSnapshotRefresh,
  type OptionSnapshot,
  type SurfaceResponse,
} from '../services/marketContextService';
import { realizedVolWindows, varBacktest, impliedVolAt, expectedMove } from '../utils/volCalibration';
import { assessFill, summarizeFillQuality, occSymbol, PLACEMENT_LABEL, type FillMarketContext } from '../utils/fillQuality';
import {
  buildStockLedger,
  buildOptionLedger,
  buildDailyPnl,
  computeRiskStats,
  realizedVol,
  summarizeExposure,
  analyzeOpenOrders,
  inferOpeningShares,
  findPosition,
  optionPositionsFor,
  optionPositionKey,
  isOpenState,
  etDate,
  MIN_RELIABLE_DAYS,
  VOL_WINDOW,
  type PriceBar,
} from '../utils/tickerPnl';
import {
  Card,
  StatTile,
  CumulativePnlChart,
  PriceFillsChart,
  StockFillsTable,
  OptionFillsTable,
  QueuedOrdersTables,
  OptionPositionsTable,
  DailyPnlTable,
  type OptionMarketView,
} from '../components/TickerPnLPanels';
import { VarBacktestChart, FillQualityGroups, FillQualityTable } from '../components/TickerCalibrationPanels';
import { formatSignedUsd as fmtSigned, formatSignedFraction as fmtPct, formatBps } from '../utils/formatters';
import { utcMs } from '../utils/time';

const DEFAULT_SYMBOL = 'NBIS';
const PINNED = ['NBIS'];
// Placement stubs (no lifecycle state) older than this are stale, not queued
const STUB_MAX_AGE_MS = 3 * 86_400_000;
// Broker data older than this is called out as stale
const SYNC_STALE_MS = 6 * 3_600_000;
// Fills sent for execution-time market context (most recent first)
const MAX_FILL_CONTEXT = 120;
// Tenor for the headline ATM implied vol
const ATM_IV_DTE = 30;

function fmtEt(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}

function fmtAgo(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function fmtVol(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;
}

type DbResult = DbOrders & { truncated: boolean };

/** Share counts can be fractional; trim float noise for display. */
function shares(q: number): string {
  return String(+q.toFixed(4));
}

function dedupe<T extends { order_id: string }>(orders: T[]): T[] {
  const seen = new Set<string>();
  return orders.filter(o => {
    if (!o.order_id || seen.has(o.order_id)) return !o.order_id;
    seen.add(o.order_id);
    return true;
  });
}

interface OrderSet {
  source: 'db' | 'snapshot' | 'none';
  stock: SnapshotOrder[];
  options: SnapshotOptionOrder[];
  openStock: SnapshotOrder[];
  openOptions: SnapshotOptionOrder[];
  untrackedStock: SnapshotOrder[];
  untrackedOptions: SnapshotOptionOrder[];
}

function pickOrders(symbol: string, db: DbResult | null, snapshot: EnrichedSnapshot | null): OrderSet {
  const dbCount = db
    ? db.open_orders.length + db.historical_orders.length + db.open_option_orders.length + db.historical_option_orders.length
    : 0;
  if (db && dbCount > 0) {
    return {
      source: 'db',
      stock: dedupe([...db.historical_orders, ...db.open_orders]),
      options: dedupe([...db.historical_option_orders, ...db.open_option_orders]),
      openStock: db.open_orders,
      openOptions: db.open_option_orders,
      untrackedStock: db.untracked_orders ?? [],
      untrackedOptions: db.untracked_option_orders ?? [],
    };
  }
  if (snapshot) {
    const sym = symbol.toUpperCase();
    const ofSym = (o: SnapshotOrder) => (o.symbol || '').toUpperCase() === sym;
    const optOfSym = (o: SnapshotOptionOrder) => (o.chain_symbol || o.legs?.[0]?.chain_symbol || '').toUpperCase() === sym;
    const working = dedupe([...snapshot.portfolio.open_orders, ...snapshot.order_book]).filter(ofSym);
    const workingOpts = dedupe([...snapshot.portfolio.open_option_orders, ...snapshot.recent_option_orders]).filter(optOfSym);
    return {
      source: 'snapshot',
      stock: dedupe([...snapshot.recent_orders, ...working]).filter(ofSym),
      options: dedupe([...snapshot.recent_option_orders, ...snapshot.portfolio.open_option_orders]).filter(optOfSym),
      openStock: working.filter(o => isOpenState(o.state)),
      openOptions: workingOpts.filter(o => isOpenState(o.state)),
      untrackedStock: working.filter(o => o.state == null),
      untrackedOptions: workingOpts.filter(o => o.state == null),
    };
  }
  return { source: 'none', stock: [], options: [], openStock: [], openOptions: [], untrackedStock: [], untrackedOptions: [] };
}

export default function TickerPnLPage() {
  const params = useParams<{ symbol?: string }>();
  const navigate = useNavigate();
  const symbol = (params.symbol || DEFAULT_SYMBOL).toUpperCase();

  const [snapshot, setSnapshot] = useState<EnrichedSnapshot | null>(null);
  const [db, setDb] = useState<DbResult | null>(null);
  const [series, setSeries] = useState<NormalizedPriceData[]>([]);
  const [quote, setQuote] = useState<{ price: number; timestamp: number } | null>(null);
  const [errors, setErrors] = useState<{ snapshot?: string; db?: string; prices?: string; surface?: string }>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [tickerInput, setTickerInput] = useState('');
  const [surface, setSurface] = useState<SurfaceResponse | null>(null);
  const [fillCtx, setFillCtx] = useState<Map<string, FillMarketContext>>(() => new Map());
  // `key` is the symbol + fill set the context belongs to; a different key means it is still loading
  const [fillCtxState, setFillCtxState] = useState<{ key: string | null; error: string | null }>({ key: null, error: null });
  const [optionSnaps, setOptionSnaps] = useState<Map<string, OptionSnapshot>>(() => new Map());
  const [sync, setSync] = useState<{ running: boolean; ok: boolean | null; message: string | null }>({ running: false, ok: null, message: null });
  // Only the latest request may write state — switching tickers mid-load must
  // not render the previous ticker's prices under the new one
  const requestRef = useRef(0);

  const fetchData = useCallback(async (sym: string, isRefresh = false) => {
    const request = ++requestRef.current;
    if (isRefresh) setRefreshing(true); else setLoading(true);
    const [snap, orders, prices, vol, quotes] = await Promise.allSettled([
      getEnrichedSnapshot(),
      getDbOrdersForSymbol(sym),
      getTimeSeries(sym, '1Y', isRefresh),
      getVolSurface(sym),
      getQuotes([sym]),
    ]);
    if (request !== requestRef.current) return;
    const msg = (r: PromiseSettledResult<unknown>) =>
      r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : undefined;
    setSnapshot(snap.status === 'fulfilled' ? snap.value : null);
    setDb(orders.status === 'fulfilled' ? orders.value : null);
    setSeries(prices.status === 'fulfilled' ? prices.value : []);
    setSurface(vol.status === 'fulfilled' && vol.value.ok ? vol.value : null);
    setQuote(quotes.status === 'fulfilled' ? quotes.value[sym] ?? null : null);
    setErrors({ snapshot: msg(snap), db: msg(orders), prices: msg(prices), surface: msg(vol) });
    setAsOf(Date.now());
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { fetchData(symbol); }, [fetchData, symbol]);

  const model = useMemo(() => {
    const today = etDate(Date.now());
    const orders = pickOrders(symbol, db, snapshot);
    const bars: PriceBar[] = series
      .map(b => ({ date: b.date.slice(0, 10), close: b.price }))
      .filter(b => Number.isFinite(b.close) && b.close > 0);

    const position = findPosition(snapshot?.portfolio.positions, symbol);
    const brokerQty = snapshot ? (position?.quantity ?? 0) : null;
    // Mark at the freshest price available: a Twelve Data quote, the
    // Robinhood snapshot (as of its last sync), or the last daily close
    const snapshotMs = snapshot ? utcMs(snapshot.timestamp) : NaN;
    const lastBar = bars.length ? bars[bars.length - 1] : null;
    const marks = [
      quote && quote.price > 0 ? { price: quote.price, at: quote.timestamp, source: 'Twelve Data' } : null,
      position?.current_price ? { price: position.current_price, at: snapshotMs, source: 'Robinhood' } : null,
      lastBar ? { price: lastBar.close, at: Date.parse(`${lastBar.date}T20:00:00Z`), source: 'last close' } : null,
    ].filter((m): m is { price: number; at: number; source: string } => m != null && Number.isFinite(m.at))
      .sort((a, b) => b.at - a.at);
    const mark = marks[0] ?? null;
    const livePrice = mark?.price ?? null;
    const priceSource = mark ? `${mark.source}, ${fmtEt(mark.at)}` : null;

    // Shares held before the first tracked order, marked at the prior close
    const base = buildStockLedger(orders.stock, symbol);
    const opening = inferOpeningShares(orders.stock, symbol, brokerQty);
    let ledger = base;
    if (opening > 0) {
      const firstDate = base.fills[0]?.date ?? today;
      const prior = [...bars].reverse().find(b => b.date < firstDate);
      ledger = buildStockLedger(orders.stock, symbol, { shares: opening, mark: prior?.close ?? null });
    }

    const optionPositions = optionPositionsFor(snapshot?.portfolio.options, symbol);
    const optionLedger = buildOptionLedger(orders.options, symbol, {
      openContractKeys: new Set(optionPositions.map(optionPositionKey)),
      today,
    });

    const points = buildDailyPnl(ledger, bars, { livePrice, today });
    const risk = computeRiskStats(points);
    const vol = realizedVol(bars);
    const exposure = summarizeExposure({
      shares: brokerQty ?? ledger.shares_held,
      price: livePrice,
      options: optionPositions,
      equity: snapshot?.portfolio.equity ?? null,
      annVol: vol,
    });
    const now = Date.now();
    const fresh = (o: { created_at: string | null; updated_at: string | null }) =>
      now - utcMs(o.created_at ?? o.updated_at) < STUB_MAX_AGE_MS;
    const untrackedStock = orders.untrackedStock.filter(fresh);
    const untrackedOptions = orders.untrackedOptions.filter(fresh);
    const staleStubs = orders.untrackedStock.length + orders.untrackedOptions.length - untrackedStock.length - untrackedOptions.length;
    const queue = analyzeOpenOrders({
      stockOrders: orders.openStock,
      optionOrders: orders.openOptions,
      untrackedStock,
      untrackedOptions,
      symbol,
      shares: ledger.shares_held,
      avgCost: ledger.avg_cost,
      livePrice,
      today,
    });

    const trackedShares = ledger.shares_held - ledger.unknown_basis_shares;
    const unrealized = livePrice != null && trackedShares > 0 ? trackedShares * (livePrice - ledger.avg_cost) : 0;
    const stockPnl = ledger.realized_pnl + unrealized;
    const optionPnl = optionLedger.realized_pnl + exposure.option_unrealized;
    const closedTrades = ledger.wins + ledger.losses;

    const warnings: string[] = [];
    if (orders.source === 'snapshot') warnings.push('The trading DB has no orders for this ticker, so this view uses the last blob snapshot, which only covers recent orders.');
    if (orders.source === 'none') warnings.push('No order data could be loaded.');
    if (db?.truncated) warnings.push('Order history hit the 10-page fetch cap, so the oldest orders are missing.');
    if (brokerQty != null && ledger.shares_held - brokerQty > 1e-6) {
      warnings.push(`The fill history leaves ${shares(ledger.shares_held)} shares but Robinhood reports ${shares(brokerQty)}. Recent fills may not have synced to the DB yet.`);
    }
    if (ledger.opening_shares > 0) {
      warnings.push(ledger.opening_mark != null
        ? `${shares(ledger.opening_shares)} shares were held before the first tracked order. They're valued at the prior close (${formatCurrency(ledger.opening_mark)}), so their P&L counts from then.`
        : `${shares(ledger.opening_shares)} shares were held before the first tracked order and have no known cost basis; sales of them are left out of realized P&L.`);
    }
    if (ledger.unmatched_quantity > 0 && ledger.opening_mark == null) {
      warnings.push(`${shares(ledger.unmatched_quantity)} shares sold had no tracked cost basis and are left out of realized P&L (marked *).`);
    }
    if (ledger.skipped_fills > 0) warnings.push(`${ledger.skipped_fills} filled orders had no fill price and were skipped.`);
    if (errors.prices) warnings.push(`Price history is unavailable (${errors.prices}), so the daily P&L, Sharpe and VaR can't be computed.`);
    const lastSync = snapshot ? utcMs(snapshot.timestamp) : NaN;
    if (Number.isFinite(lastSync) && Date.now() - lastSync > SYNC_STALE_MS) {
      warnings.push(`Robinhood data was last synced ${fmtEt(lastSync)} (${fmtAgo(Date.now() - lastSync)}). Fills and order changes since then aren't included. Use "Sync now" to pull them.`);
    }

    return {
      today, orders, bars, position, brokerQty, livePrice, priceSource, ledger, optionLedger, lastSync,
      optionPositions, points, risk, vol, exposure, queue, staleStubs, unrealized, stockPnl, optionPnl,
      totalPnl: stockPnl + optionPnl, closedTrades, warnings,
    };
  }, [symbol, db, snapshot, series, quote, errors.prices]);

  // ── Market at each execution (NBBO + minute bar), most recent fills first ──
  const fillTimes = useMemo(
    () => model.ledger.fills.slice(-MAX_FILL_CONTEXT).map(f => new Date(f.time).toISOString()),
    [model.ledger.fills],
  );
  const fillKey = `${symbol}|${fillTimes.join(',')}`;
  useEffect(() => {
    if (!fillTimes.length) { setFillCtx(new Map()); setFillCtxState({ key: fillKey, error: null }); return; }
    let cancelled = false;
    getFillContext(symbol, [...fillTimes].reverse())
      .then(rows => {
        if (cancelled) return;
        setFillCtx(new Map(rows.map(r => [new Date(r.t).toISOString(), r])));
        setFillCtxState({ key: fillKey, error: null });
      })
      .catch(err => {
        if (!cancelled) setFillCtxState({ key: fillKey, error: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
    // fillKey captures symbol + fill times
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillKey]);

  // ── Live quotes for working option orders and held contracts ──
  const occList = useMemo(() => {
    const set = new Set<string>();
    for (const q of model.queue.options) {
      const c = q.contract;
      if (c.strike != null && c.expiration && c.option_type && c.option_type !== 'spread') {
        const occ = occSymbol(symbol, c.expiration, c.option_type, c.strike);
        if (occ) set.add(occ);
      }
    }
    for (const p of model.optionPositions) {
      const exp = p.expiration_date ?? p.expiration;
      const strike = Number(p.strike_price ?? p.strike);
      const occ = exp ? occSymbol(symbol, exp, p.option_type, strike) : null;
      if (occ) set.add(occ);
    }
    return [...set].sort();
  }, [model.queue.options, model.optionPositions, symbol]);
  const occKey = occList.join(',');
  useEffect(() => {
    if (!occList.length) { setOptionSnaps(new Map()); return; }
    let cancelled = false;
    getOptionSnapshots(occList)
      .then(rows => { if (!cancelled) setOptionSnaps(new Map(rows.filter(r => r.found).map(r => [r.occ, r]))); })
      .catch(() => { if (!cancelled) setOptionSnaps(new Map()); });
    return () => { cancelled = true; };
    // occKey captures the contract list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occKey]);

  // ── Vol calibration ──
  const calibration = useMemo(() => {
    const windows = realizedVolWindows(model.bars);
    const backtest = varBacktest(model.points, model.bars);
    const grid = surface?.surface ?? null;
    const spot = model.livePrice ?? grid?.spot ?? null;
    const atmIv = grid && spot ? impliedVolAt(grid, ATM_IV_DTE, spot) : null;
    const rv1m = windows.find(w => w.label === '1M')?.vol ?? null;
    return {
      windows,
      backtest,
      grid,
      atmIv,
      rv1m,
      ivSource: surface?.meta?.source ?? null,
      ivAsOf: surface?.meta?.timestamp ?? null,
    };
  }, [model.bars, model.points, model.livePrice, surface]);

  const optionMarket = useMemo(() => {
    const out = new Map<string, OptionMarketView>();
    for (const q of model.queue.options) {
      const c = q.contract;
      const occ = c.strike != null && c.expiration && c.option_type !== 'spread' ? occSymbol(symbol, c.expiration, c.option_type, c.strike) : null;
      const snap = occ ? optionSnaps.get(occ) : undefined;
      const surfaceIv = calibration.grid && c.strike != null && q.dte != null ? impliedVolAt(calibration.grid, q.dte, c.strike) : null;
      const iv = snap?.iv ?? surfaceIv;
      const bid = snap?.bid ?? null;
      const ask = snap?.ask ?? null;
      out.set(q.order.order_id, {
        bid, ask,
        bid_size: snap?.bid_size ?? null,
        ask_size: snap?.ask_size ?? null,
        mid: bid != null && ask != null && ask >= bid && ask > 0 ? (bid + ask) / 2 : null,
        iv: iv ?? null,
        iv_source: snap?.iv != null ? 'contract' : surfaceIv != null ? 'surface' : null,
        delta: snap?.greeks?.delta ?? null,
        expected_move: iv != null && q.dte != null ? expectedMove(iv, q.dte) : null,
        needed_move: q.breakeven != null && model.livePrice ? (q.breakeven - model.livePrice) / model.livePrice : null,
      });
    }
    return out;
  }, [model.queue.options, model.livePrice, optionSnaps, calibration.grid, symbol]);

  // ── Fill quality ──
  const fillQuality = useMemo(() => {
    const rows = model.ledger.fills.map(f => assessFill(f, fillCtx.get(new Date(f.time).toISOString())));
    return { rows, summary: summarizeFillQuality(rows) };
  }, [model.ledger.fills, fillCtx]);

  const runSync = async () => {
    setSync({ running: true, ok: null, message: null });
    try {
      const r = await triggerSnapshotRefresh();
      if (r.skipped) {
        setSync({ running: false, ok: true, message: `Already fresh: ${r.skipped}` });
      } else if (r.ok) {
        const warn = r.errors?.length ? `, ${r.errors.length} warning${r.errors.length > 1 ? 's' : ''}` : '';
        setSync({ running: false, ok: true, message: `Synced in ${((r.elapsed_ms ?? 0) / 1000).toFixed(1)}s${warn}` });
        await fetchData(symbol, true);
      } else {
        setSync({ running: false, ok: false, message: r.error || 'Sync failed' });
      }
    } catch (err) {
      setSync({ running: false, ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  };

  // Tickers worth one click: pinned, held, or with working orders
  const tickerChips = useMemo(() => {
    const set = new Set<string>(PINNED);
    for (const p of snapshot?.portfolio.positions ?? []) {
      if (!p.shadow && p.asset_type !== 'crypto' && p.symbol) set.add(p.symbol.toUpperCase());
    }
    for (const o of snapshot?.portfolio.open_orders ?? []) if (o.symbol) set.add(o.symbol.toUpperCase());
    for (const o of snapshot?.portfolio.options ?? []) if (o.chain_symbol) set.add(o.chain_symbol.toUpperCase());
    for (const o of snapshot?.portfolio.open_option_orders ?? []) if (o.chain_symbol) set.add(o.chain_symbol.toUpperCase());
    set.add(symbol);
    return [...set].sort((a, b) => (PINNED.includes(b) ? 1 : 0) - (PINNED.includes(a) ? 1 : 0) || a.localeCompare(b));
  }, [snapshot, symbol]);

  const goTo = (e: FormEvent) => {
    e.preventDefault();
    const next = tickerInput.trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (next) navigate(`/ticker/${next}`);
    setTickerInput('');
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 dark:bg-zinc-800 rounded w-64 mb-4" />
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-24 bg-gray-200 dark:bg-zinc-800 rounded-xl" />)}
          </div>
          <div className="h-72 bg-gray-200 dark:bg-zinc-800 rounded-xl" />
        </div>
      </div>
    );
  }

  const { ledger, optionLedger, risk, exposure, queue, livePrice } = model;
  const winRate = model.closedTrades > 0 ? ledger.wins / model.closedTrades : null;
  const profitFactor = ledger.gross_loss > 0 ? ledger.gross_win / ledger.gross_loss : null;
  const lowSample = !risk.reliable ? `${risk.days} days, low sample` : `${risk.days} days`;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{symbol} P&amp;L &amp; risk</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">
            {livePrice != null ? <>Last {formatCurrency(livePrice)} <span className="text-xs">({model.priceSource})</span> · </> : null}
            Orders from <span className="px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-zinc-800 rounded">{model.orders.source}</span>
            {asOf && <> · as of {new Date(asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {tickerChips.map(t => (
              <Link
                key={t}
                to={`/ticker/${t}`}
                className={`px-2.5 py-1 rounded-md text-xs font-mono font-medium border transition-colors ${
                  t === symbol
                    ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 border-gray-900 dark:border-white'
                    : 'border-gray-300 dark:border-zinc-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-800'
                }`}
              >
                {t}
              </Link>
            ))}
          </div>
          <form onSubmit={goTo} className="flex">
            <input
              value={tickerInput}
              onChange={e => setTickerInput(e.target.value)}
              placeholder="Ticker"
              aria-label="Go to ticker"
              className="w-20 px-2 py-1 text-xs font-mono uppercase rounded-l-md border border-gray-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-gray-900 dark:text-gray-100"
            />
            <button type="submit" className="px-2 py-1 text-xs rounded-r-md border border-l-0 border-gray-300 dark:border-zinc-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-800">Go</button>
          </form>
          <button
            onClick={() => fetchData(symbol, true)}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-1.5 border border-gray-300 dark:border-zinc-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-50 text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={runSync}
            disabled={sync.running}
            title="Pull the latest orders and positions from Robinhood into the trading DB (at most once a minute)"
            className="flex items-center gap-2 px-3 py-1.5 border border-gray-300 dark:border-zinc-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-50 dark:hover:bg-zinc-800 disabled:opacity-50 text-sm"
          >
            <DownloadCloud className={`w-4 h-4 ${sync.running ? 'animate-pulse' : ''}`} />
            {sync.running ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 -mt-3 text-xs text-gray-500 dark:text-gray-400">
        {Number.isFinite(model.lastSync) && (
          <span className={Date.now() - model.lastSync > SYNC_STALE_MS ? 'text-amber-700 dark:text-amber-400' : undefined}>
            Robinhood sync {fmtEt(model.lastSync)} · {fmtAgo(Date.now() - model.lastSync)}
          </span>
        )}
        {ledger.fills.length > 0 && <span>Last fill {fmtEt(ledger.fills[ledger.fills.length - 1].time)}</span>}
        {sync.message && (
          <span className={sync.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>Sync: {sync.message}</span>
        )}
      </div>

      {model.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-900 dark:text-amber-200">
          <div className="flex items-center gap-2 font-medium mb-1"><AlertTriangle className="w-4 h-4" /> Data notes</div>
          <ul className="list-disc ml-6 space-y-0.5">{model.warnings.map(w => <li key={w}>{w}</li>)}</ul>
        </div>
      )}

      {/* ── P&L ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatTile label="Total P&L" value={fmtSigned(model.totalPnl)} tone={model.totalPnl} sub="Stock + options, realized + open" />
        <StatTile label="Realized (stock)" value={fmtSigned(ledger.realized_pnl)} tone={ledger.realized_pnl} sub={`${ledger.sell_count} sells · ${ledger.buy_count} buys`} />
        <StatTile
          label="Unrealized (stock)"
          value={fmtSigned(model.unrealized)}
          tone={model.unrealized}
          sub={ledger.shares_held > 0 ? `${shares(ledger.shares_held)} sh @ ${ledger.avg_cost > 0 ? formatCurrency(ledger.avg_cost) : '—'} avg` : 'Flat'}
        />
        <StatTile
          label="Options P&L"
          value={fmtSigned(model.optionPnl)}
          tone={model.optionPnl}
          sub={`${fmtSigned(optionLedger.realized_pnl)} realized · ${fmtSigned(exposure.option_unrealized)} open`}
        />
        <StatTile
          label="Win rate"
          value={winRate != null ? `${Math.round(winRate * 100)}%` : '—'}
          sub={model.closedTrades ? `${ledger.wins}W / ${ledger.losses}L · PF ${profitFactor != null ? profitFactor.toFixed(2) : '∞'}` : 'No closing sells yet'}
        />
        <StatTile
          label="Turnover"
          value={formatCurrency(ledger.total_bought + ledger.total_sold)}
          sub={`${formatCurrency(ledger.total_bought)} bought · ${formatCurrency(ledger.total_sold)} sold`}
        />
      </div>

      {/* ── Risk ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatTile
          label="Sharpe (ann.)"
          value={risk.sharpe != null ? risk.sharpe.toFixed(2) : '—'}
          sub={lowSample}
          title={`Mean ÷ σ of daily dollar P&L × √252, risk-free rate 0. Below ${MIN_RELIABLE_DAYS} days the estimate is noisy.`}
        />
        <StatTile
          label="Sortino (ann.)"
          value={risk.sortino != null ? risk.sortino.toFixed(2) : '—'}
          sub={`${risk.up_days} up / ${risk.down_days} down days`}
        />
        <StatTile
          label="Max drawdown"
          value={risk.max_drawdown > 0 ? `−${formatCurrency(risk.max_drawdown)}` : formatCurrency(0)}
          tone={risk.max_drawdown > 0 ? -1 : undefined}
          sub={risk.current_drawdown > 0 ? `${formatCurrency(risk.current_drawdown)} below peak now` : 'At peak'}
        />
        <StatTile
          label="P&L volatility"
          value={formatCurrency(risk.ann_vol_pnl)}
          sub={`annualized · best ${fmtSigned(risk.best_day)} / worst ${fmtSigned(risk.worst_day)}`}
        />
        <StatTile
          label="1-day VaR 95%"
          value={exposure.var95_param != null ? formatCurrency(exposure.var95_param) : '—'}
          sub={`on current delta · hist. ${risk.var95_hist != null ? formatCurrency(risk.var95_hist) : '—'}`}
          title={`Parametric: 1.645 × ${symbol} ${VOL_WINDOW}-day realized vol ÷ √252 × net delta dollars. Historical: 5th percentile of daily P&L.`}
        />
        <StatTile
          label="Exposure"
          value={formatCurrency(exposure.net_delta_dollars)}
          sub={`${exposure.pct_of_equity != null ? `${(exposure.pct_of_equity * 100).toFixed(1)}% of equity · ` : ''}${symbol} vol ${model.vol != null ? `${(model.vol * 100).toFixed(0)}%` : '—'}`}
          title={`Net delta dollars: ${formatCurrency(exposure.stock_value)} stock + ${formatCurrency(exposure.option_delta_dollars)} option delta`}
        />
      </div>

      {/* ── Charts ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card
          title="Cumulative P&L (stock)"
          subtitle={`Daily mark-to-market since the first fill · ${risk.days} trading days${risk.return_on_peak != null ? ` · ${fmtPct(risk.return_on_peak)} on peak exposure (${formatCurrency(risk.peak_exposure)})` : ''}`}
        >
          <CumulativePnlChart points={model.points} />
          <DailyPnlTable points={model.points} />
        </Card>
        <Card title={`${symbol} price, average cost and fills`} subtitle="Each marker is a fill at its price and time">
          <PriceFillsChart symbol={symbol} bars={model.bars} fills={ledger.fills} livePrice={livePrice} />
        </Card>
      </div>

      {/* ── Vol calibration ────────────────────────────────────────── */}
      <Card
        title={`${symbol} volatility calibration`}
        subtitle={
          <>
            Realized close-to-close vol vs. implied ({calibration.ivSource ? `${calibration.ivSource} surface` : 'no surface'}
            {calibration.ivAsOf ? `, ${fmtEt(utcMs(calibration.ivAsOf))}` : ''}), and a backtest of the 1-day 95% VaR against what the P&amp;L actually did
          </>
        }
      >
        <div className="p-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {calibration.windows.map(w => (
            <StatTile key={w.label} label={`Realized ${w.label}`} value={fmtVol(w.vol)} sub={`${w.days} trading days`} />
          ))}
          <StatTile
            label={`Implied ATM ${ATM_IV_DTE}D`}
            value={fmtVol(calibration.atmIv)}
            sub={calibration.ivSource === 'mock' ? 'mock surface, not market data' : calibration.ivSource ? `${calibration.ivSource} option quotes` : errors.surface ?? 'unavailable'}
          />
          <StatTile
            label="Implied − realized 1M"
            value={calibration.atmIv != null && calibration.rv1m != null ? `${calibration.atmIv - calibration.rv1m >= 0 ? '+' : '−'}${(Math.abs(calibration.atmIv - calibration.rv1m) * 100).toFixed(1)} pts` : '—'}
            sub={calibration.atmIv != null && calibration.rv1m != null ? (calibration.atmIv > calibration.rv1m ? 'Options price more movement than realized' : 'Options price less movement than realized') : undefined}
          />
        </div>
        <div className="px-4 pb-2 grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile
            label="VaR breaches"
            value={`${calibration.backtest.exceedances} of ${calibration.backtest.n}`}
            sub={`${calibration.backtest.expected.toFixed(1)} expected at 95%`}
            title="Days whose loss exceeded the 1-day 95% VaR forecast from the prior close (exposure × 21-day σ × 1.645)"
          />
          <StatTile
            label="Kupiec test"
            value={calibration.backtest.kupiec_p != null ? `p = ${calibration.backtest.kupiec_p.toFixed(2)}` : '—'}
            sub={calibration.backtest.kupiec_p == null ? 'No forecast days yet' : calibration.backtest.kupiec_p < 0.05 ? 'Breach rate inconsistent with 95%' : 'Breach rate consistent with 95%'}
          />
          <StatTile
            label="P&L vol ÷ predicted"
            value={calibration.backtest.vol_ratio != null ? `${calibration.backtest.vol_ratio.toFixed(2)}×` : '—'}
            sub={calibration.backtest.vol_ratio == null ? undefined : calibration.backtest.vol_ratio > 1.2 ? 'P&L swings more than exposure × vol' : calibration.backtest.vol_ratio < 0.8 ? 'P&L swings less than exposure × vol' : 'In line with exposure × vol'}
            title="σ of realized day P&L ÷ RMS of the predicted 1σ (prior-close exposure × trailing σ)"
          />
          <StatTile
            label="Trading-driven days"
            value={String(calibration.backtest.trading_days)}
            sub="Day P&L mostly from intraday trades, which overnight VaR can't see"
          />
        </div>
        <VarBacktestChart backtest={calibration.backtest} />
      </Card>

      {/* ── Queue ──────────────────────────────────────────────────── */}
      <Card
        title="Working orders"
        subtitle={
          queue.stock.length || queue.options.length
            ? `Buys ${formatCurrency(queue.buy_notional)} · sells ${formatCurrency(queue.sell_notional)} · ${shares(queue.shares_if_filled)} sh if all fill · option premium at risk ${formatCurrency(queue.option_premium_at_risk)}${
                snapshot?.portfolio.equity ? ` (${((queue.option_premium_at_risk / snapshot.portfolio.equity) * 100).toFixed(2)}% of equity)` : ''
              }${model.staleStubs ? ` · ${model.staleStubs} stale unconfirmed stubs hidden` : ''}`
            : model.staleStubs ? `${model.staleStubs} stale unconfirmed stubs hidden` : undefined
        }
      >
        <QueuedOrdersTables queue={queue} livePrice={livePrice} optionMarket={optionMarket} />
      </Card>

      {/* ── Fill quality ───────────────────────────────────────────── */}
      <Card
        title="Fill quality at execution"
        subtitle={
          fillCtxState.key !== fillKey
            ? 'Loading the NBBO and minute bar at each fill…'
            : fillCtxState.error
              ? `Market data unavailable: ${fillCtxState.error}`
              : `Each fill vs. the consolidated NBBO in force when it executed (last quote at or before the fill) and that minute's VWAP · ${fillQuality.summary.with_quote} of ${fillQuality.summary.fills} fills have a quote`
        }
      >
        <div className="p-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatTile
            label="vs mid (wtd)"
            value={formatBps(fillQuality.summary.vs_mid_bps)}
            tone={fillQuality.summary.vs_mid_bps != null ? -fillQuality.summary.vs_mid_bps : undefined}
            sub="+ = paid away from mid"
            title="Notional-weighted signed distance from the NBBO midpoint: buys above mid and sells below mid are costs"
          />
          <StatTile
            label="Cost vs mid"
            value={fmtSigned(fillQuality.summary.vs_mid_usd)}
            tone={-fillQuality.summary.vs_mid_usd}
            sub={`on ${formatCurrency(fillQuality.summary.notional)} traded`}
          />
          <StatTile
            label="vs 1-min VWAP"
            value={formatBps(fillQuality.summary.vs_vwap_bps)}
            tone={fillQuality.summary.vs_vwap_bps != null ? -fillQuality.summary.vs_vwap_bps : undefined}
            sub={`${fillQuality.summary.with_bar} fills with a bar`}
          />
          <StatTile
            label="Inside or better"
            value={fillQuality.summary.with_quote ? `${Math.round(((fillQuality.summary.placements.inside + fillQuality.summary.placements.better) / fillQuality.summary.with_quote) * 100)}%` : '—'}
            sub={`${fillQuality.summary.placements.touch} at touch · ${fillQuality.summary.placements.through} through`}
            title={(Object.keys(fillQuality.summary.placements) as (keyof typeof fillQuality.summary.placements)[]).map(k => `${PLACEMENT_LABEL[k]}: ${fillQuality.summary.placements[k]}`).join(' · ')}
          />
          <StatTile
            label="Spread at execution"
            value={fillQuality.summary.avg_spread_bps != null ? `${fillQuality.summary.avg_spread_bps.toFixed(1)} bps` : '—'}
            sub={`${fillQuality.summary.stale_quotes} fills with a stale quote (> 60 s) not scored`}
          />
          <StatTile
            label="Stops vs mid"
            value={formatBps(fillQuality.summary.stops_vs_mid_bps)}
            tone={fillQuality.summary.stops_vs_mid_bps != null ? -fillQuality.summary.stops_vs_mid_bps : undefined}
            sub={`${fillQuality.summary.stop_fills} stop fills (trailing stops gap at the open)`}
            title="Stop and trailing-stop fills vs. the NBBO mid when they executed, notional-weighted"
          />
        </div>
        <FillQualityGroups summary={fillQuality.summary} />
        <div className="border-t border-gray-200 dark:border-zinc-700">
          <FillQualityTable rows={fillQuality.rows} />
        </div>
      </Card>

      {/* ── Positions & ledgers ────────────────────────────────────── */}
      <Card title="Open option positions" subtitle={model.optionPositions.length ? `${formatCurrency(exposure.option_market_value)} value · ${formatCurrency(exposure.option_delta_dollars)} delta dollars` : undefined}>
        <OptionPositionsTable positions={model.optionPositions} />
      </Card>

      <Card title="Stock fills" subtitle="Average-cost basis · newest first">
        <StockFillsTable fills={ledger.fills} />
      </Card>

      <Card
        title="Option fills"
        subtitle={optionLedger.filled_count ? `${formatCurrency(optionLedger.premium_paid)} paid · ${formatCurrency(optionLedger.premium_received)} received` : undefined}
      >
        <OptionFillsTable fills={optionLedger.fills} />
      </Card>

      {errors.snapshot && (
        <p className="text-xs text-gray-500 dark:text-gray-400">Snapshot unavailable: {errors.snapshot}. Broker position, option marks and equity are missing.</p>
      )}
      {errors.db && model.orders.source !== 'db' && (
        <p className="text-xs text-gray-500 dark:text-gray-400">Trading DB unavailable: {errors.db}</p>
      )}
    </div>
  );
}
