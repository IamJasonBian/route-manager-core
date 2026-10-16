// snapshot-refresh.cjs
// Refreshes the order-book snapshot WITHOUT the Render engine:
//   auth box (RH_AUTH_SERVICE_URL, /token) — or, when the auth box is down,
//   the site's own Robinhood session (Configure → Connect Robinhood, stored
//   by robinhood-auth in the robinhood-auth blob store) → Robinhood API pulls →
//     1. fresh state-logs blob (positions, options, cash, equity, crypto —
//        what the engine used to publish)
//     2. trading-DB upsert of stock + option orders (also closes backfill gaps)
//     3. trading-DB upsert of the account snapshot (incl. crypto_value from
//        the nummus API) and position marks — no prune, so engine-owned rows
//        (.SHADOW mirrors) survive
//
//   GET /.netlify/functions/snapshot-refresh            — refresh now
//   GET /.netlify/functions/snapshot-refresh?full=1     — pull full order history (write auth)
//   GET /.netlify/functions/snapshot-refresh?force=1    — bypass the 60s floor (write auth)
//   GET /.netlify/functions/snapshot-refresh?dry=1      — pull + report, write nothing
//
// No scheduled companion — triggered manually or by an external scheduler.
// Repeated triggers are floored to once per 60s. `full`/`force` require
// TRADING_DB_TOKEN credentials when that token is set.
//
// Every response is a diagnostics object: { ok, elapsed_ms, steps, errors }.

'use strict';

const t = require('./lib/tradingDb.cjs');
const { fetchWithTimeout } = require('./lib/http.cjs');
const tokenStore = require('./lib/tokenStore.cjs');

const RH = 'https://api.robinhood.com';
const SITE_ID = process.env.NETLIFY_SITE_ID || '3d014fc3-e919-4b4d-b374-e8606dee50df';
const REFRESH_FLOOR_MS = 60_000;
const BACKFILL_CUTOFF = '2026-05-01'; // option-order leg detail fetched back to here by default

const CORS = { ...t.CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

function num(v) { const n = parseFloat(v); return Number.isNaN(n) ? 0 : n; }
function r2(n) { return Math.round(n * 100) / 100; }
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Auth box → Robinhood token ────────────────────────────────────────────────

async function getRhToken(errors) {
  const base = (process.env.RH_AUTH_SERVICE_URL || '').replace(/\/$/, '');
  const exec = process.env.RH_EXEC_TOKEN;
  if (!base || !exec) throw new Error('RH_AUTH_SERVICE_URL / RH_EXEC_TOKEN not configured');
  let res;
  try {
    res = await fetchWithTimeout(`${base}/token`, { headers: { Authorization: `Bearer ${exec}` } }, 5000);
  } catch (e) {
    const cause = e.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : '';
    throw new Error(`auth box unreachable at ${base}/token: ${e.message}${cause}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`auth box /token → ${res.status}: ${text.slice(0, 200)}`);
  try {
    const body = JSON.parse(text);
    const token = body.access_token || body.token || body.rh_token || body.bearer;
    if (token) return token;
    errors.push(`auth box JSON had no recognizable token field: ${Object.keys(body).join(',')}`);
    throw new Error('no token in auth box response');
  } catch (e) {
    if (e.message === 'no token in auth box response') throw e;
    const raw = text.trim();
    if (raw && !raw.startsWith('<')) return raw; // plain-text token
    throw new Error(`auth box returned unparseable body: ${raw.slice(0, 120)}`);
  }
}

/**
 * Auth box first; if it is unreachable or misconfigured, fall back to the
 * site's own Robinhood session so a down auth box doesn't freeze the book.
 */
async function resolveRhToken(errors, deps = { getRhToken, getSiteToken: () => tokenStore.getToken() }) {
  try {
    return { token: await deps.getRhToken(errors), source: 'auth-box' };
  } catch (boxErr) {
    let siteToken = null;
    try { siteToken = await deps.getSiteToken(); } catch { /* treated as no session */ }
    if (siteToken) {
      errors.push(`${boxErr.message}; used the site's Robinhood session instead`);
      return { token: siteToken, source: 'site-session' };
    }
    throw new Error(`${boxErr.message}. No site Robinhood session either: connect one on the Configure page (approve in the Robinhood app), or restore the auth box.`);
  }
}

// ── Robinhood client ──────────────────────────────────────────────────────────

function rhClient(token) {
  const cache = new Map(); // absolute-URL GET cache (instruments etc.)
  async function get(pathOrUrl) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${RH}${pathOrUrl}`;
    if (cache.has(url)) return cache.get(url);
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`RH ${url.replace(RH, '')} → ${res.status}`);
    const body = await res.json();
    cache.set(url, body);
    return body;
  }
  async function paginate(path, { maxPages = 20, stopWhen = null } = {}) {
    const out = [];
    let url = path;
    for (let i = 0; i < maxPages && url; i++) {
      const page = await get(url);
      out.push(...(page.results || []));
      if (stopWhen && page.results?.length && stopWhen(page.results[page.results.length - 1])) break;
      url = page.next;
    }
    return out;
  }
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let idx = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
    }));
    return out;
  }
  return { get, paginate, mapLimit };
}

// ── Pull + assemble ───────────────────────────────────────────────────────────

async function pullSnapshot(rh, { full }, errors) {
  const [accounts, portfolios, positions, optionPositions] = await Promise.all([
    rh.get('/accounts/').then(r => r.results || []),
    rh.get('/portfolios/').then(r => r.results || []),
    rh.paginate('/positions/?nonzero=true'),
    rh.paginate('/options/positions/?nonzero=true'),
  ]);
  const account = accounts[0] || {};
  const portfolio = portfolios[0] || {};

  // ── Crypto holdings (nummus API — separate host, same bearer token) ──
  // RH reports crypto outside the equity portfolio entirely; value the holdings
  // against forex mark prices. null (fetch failure) is distinct from 0 (no
  // holdings): upsertAccountSnapshot keeps the previous value when null.
  let cryptoValue = null;
  try {
    const [holdRes, pairRes] = await Promise.all([
      rh.get('https://nummus.robinhood.com/holdings/'),
      rh.get('https://nummus.robinhood.com/currency_pairs/'),
    ]);
    const holdings = (holdRes.results || []).filter(h => num(h.quantity) > 0);
    if (!holdings.length) {
      cryptoValue = 0;
    } else {
      const pairByCode = {};
      for (const p of pairRes.results || []) {
        if (p.asset_currency?.code) pairByCode[p.asset_currency.code] = p.id;
      }
      const ids = [...new Set(holdings.map(h => pairByCode[h.currency?.code]).filter(Boolean))];
      const quoteRes = ids.length
        ? await rh.get(`/marketdata/forex/quotes/?ids=${ids.join(',')}`)
        : { results: [] };
      const priceById = {};
      for (const q of quoteRes.results || []) if (q) priceById[q.id] = num(q.mark_price);
      cryptoValue = r2(holdings.reduce((s, h) => {
        const id = pairByCode[h.currency?.code];
        return s + num(h.quantity) * (id ? priceById[id] || 0 : 0);
      }, 0));
    }
  } catch (e) {
    errors.push(`crypto holdings: ${e.message}`);
  }

  // Orders: recent pages by default; everything with ?full=1
  const [stockOrders, optionOrders] = await Promise.all([
    rh.paginate('/orders/', full ? { maxPages: 100 } : { maxPages: 4 }),
    rh.paginate('/options/orders/', full ? { maxPages: 100 } : {
      maxPages: 20, stopWhen: o => (o.created_at || '') < BACKFILL_CUTOFF,
    }),
  ]);

  // Resolve instrument URLs → symbols (positions + stock orders share the cache)
  const instrumentUrls = [...new Set([
    ...positions.map(p => p.instrument),
    ...stockOrders.map(o => o.instrument),
  ].filter(Boolean))];
  const instruments = {};
  await rh.mapLimit(instrumentUrls, 8, async url => {
    try { instruments[url] = await rh.get(url); }
    catch (e) { errors.push(`instrument ${url}: ${e.message}`); }
  });
  const symbolOf = url => instruments[url]?.symbol || null;

  // Quotes for position prices + option underlyings
  const symbols = [...new Set([
    ...positions.map(p => symbolOf(p.instrument)),
    ...optionPositions.map(p => p.chain_symbol),
  ].filter(Boolean))];
  const quotes = {};
  await rh.mapLimit(chunk(symbols, 30), 4, async batch => {
    try {
      const page = await rh.get(`/quotes/?symbols=${batch.join(',')}`);
      for (const q of page.results || []) if (q) quotes[q.symbol] = q;
    } catch (e) { errors.push(`quotes: ${e.message}`); }
  });
  const priceOf = sym => {
    const q = quotes[sym];
    return q ? num(q.last_extended_hours_trade_price || q.last_trade_price) : 0;
  };

  // ── Stock positions (SnapshotPosition contract shape) ──
  const blobPositions = positions.map(p => {
    const sym = symbolOf(p.instrument);
    const qty = num(p.quantity);
    const avg = num(p.average_buy_price);
    const price = sym ? priceOf(sym) : 0;
    const equity = r2(qty * price);
    const cost = qty * avg;
    const q = quotes[sym] || {};
    const prevClose = num(q.previous_close);
    return {
      symbol: sym,
      name: instruments[p.instrument]?.simple_name || instruments[p.instrument]?.name || sym,
      quantity: qty,
      avg_buy_price: r2(avg),
      current_price: r2(price),
      equity,
      profit_loss: r2(equity - cost),
      // fraction — the enricher's normalizePosition converts to percentage points
      profit_loss_pct: cost > 0 ? (equity - cost) / cost : 0,
      percent_change: prevClose > 0 ? r2(((price - prevClose) / prevClose) * 100) : null,
      percentage: null, // filled below once total is known
    };
  }).filter(p => p.symbol);
  const totalStockMV = blobPositions.reduce((s, p) => s + p.equity, 0);
  for (const p of blobPositions) p.percentage = totalStockMV > 0 ? r2((p.equity / totalStockMV) * 100) : null;

  // ── Option positions with instrument detail + greeks ──
  const optInstrumentUrls = [...new Set(optionPositions.map(p => p.option).filter(Boolean))];
  const optInstruments = {};
  await rh.mapLimit(optInstrumentUrls, 8, async url => {
    try { optInstruments[url] = await rh.get(url); }
    catch (e) { errors.push(`option instrument ${url}: ${e.message}`); }
  });
  const marketdata = {};
  await rh.mapLimit(chunk(optInstrumentUrls, 15), 4, async batch => {
    try {
      const page = await rh.get(`/marketdata/options/?instruments=${encodeURIComponent(batch.join(','))}`);
      for (const m of page.results || []) if (m) marketdata[m.instrument] = m;
    } catch (e) { errors.push(`option marketdata: ${e.message}`); }
  });

  const blobOptions = optionPositions.map(p => {
    const inst = optInstruments[p.option] || {};
    const md = marketdata[p.option] || {};
    const qty = num(p.quantity);
    const short = (p.type || '').toLowerCase() === 'short';
    const sign = short ? -1 : 1;
    const avg = Math.abs(num(p.average_price));            // per contract (×100 included)
    const mark = num(md.adjusted_mark_price) * 100;        // per contract
    const costBasis = r2(sign * avg * qty);
    const currentValue = r2(sign * mark * qty);
    const dte = inst.expiration_date
      ? Math.max(0, Math.round((new Date(inst.expiration_date + 'T20:00:00Z') - Date.now()) / 86_400_000))
      : null;
    const theta = md.theta != null ? num(md.theta) : null;
    return {
      chain_symbol: p.chain_symbol,
      option_type: inst.type || 'call',
      strike: num(inst.strike_price),
      expiration: inst.expiration_date || null,
      dte,
      quantity: qty,
      position_type: short ? 'short' : 'long',
      avg_price: r2(avg),
      mark_price: r2(mark),
      multiplier: 100,
      cost_basis: costBasis,
      current_value: currentValue,
      unrealized_pl: r2(currentValue - costBasis),
      unrealized_pl_pct: avg * qty > 0 ? r2(((currentValue - costBasis) / (avg * qty)) * 100) : null,
      underlying_price: priceOf(p.chain_symbol) || null,
      chance_of_profit: md[short ? 'chance_of_profit_short' : 'chance_of_profit_long'] != null
        ? num(md[short ? 'chance_of_profit_short' : 'chance_of_profit_long']) : null,
      greeks: {
        delta: num(md.delta), gamma: num(md.gamma), theta: theta ?? 0,
        vega: num(md.vega), rho: num(md.rho), iv: num(md.implied_volatility),
      },
      expected_pl: { theta_daily: theta != null ? r2(theta * 100 * qty * sign) : 0 },
    };
  });

  // ── Orders (raw RH + resolved symbol; normalizers handle the rest) ──
  const stockOrdersOut = stockOrders.map(o => ({ ...o, symbol: o.symbol || symbolOf(o.instrument) }));

  // Option-order legs need per-leg instrument fetches — bound to the backfill window
  const legUrls = [...new Set(optionOrders
    .filter(o => full || (o.created_at || '') >= BACKFILL_CUTOFF)
    .flatMap(o => (o.legs || []).map(l => l.option))
    .filter(Boolean))];
  await rh.mapLimit(legUrls, 8, async url => {
    try { optInstruments[url] = optInstruments[url] || await rh.get(url); }
    catch (e) { errors.push(`leg instrument ${url}: ${e.message}`); }
  });
  const optionOrdersOut = optionOrders.map(o => ({
    ...o,
    legs: (o.legs || []).map(l => {
      const inst = optInstruments[l.option] || {};
      return {
        chain_symbol: o.chain_symbol,
        strike_price: inst.strike_price ?? null,
        expiration_date: inst.expiration_date ?? null,
        option_type: inst.type ?? null,
        side: l.side,
        position_effect: l.position_effect,
      };
    }),
  }));

  const openStates = s => t.OPEN_STATES.has(s);
  const equity = num(portfolio.extended_hours_equity || portfolio.equity);
  const cash = num(account.portfolio_cash ?? account.cash);

  const blob = {
    timestamp: new Date().toISOString(),
    source: 'snapshot-refresh',
    portfolio: {
      cash: {
        cash: r2(cash),
        cash_available_for_withdrawal: num(account.cash_available_for_withdrawal),
        buying_power: num(account.buying_power),
        tradeable_cash: r2(cash),
      },
      equity: r2(equity),
      crypto_value: cryptoValue ?? 0,
      market_value: r2(num(portfolio.market_value)),
      positions: blobPositions,
      options: blobOptions,
      open_orders: stockOrdersOut.filter(o => openStates(o.state)),
      open_option_orders: optionOrdersOut.filter(o => openStates(o.state)),
    },
    order_book: [],
    recent_orders: stockOrdersOut,
    recent_option_orders: optionOrdersOut,
  };

  return { blob, stockOrdersOut, optionOrdersOut, cryptoValue };
}

// ── Writers ───────────────────────────────────────────────────────────────────

async function writeBlob(blob) {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name: 'state-logs', siteID: SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
  // Match the engine's key format: ISO timestamp with colons → dashes (sortable)
  const key = blob.timestamp.replace(/:/g, '-').replace(/\..*$/, '');
  await store.setJSON(key, blob);
  return key;
}

async function upsertOrders(db, stockOrders, optionOrders, errors) {
  const pairs = (rows, normalize) => rows
    .map(raw => ({ value: normalize(raw), raw }))
    .filter(r => r.value);
  let stock = 0, option = 0;
  try { stock = await t.upsertStockOrders(db, pairs(stockOrders, t.normalizeStockOrder)); }
  catch (e) { errors.push(`upsert stock orders: ${e.message}`); }
  try { option = await t.upsertOptionOrders(db, pairs(optionOrders, t.normalizeOptionOrder)); }
  catch (e) { errors.push(`upsert option orders: ${e.message}`); }
  return { stock, option };
}

// ── Core (also used by the scheduled wrapper) ─────────────────────────────────

async function runSnapshotRefresh({ full = false, dry = false, force = false } = {}) {
  const started = Date.now();
  const errors = [];
  const steps = {};

  const db = t.getDb();
  if (db) await t.ensureSchema(db);

  // Floor repeated manual triggers
  if (db && !force && !dry) {
    const marker = await t.getMarketCache(db, 'snapshot-refresh:last');
    if (marker && marker.age_ms < REFRESH_FLOOR_MS) {
      return { ok: true, skipped: `last refresh ${Math.round(marker.age_ms / 1000)}s ago (floor ${REFRESH_FLOOR_MS / 1000}s)` };
    }
  }

  const { token: rhToken, source: authSource } = await resolveRhToken(errors);
  steps.auth = authSource;

  const rh = rhClient(rhToken);
  const { blob, stockOrdersOut, optionOrdersOut, cryptoValue } = await pullSnapshot(rh, { full }, errors);
  steps.pull = {
    positions: blob.portfolio.positions.length,
    option_positions: blob.portfolio.options.length,
    stock_orders: stockOrdersOut.length,
    option_orders: optionOrdersOut.length,
    open_orders: blob.portfolio.open_orders.length,
    equity: blob.portfolio.equity,
    crypto_value: cryptoValue,
  };

  if (!dry) {
    steps.blob_key = await writeBlob(blob);
    if (db) {
      steps.db_upserts = await upsertOrders(db, stockOrdersOut, optionOrdersOut, errors);

      // Account + position marks straight from RH, so the DB book stays fresh
      // between engine ticks. Upsert only — no prune — so engine-owned rows the
      // API doesn't know about (e.g. .SHADOW mirrors) survive.
      try {
        const acct = t.normalizeAccount({
          equity:          blob.portfolio.equity,
          cash:            blob.portfolio.cash.cash,
          buying_power:    blob.portfolio.cash.buying_power,
          portfolio_value: blob.portfolio.market_value,
          crypto_value:    cryptoValue,
        });
        if (acct) {
          await t.upsertAccountSnapshot(db, acct, acct);
          steps.db_upserts.account = true;
        }
        const posRows = [];
        for (const raw of blob.portfolio.positions) {
          // profit_loss_pct here is a fraction — hand it to the normalizer
          // under the spelling it treats as one.
          const value = t.normalizePosition({ ...raw, unrealized_pl_pct: raw.profit_loss_pct });
          if (value) posRows.push({ value, raw });
        }
        steps.db_upserts.positions = await t.upsertPositions(db, posRows);
      } catch (e) {
        errors.push(`db account/positions upsert: ${e.message}`);
      }

      await t.setMarketCache(db, 'snapshot-refresh:last', 'marker', { at: blob.timestamp });
    }
  }

  return { ok: true, dry, full, elapsed_ms: Date.now() - started, steps, errors };
}

module.exports.runSnapshotRefresh = runSnapshotRefresh;
module.exports.resolveRhToken = resolveRhToken;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const params = event.queryStringParameters || {};
  if (params.full === '1' || params.force === '1') {
    const denied = t.checkWriteAuth(event);
    if (denied) {
      return {
        statusCode: 401,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: denied }),
      };
    }
  }
  try {
    const result = await runSnapshotRefresh({
      full: params.full === '1',
      dry: params.dry === '1',
      force: params.force === '1',
    });
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (err) {
    console.error('snapshot-refresh error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
