// market-context.cjs
// Market context for one ticker, for the Ticker P&L page's fill-quality and
// vol-calibration panels. Reads the Alpaca Data API with the site's
// ALPACA_API_KEY / ALPACA_SECRET_KEY (the same keys the vol surfaces use).
//
//   GET /.netlify/functions/market-context?action=fills&symbol=NBIS&t=<iso>,<iso>…
//       → NBBO in force at each execution time (last quote at/before t) and the
//         1-minute bar containing t (OHLC, volume, VWAP). Historical lookups are
//         immutable, so they are cached in the trading DB's market_cache.
//   GET /.netlify/functions/market-context?action=options&occ=NBIS261127C00220000,…
//       → latest option snapshots: bid/ask with sizes, last trade, IV, greeks.
//   GET /.netlify/functions/market-context?action=surface&symbol=NBIS
//       → the symbol's vol surface via lib/vol-surface-pipeline (blob → Alpaca
//         → mock per VOL_SURFACE_SOURCE), cached for 5 minutes.
//
// Execution times are classified by New York session: pre (4:00–9:30),
// regular (9:30–16:00), post (16:00–20:00), overnight (20:00–4:00 — Robinhood
// 24 Hour Market, which trades off-exchange and has no consolidated quote).

'use strict';

const t = require('./lib/tradingDb.cjs');
const { CORS: BASE_CORS, json, fetchWithTimeout } = require('./lib/http.cjs');
const { resolveSurfaceForSymbol } = require('./lib/vol-surface-pipeline.cjs');
const { getConfig } = require('./lib/vol-surface-config.cjs');

const DATA = 'https://data.alpaca.markets';
const CORS = { ...BASE_CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const respond = (statusCode, body) => json(statusCode, body, CORS);

const MAX_TIMES = 30;            // per request — the client batches larger sets
const MAX_OCC = 20;
const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 4000;   // Netlify sync functions die at 10s
const QUOTE_LOOKBACK_MS = 10 * 60_000;
const IMMUTABLE_AFTER_MS = 20 * 60_000; // SIP history is final (and queryable) after ~15 min
const SURFACE_TTL_MS = 5 * 60_000;
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const OCC_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

function alpacaHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) return null;
  return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
}

async function alpacaGet(path, headers) {
  const res = await fetchWithTimeout(`${DATA}${path}`, { headers }, FETCH_TIMEOUT_MS);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(`Alpaca ${res.status}: ${(body && (body.message || body.msg)) || text.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function sessionOf(ms) {
  const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = parts.weekday;
  if (weekday === 'Sat' || (weekday === 'Sun' && minutes < 20 * 60)) return 'closed';
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'pre';
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'regular';
  if (minutes >= 16 * 60 && minutes < 20 * 60) return 'post';
  // Friday 20:00 onward belongs to the weekend
  if (weekday === 'Fri' && minutes >= 20 * 60) return 'closed';
  return 'overnight';
}

// ── Stock NBBO + minute bar at an execution time ──────────────────────────────

function mapQuote(q, atMs) {
  if (!q) return null;
  const time = q.t;
  return {
    bid: q.bp ?? null,
    ask: q.ap ?? null,
    bid_size: q.bs ?? null,
    ask_size: q.as ?? null,
    bid_exchange: q.bx ?? null,
    ask_exchange: q.ax ?? null,
    time,
    age_ms: time ? Math.max(0, atMs - Date.parse(time)) : null,
  };
}

function mapBar(b) {
  if (!b) return null;
  return { time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vwap: b.vw ?? null, trades: b.n ?? null };
}

/** SIP first (full consolidated tape); IEX if the plan refuses recent SIP. */
async function withFeed(fn) {
  try {
    return { feed: 'sip', value: await fn('sip') };
  } catch (err) {
    if (err.status === 403 || err.status === 422) return { feed: 'iex', value: await fn('iex') };
    throw err;
  }
}

async function contextAt(symbol, iso, headers) {
  const atMs = Date.parse(iso);
  const session = sessionOf(atMs);
  const minuteStart = new Date(Math.floor(atMs / 60_000) * 60_000);
  const quoteStart = new Date(atMs - QUOTE_LOOKBACK_MS).toISOString();
  const end = new Date(atMs).toISOString();

  const [quoteRes, barRes] = await Promise.allSettled([
    withFeed(feed => alpacaGet(
      `/v2/stocks/${symbol}/quotes?start=${quoteStart}&end=${end}&limit=1&sort=desc&feed=${feed}`, headers)),
    withFeed(feed => alpacaGet(
      `/v2/stocks/${symbol}/bars?timeframe=1Min&start=${minuteStart.toISOString()}&end=${new Date(minuteStart.getTime() + 59_999).toISOString()}&limit=1&feed=${feed}&adjustment=raw`, headers)),
  ]);

  const errors = [];
  let quote = null;
  let bar = null;
  let feed = null;
  if (quoteRes.status === 'fulfilled') {
    quote = mapQuote(quoteRes.value.value?.quotes?.[0], atMs);
    feed = quoteRes.value.feed;
  } else errors.push(`quote: ${quoteRes.reason.message}`);
  if (barRes.status === 'fulfilled') bar = mapBar(barRes.value.value?.bars?.[0]);
  else errors.push(`bar: ${barRes.reason.message}`);

  return { t: iso, session, feed, quote, bar, error: errors.length ? errors.join('; ') : null };
}

async function handleFills(db, params, headers) {
  const symbol = (params.symbol || '').toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return respond(400, { ok: false, error: 'symbol is required' });
  const times = (params.t || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!times.length) return respond(400, { ok: false, error: 't (comma-separated ISO times) is required' });
  if (times.length > MAX_TIMES) return respond(400, { ok: false, error: `At most ${MAX_TIMES} times per request` });
  const bad = times.find(x => !Number.isFinite(Date.parse(x)));
  if (bad) return respond(400, { ok: false, error: `Unparseable time "${bad}"` });

  const now = Date.now();
  const results = await mapLimit(times, CONCURRENCY, async (raw) => {
    const iso = new Date(Date.parse(raw)).toISOString();
    const cacheKey = `market-context:fill:v1:${symbol}:${iso}`;
    if (db) {
      try {
        const hit = await t.getMarketCache(db, cacheKey);
        if (hit?.payload) return { ...hit.payload, cached: true };
      } catch { /* cache is best-effort */ }
    }
    const ctx = await contextAt(symbol, iso, headers);
    const immutable = now - Date.parse(iso) > IMMUTABLE_AFTER_MS;
    if (db && immutable && !ctx.error) {
      try { await t.setMarketCache(db, cacheKey, 'market-context', ctx); } catch { /* best-effort */ }
    }
    return { ...ctx, cached: false };
  });

  return respond(200, { ok: true, symbol, as_of: new Date(now).toISOString(), results });
}

// ── Option snapshots ──────────────────────────────────────────────────────────

function mapOptionSnapshot(occ, s) {
  if (!s) return { occ, found: false };
  const q = s.latestQuote || {};
  const tr = s.latestTrade || {};
  return {
    occ,
    found: true,
    bid: q.bp ?? null,
    ask: q.ap ?? null,
    bid_size: q.bs ?? null,
    ask_size: q.as ?? null,
    quote_time: q.t ?? null,
    last: tr.p ?? null,
    last_size: tr.s ?? null,
    last_time: tr.t ?? null,
    iv: s.impliedVolatility ?? null,
    greeks: s.greeks ?? null,
  };
}

async function handleOptions(params, headers) {
  const occ = (params.occ || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!occ.length) return respond(400, { ok: false, error: 'occ (comma-separated OCC symbols) is required' });
  if (occ.length > MAX_OCC) return respond(400, { ok: false, error: `At most ${MAX_OCC} contracts per request` });
  const bad = occ.find(s => !OCC_RE.test(s));
  if (bad) return respond(400, { ok: false, error: `Not an OCC symbol: "${bad}"` });
  const body = await alpacaGet(`/v1beta1/options/snapshots?symbols=${occ.join(',')}&feed=indicative`, headers);
  const snaps = body?.snapshots || {};
  return respond(200, { ok: true, feed: 'indicative', as_of: new Date().toISOString(), contracts: occ.map(s => mapOptionSnapshot(s, snaps[s])) });
}

// ── Vol surface ───────────────────────────────────────────────────────────────

async function handleSurface(db, params) {
  const symbol = (params.symbol || '').toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return respond(400, { ok: false, error: 'symbol is required' });
  const cacheKey = `market-context:surface:v1:${symbol}`;
  if (db) {
    try {
      const hit = await t.getMarketCache(db, cacheKey);
      if (hit?.payload && hit.age_ms < SURFACE_TTL_MS) return respond(200, { ...hit.payload, cached: true });
    } catch { /* best-effort */ }
  }
  const { surface, chainMeta } = await resolveSurfaceForSymbol(symbol, getConfig());
  const payload = { ok: true, symbol, as_of: new Date().toISOString(), surface: surface || null, meta: chainMeta || null };
  if (db && surface && chainMeta?.source !== 'mock') {
    try { await t.setMarketCache(db, cacheKey, 'market-context', payload); } catch { /* best-effort */ }
  }
  return respond(200, { ...payload, cached: false });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(200, '');
  if (event.httpMethod !== 'GET') return respond(405, { ok: false, error: 'GET only' });

  const params = event.queryStringParameters || {};
  const action = (params.action || '').toLowerCase();
  const db = t.getDb();
  try {
    if (db) await t.ensureSchema(db);
  } catch { /* the cache is optional */ }

  try {
    if (action === 'surface') return await handleSurface(db, params);
    const headers = alpacaHeaders();
    if (action === 'fills' || action === 'options') {
      if (!headers) return respond(503, { ok: false, error: 'ALPACA_API_KEY / ALPACA_SECRET_KEY are not configured on the site' });
      return action === 'fills' ? await handleFills(db, params, headers) : await handleOptions(params, headers);
    }
    return respond(400, { ok: false, error: 'action must be one of: fills, options, surface' });
  } catch (err) {
    console.error('market-context error:', err);
    return respond(502, { ok: false, error: err.message || 'market-context failed' });
  }
};

exports.sessionOf = sessionOf;
