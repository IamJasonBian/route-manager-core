/**
 * Live stop-risk snapshot for designated names (MU 4%, NBIS 6%), plus a tail
 * of the last 120 engine order events (all symbols) and live quotes for them.
 *
 * GET  /.netlify/functions/stop-events-sse
 *   Accept: text/event-stream  → SSE frames (EventSource reconnects after close)
 *   Accept: application/json   → JSON snapshot
 *
 * Sources (public reads, no RH credentials):
 *   Trading DB positions + bot activity, engine trailing-stop book + orders,
 *   engine order history (event tail) and quotes (price frames).
 */

const {
  DESIGNATED_STOPS,
  EVENT_TAIL,
  buildStopRiskSnapshot,
  engineOrderEvents,
  snapshotToSse,
  tailEvents,
} = require('./lib/stopEvents.cjs');

const TRADING_DB = (
  process.env.TRADING_DB_URL || 'https://5thstreetcapital.org/.netlify/functions'
).replace(/\/$/, '');
const ENGINE_API = (
  process.env.ENGINE_API_URL || 'https://allocation-engine-api.onrender.com'
).replace(/\/$/, '');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function pickPositions(dbPos, enginePos) {
  const fromDb = dbPos?.data?.positions || dbPos?.positions || [];
  if (Array.isArray(fromDb) && fromDb.length) return fromDb;
  return Array.isArray(enginePos?.positions) ? enginePos.positions : [];
}

function asRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.events)) return value.events;
  if (Array.isArray(value?.actions)) return value.actions;
  return [];
}

function pickActivity(dbAct) {
  return asRows(dbAct);
}

function pickStops(trailing, orders) {
  const raw = trailing?.orders || trailing?.data || [];
  const labeled = new Map();
  for (const o of orders?.orders || []) {
    if (o.id && o.symbol) labeled.set(String(o.id), String(o.symbol).toUpperCase());
  }
  return raw.map((s) => ({
    ...s,
    symbol: s.symbol || labeled.get(String(s.id)) || null,
  }));
}

/** Designated names plus every symbol in the event tail, for the quote fetch. */
function quoteSymbols(history) {
  const tail = tailEvents(engineOrderEvents(history), EVENT_TAIL);
  return [...new Set([...Object.keys(DESIGNATED_STOPS), ...tail.map((e) => e.symbol)])];
}

async function loadSnapshot() {
  const settled = await Promise.allSettled([
    getJson(`${TRADING_DB}/db-positions`),
    getJson(`${TRADING_DB}/db-bot-activity`),
    getJson(`${ENGINE_API}/api/robinhood/trailing-stop`),
    getJson(`${ENGINE_API}/api/orders`),
    getJson(`${ENGINE_API}/api/positions`),
    getJson(`${ENGINE_API}/api/orders/history?limit=${EVENT_TAIL}`),
  ]);
  const [dbPos, dbAct, trailing, orders, enginePos, history] = settled.map((r) =>
    r.status === 'fulfilled' ? r.value : null
  );
  const symbols = quoteSymbols(history);
  const quotes = await getJson(
    `${ENGINE_API}/api/quotes?symbols=${encodeURIComponent(symbols.join(','))}`
  ).catch(() => null);

  return buildStopRiskSnapshot({
    positions: pickPositions(dbPos, enginePos),
    stops: pickStops(trailing, orders),
    activity: pickActivity(dbAct),
    history: history?.orders || [],
    quotes: quotes || {},
    asOf: new Date().toISOString(),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  const accept = event.headers?.accept || event.headers?.Accept || '';
  const format = event.queryStringParameters?.format || '';
  const wantsSse = format === 'sse' || accept.includes('text/event-stream');

  try {
    const snapshot = await loadSnapshot();
    if (wantsSse) {
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: snapshotToSse(snapshot),
      };
    }
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'stop-events failed' }),
    };
  }
};

exports._internal = { pickPositions, pickActivity, pickStops, quoteSymbols };
