// enriched-snapshot.cjs
// Netlify function — drop into netlify/functions/
//
// Reads the same state-logs blob as order-book-snapshot, then enriches it
// server-side so the frontend receives pre-computed data and does no math.
//
// Enrichments added vs raw snapshot:
//   - pnl_by_period: realized stock + option P&L for every period (1W…5Y)
//   - portfolio.options_summary: aggregated greeks / totals across option positions
//   - portfolio.equity: RH passthrough (excludes crypto)
//   - portfolio.market_value: stocks + options + crypto
//   - portfolio.stock_market_value / options_market_value / crypto_market_value
//   - portfolio.shadow_market_value: engine `.SHADOW` mirror rows, excluded
//     from every aggregate (they duplicate a real position)
//   - portfolio.margin_used: abs(tradeable_cash) when negative
//   - portfolio.reconciliation: per-asset-class breakdown for UI callout;
//     computed_equity (stocks + options + crypto + cash) is the headline
//   - portfolio.positions: pre-sorted by abs(profit_loss) desc
//   - recent_orders / recent_option_orders: pre-sorted newest-first

'use strict';

// ── Data source: order-book-snapshot's core, called in-process ───────────────
// (was an HTTP round-trip to our own site, which doubled cold starts and the
// 10s budget)

const { fetchSnapshot: fetchRawSnapshot } = require('./order-book-snapshot.cjs');
const { CORS: BASE_CORS } = require('./lib/http.cjs');

const CORS = { ...BASE_CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

// ── Enrichment helpers (ported from app/server.py) ───────────────────────────

const PERIOD_DAYS = { '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '5Y': 1825 };

function periodCutoff(period) {
  return new Date(Date.now() - (PERIOD_DAYS[period] ?? 365) * 86_400_000);
}

function r2(n) { return Math.round(n * 100) / 100; }

// When a filled order executed. Stops and GTC limits often fill days after
// they were placed, so submission time (created_at) mis-orders fills and
// matches sells against the wrong average cost; a terminal order's
// updated_at is its last transaction.
function fillTime(o) {
  const created = new Date(o.created_at).getTime();
  const updated = new Date(o.updated_at).getTime();
  if (Number.isFinite(updated) && (!Number.isFinite(created) || updated >= created)) return updated;
  return created;
}

function computeStockPnl(orders, cutoff) {
  // Cost basis is built from every fill, so a sell inside the window is
  // matched against shares bought before it; only in-window fills count
  // toward realized P&L, volumes, and counts.
  const filled = orders.filter(o => o.state === 'filled' && o.symbol)
    .sort((a, b) => fillTime(a) - fillTime(b));

  const book = {};
  const active = new Set();
  let filledCount = 0;
  for (const o of filled) {
    const sym = o.symbol;
    if (!book[sym]) book[sym] = {
      symbol: sym, realized_pnl: 0,
      total_bought: 0, total_sold: 0,
      buy_count: 0, sell_count: 0,
      shares_held: 0, cost_basis: 0,
    };
    const s     = book[sym];
    const qty   = parseFloat(o.filled_quantity ?? o.quantity ?? 0) || 0;
    const price = parseFloat(o.average_price   ?? o.limit_price ?? 0) || 0;
    const total = qty * price;
    const inWindow = fillTime(o) >= cutoff.getTime();
    if (inWindow) { active.add(sym); filledCount++; }

    if ((o.side || '').toUpperCase() === 'BUY') {
      s.shares_held  += qty;
      s.cost_basis   += total;
      if (inWindow) { s.total_bought += total; s.buy_count++; }
    } else {
      const avg = s.shares_held > 0 ? s.cost_basis / s.shares_held : 0;
      if (inWindow) {
        s.realized_pnl += (price - avg) * qty;
        s.total_sold   += total;
        s.sell_count++;
      }
      s.cost_basis   -= avg * qty;
      s.shares_held  -= qty;
    }
  }

  const symbols = Object.values(book)
    .filter(s => active.has(s.symbol))
    .map(s => ({ ...s, realized_pnl: r2(s.realized_pnl), total_bought: r2(s.total_bought), total_sold: r2(s.total_sold) }))
    .sort((a, b) => Math.abs(b.realized_pnl) - Math.abs(a.realized_pnl));

  return {
    total_realized_pnl: r2(symbols.reduce((s, x) => s + x.realized_pnl, 0)),
    total_buy_volume:   r2(symbols.reduce((s, x) => s + x.total_bought, 0)),
    total_sell_volume:  r2(symbols.reduce((s, x) => s + x.total_sold,   0)),
    filled_count: filledCount,
    symbols,
  };
}

function computeOptionPnl(orders) {
  const filled = orders.filter(o => o.state === 'filled');
  const book   = {};

  for (const o of filled) {
    const leg     = (o.legs ?? [])[0] ?? {};
    const sym     = leg.chain_symbol || 'OPT';
    // prefer processed_premium; fall back to price × quantity × 100 (per-contract)
    const premium = parseFloat(o.processed_premium) || (parseFloat(o.price ?? 0) * parseFloat(o.quantity ?? 1) * 100) || 0;

    if (!book[sym]) book[sym] = {
      symbol: sym, realized_pnl: 0,
      total_bought: 0, total_sold: 0,
      buy_count: 0, sell_count: 0,
    };
    const s = book[sym];
    const dir = (o.direction || '').toLowerCase();
    if (dir === 'debit') { s.total_bought += premium; s.buy_count++; }
    else                 { s.total_sold   += premium; s.sell_count++; }
  }

  const symbols = Object.values(book).map(s => ({
    ...s,
    realized_pnl: r2(s.total_sold - s.total_bought),
    total_bought: r2(s.total_bought),
    total_sold:   r2(s.total_sold),
  })).sort((a, b) => Math.abs(b.realized_pnl) - Math.abs(a.realized_pnl));

  return {
    total_realized_pnl: r2(symbols.reduce((s, x) => s + x.realized_pnl, 0)),
    total_buy_volume:   r2(symbols.reduce((s, x) => s + x.total_bought, 0)),
    total_sell_volume:  r2(symbols.reduce((s, x) => s + x.total_sold,   0)),
    filled_count: filled.length,
    symbols,
  };
}

function aggregateOptions(positions) {
  if (!positions.length) return null;
  return {
    count:               positions.length,
    total_cost_basis:    r2(positions.reduce((s, p) => s + (p.cost_basis    ?? 0), 0)),
    total_current_value: r2(positions.reduce((s, p) => s + (p.current_value ?? 0), 0)),
    total_unrealized_pl: r2(positions.reduce((s, p) => s + (p.unrealized_pl ?? 0), 0)),
    total_theta_daily:   r2(positions.reduce((s, p) => s + (p.expected_pl?.theta_daily ?? 0), 0)),
  };
}

// ── Field normalizers (handle both engine-formatted and raw RH API blobs) ─────

function normalizePosition(p) {
  // Engine blob uses: avg_entry, market_value, unrealized_pl, unrealized_pl_pct
  // TS contract (SnapshotPosition) expects: avg_buy_price, equity, profit_loss, profit_loss_pct
  const qty = parseFloat(p.quantity ?? p.qty) || 0;
  const avgBuy = parseFloat(p.avg_buy_price ?? p.avg_entry) || 0;
  const current = parseFloat(p.current_price) || avgBuy;
  const equity = parseFloat(p.equity ?? p.market_value ?? qty * current) || 0;
  const pl = parseFloat(p.profit_loss ?? p.unrealized_pl) || 0;
  // profit_loss_pct is already a percent (rowToPosition scales it);
  // the engine's unrealized_pl_pct is a fraction (0.09 = 9%)
  const plPct = p.profit_loss_pct != null
    ? parseFloat(p.profit_loss_pct) || 0
    : (parseFloat(p.unrealized_pl_pct) || 0) * 100;

  // Asset-class tagging. `.SHADOW` rows are engine bookkeeping mirrors of a
  // real position (same quantity, shadow-ledger marks) — they must never count
  // toward market value. Crypto rows are either tagged by the writer
  // (asset_type) or use hyphenated pair symbols (BTC-USD).
  const symbol  = p.symbol || '';
  const shadow  = /\.SHADOW$/i.test(symbol);
  const assetType = p.asset_type === 'crypto' || /-USD$/.test(symbol)
    ? 'crypto'
    : (p.asset_type || 'equity');

  return {
    symbol,
    name:            p.name ?? symbol,
    quantity:        qty,
    avg_buy_price:   r2(avgBuy),
    current_price:   r2(current),
    equity:          r2(equity),
    profit_loss:     r2(pl),
    profit_loss_pct: r2(plPct),
    percent_change:  p.percent_change ?? null,
    percentage:      p.percentage ?? null,
    asset_type:      assetType,
    shadow,
  };
}

function normalizeCash(cashRaw, fallbackEquity = 0) {
  // Engine blob sends portfolio.cash as a bare number (e.g. -84057.39).
  // TS contract (CashInfo) expects an object with cash/buying_power/etc.
  if (typeof cashRaw === 'number') {
    return {
      cash:                          r2(cashRaw),
      cash_available_for_withdrawal: r2(cashRaw),
      buying_power:                  cashRaw < 0 ? r2(Math.abs(cashRaw) * 2) : r2(cashRaw * 2),
      tradeable_cash:                r2(cashRaw),
    };
  }
  if (cashRaw && typeof cashRaw === 'object') {
    return {
      cash:                          r2(cashRaw.cash ?? 0),
      cash_available_for_withdrawal: r2(cashRaw.cash_available_for_withdrawal ?? cashRaw.cash ?? 0),
      buying_power:                  r2(cashRaw.buying_power ?? 0),
      tradeable_cash:                r2(cashRaw.tradeable_cash ?? cashRaw.cash ?? 0),
    };
  }
  return { cash: 0, cash_available_for_withdrawal: 0, buying_power: 0, tradeable_cash: 0 };
}

function normalizeOpenOrder(o) {
  return {
    order_id:        o.order_id  || o.id,
    symbol:          o.symbol    || null,
    side:            (o.side     || '').toUpperCase(),
    order_type:      o.order_type || o.type,
    trigger:         o.trigger,
    state:           o.state,
    quantity:        parseFloat(o.quantity)  || 0,
    limit_price:     parseFloat(o.limit_price || o.price) || 0,
    stop_price:      o.stop_price ? parseFloat(o.stop_price) : null,
    created_at:      o.created_at,
    updated_at:      o.updated_at,
    filled_quantity: parseFloat(o.filled_quantity || o.cumulative_quantity) || 0,
    average_price:   o.average_price ? parseFloat(o.average_price) : null,
  };
}

function normalizeOpenOptionOrder(o) {
  return {
    order_id:         o.order_id || o.id,
    chain_symbol:     o.chain_symbol || null,
    direction:        (o.direction || '').toLowerCase(),
    state:            o.state,
    quantity:         parseFloat(o.quantity) || 0,
    price:            parseFloat(o.price) || 0,
    processed_premium: o.processed_premium ? parseFloat(o.processed_premium) : null,
    order_type:       o.order_type || o.type,
    opening_strategy: o.opening_strategy || null,
    created_at:       o.created_at,
    updated_at:       o.updated_at,
    legs:             (o.legs || []).map(leg => ({
      chain_symbol:   leg.chain_symbol || o.chain_symbol || null,
      strike_price:   leg.strike_price,
      expiration_date: leg.expiration_date,
      option_type:    leg.option_type,
      side:           (leg.side || '').toUpperCase(),
      position_effect: leg.position_effect,
    })),
  };
}

function enrichSnapshot(raw) {
  const portfolio   = raw.portfolio;
  // Normalize engine-blob field names → SnapshotPosition / CashInfo contract
  const positions   = (portfolio.positions || []).map(normalizePosition);
  const options     = portfolio.options     || [];
  const openOrders       = (portfolio.open_orders        || []).map(normalizeOpenOrder);
  const openOptionOrders = (portfolio.open_option_orders || []).map(normalizeOpenOptionOrder);
  const recentOrders       = raw.recent_orders        || [];
  const recentOptionOrders = raw.recent_option_orders || [];

  // ── Cash / margin (normalize bare-number cash from engine blob) ──
  const cash      = normalizeCash(portfolio.cash, portfolio.equity);
  const cashHeld  = cash.tradeable_cash ?? cash.buying_power ?? 0;
  const marginUsed = cashHeld < 0 ? r2(-cashHeld) : 0;

  // ── Market value by asset class (shadow rows excluded from every sum) ──
  const realPositions = positions.filter(p => !p.shadow);
  const stockMV    = r2(realPositions.filter(p => p.asset_type !== 'crypto')
                          .reduce((s, p) => s + (p.equity ?? 0), 0));
  const cryptoPosMV = r2(realPositions.filter(p => p.asset_type === 'crypto')
                          .reduce((s, p) => s + (p.equity ?? 0), 0));
  // Crypto: per-position rows when the book has them, else the account-level
  // total (RH reports crypto holdings only as a single value).
  const cryptoMV  = cryptoPosMV > 0 ? cryptoPosMV : r2(portfolio.crypto_value ?? 0);
  const shadowMV  = r2(positions.filter(p => p.shadow)
                        .reduce((s, p) => s + (p.equity ?? 0), 0));
  const optionsMV = r2(options.reduce((s, o)   => s + (o.current_value ?? 0), 0));
  const marketValue = r2(stockMV + optionsMV + cryptoMV);

  // ── Equity: engine-computed is the headline; RH passthrough excludes crypto ──
  const rhEquity      = portfolio.equity ?? 0;
  const computedEquity = r2(marketValue + cashHeld);

  // ── P&L by period ──
  const pnlByPeriod = {};
  for (const period of Object.keys(PERIOD_DAYS)) {
    const cutoff = periodCutoff(period);
    pnlByPeriod[period] = {
      stock:  computeStockPnl(recentOrders, cutoff),
      option: computeOptionPnl(recentOptionOrders),
    };
  }

  // ── 7d summary ──
  const recentPnl = computeStockPnl(recentOrders, periodCutoff('1W'));
  const optionPnl = computeOptionPnl(recentOptionOrders);

  // ── Portfolio-level P&L (positions now normalized → avg_buy_price populated) ──
  const totalPl   = r2(realPositions.reduce((s, p) => s + (p.profit_loss ?? 0), 0));
  const totalCost = realPositions.reduce((s, p) => s + (p.avg_buy_price ?? 0) * (p.quantity ?? 0), 0);
  const plPct     = totalCost > 0 ? r2((totalPl / totalCost) * 100) : 0;

  return {
    timestamp:   raw.timestamp,
    market_data: raw.market_data,
    order_book:  raw.order_book,
    // Null-safe: RH occasionally returns orders without created_at; a single
    // null must not 500 the whole snapshot (nulls sort last)
    recent_orders:        [...recentOrders].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))),
    recent_option_orders: [...recentOptionOrders].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))),
    recent_pnl:      recentPnl,
    option_pnl:      optionPnl,
    combined_7d_pnl: r2(recentPnl.total_realized_pnl + optionPnl.total_realized_pnl),
    pnl_by_period:   pnlByPeriod,
    portfolio: {
      // Normalized cash object (CashInfo shape)
      cash,
      // RH passthrough
      equity:               rhEquity,
      rh_market_value:      portfolio.market_value ?? null,
      // Computed breakdown
      market_value:         marketValue,
      stock_market_value:   stockMV,
      options_market_value: optionsMV,
      crypto_market_value:  cryptoMV,
      shadow_market_value:  shadowMV,
      margin_used:          marginUsed,
      // Reconciliation callout. rh_equity excludes crypto (RH's field does);
      // computed_equity = stocks + options + crypto + cash, shadows excluded.
      reconciliation: {
        rh_equity:            rhEquity,
        computed_equity:      computedEquity,
        stock_market_value:   stockMV,
        options_market_value: optionsMV,
        crypto_market_value:  cryptoMV,
        cash:                 r2(cashHeld),
        shadow_excluded:      shadowMV,
      },
      // Pre-sorted positions (biggest P&L movers first)
      positions: [...positions].sort((a, b) => Math.abs(b.profit_loss ?? 0) - Math.abs(a.profit_loss ?? 0)),
      // Normalized open orders
      open_orders:        openOrders,
      open_option_orders: openOptionOrders,
      options,
      options_summary: aggregateOptions(options),
      total_pl:     totalPl,
      total_pl_pct: plPct,
    },
  };
}

// ── Order provenance ─────────────────────────────────────────────────────────
// order-book-snapshot now serves positions AND orders straight from the
// trading DB, so this function no longer overlays the DB onto a stale blob —
// it just carries the provenance fields through to the response.

// ── Handler ──────────────────────────────────────────────────────────────────

// Export enrichment helpers so local dev (vite-mock-api.ts) can run the same
// code path as production — no duplicated P&L math that can drift.
module.exports.enrichSnapshot = enrichSnapshot;
module.exports.computeStockPnl = computeStockPnl;
module.exports.computeOptionPnl = computeOptionPnl;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const raw      = await fetchRawSnapshot();
    const enriched = enrichSnapshot(raw);
    // Pass _as_of through verbatim — including null. Falling back to the
    // snapshot timestamp would relabel never-written data as current, which
    // is the reporting bug that hid a month-long order-feed outage.
    enriched.orders_source    = raw.orders_source    || 'db';
    enriched.orders_as_of     = raw.orders_as_of     ?? null;
    enriched.positions_source = raw.positions_source || 'db';
    enriched.positions_as_of  = raw.positions_as_of  ?? null;
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(enriched),
    };
  } catch (err) {
    console.error('enriched-snapshot error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Failed to fetch enriched snapshot' }),
    };
  }
};
module.exports.normalizePosition = normalizePosition;
