/** Designated trailing-stop names and the coded trail percentages. */
const DESIGNATED_STOPS = Object.freeze({ MU: 4, NBIS: 6 });

/** How many engine events the SSE tail keeps. */
const EVENT_TAIL = 120;

function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'object') {
    if (v.amount != null) return num(v.amount);
    return 0;
  }
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function trailOf(stop, fallback) {
  const peg = stop && stop.trailing_peg;
  if (peg && peg.percentage != null) return num(peg.percentage);
  if (stop && stop.trail_percent != null) return num(stop.trail_percent);
  return fallback;
}

function indexStopsById(stops) {
  const byId = new Map();
  for (const stop of stops || []) {
    if (stop && stop.id) byId.set(String(stop.id), stop);
  }
  return byId;
}

function resolveStop(symbol, stops, activity) {
  const upper = symbol.toUpperCase();
  const labeled = (stops || []).find((s) => String(s.symbol || '').toUpperCase() === upper);
  if (labeled) return labeled;

  const rows = Array.isArray(activity) ? activity : [];
  const match = rows.find(
    (a) => String(a.symbol || '').toUpperCase() === upper && a.order_id
  );
  if (!match) return null;
  const byId = indexStopsById(stops);
  return byId.get(String(match.order_id)) || null;
}

function coverageFor(position, stop, codedTrail) {
  const qty = num(position.quantity ?? position.qty);
  const covered = stop ? Math.min(qty, num(stop.quantity ?? stop.qty)) : 0;
  const uncovered = Math.max(0, qty - covered);
  const mark = num(position.current_price ?? position.currentPrice);
  const stopPrice = stop ? num(stop.stop_price ?? stop.stopPrice) : null;
  const lastTrail = stop ? num(stop.last_trail_price) : null;
  return {
    symbol: String(position.symbol).toUpperCase(),
    quantity: qty,
    covered_qty: covered,
    uncovered_qty: uncovered,
    coverage_pct: qty > 0 ? covered / qty : 0,
    trail_percent: trailOf(stop, codedTrail),
    coded_trail_percent: codedTrail,
    stop_price: stopPrice,
    last_trail_price: lastTrail,
    mark,
    avg_entry: num(position.avg_buy_price ?? position.avg_entry ?? position.averageCost),
    equity: num(position.equity ?? position.market_value ?? position.currentValue),
    profit_loss: num(position.profit_loss ?? position.unrealized_pl),
    profit_loss_pct: num(position.profit_loss_pct ?? position.unrealized_pl_pct),
    stop_id: stop ? stop.id || null : null,
    stop_type: stop ? stop.type || null : null,
    stop_state: stop ? stop.state || null : null,
  };
}

function engineOrderEvents(history) {
  const rows = Array.isArray(history) ? history : history?.orders || [];
  return rows
    .filter((o) => o && o.id && o.symbol)
    .map((o) => {
      const side = String(o.side || '').toUpperCase();
      const state = String(o.state || o.status || 'unknown').toLowerCase();
      const qty = num(o.quantity ?? o.qty);
      const fill = num(o.price);
      const limit = o.limit_price != null ? num(o.limit_price) : null;
      const stop = o.stop_price != null ? num(o.stop_price) : null;
      const price = fill || limit || stop || 0;
      const kind = stop ? 'stop' : String(o.type || 'order').toLowerCase();
      return {
        type: 'engine',
        id: String(o.id),
        order_id: String(o.id),
        code: `order_${state}`,
        symbol: String(o.symbol).toUpperCase(),
        side,
        status: state,
        order_type: kind,
        quantity: qty,
        filled_quantity: num(o.filled_quantity),
        price,
        limit_price: limit,
        stop_price: stop,
        created_at: o.created_at || null,
        ts: o.updated_at || o.created_at || null,
        message: `${side} ${qty} ${String(o.symbol).toUpperCase()} ${kind} @ ${price ? price.toFixed(2) : '—'}`,
      };
    });
}

function eventTs(e) {
  const t = Date.parse(e.ts || e.created_at || '');
  return Number.isFinite(t) ? t : 0;
}

/** Newest `limit` events, newest first. */
function tailEvents(events, limit = EVENT_TAIL) {
  return [...events].sort((a, b) => eventTs(b) - eventTs(a)).slice(0, limit);
}

function normalizePrices(quotes, asOf) {
  const raw = quotes?.prices || quotes || {};
  const prices = {};
  for (const [symbol, value] of Object.entries(raw)) {
    const price = num(value);
    if (price > 0) prices[symbol.toUpperCase()] = { symbol: symbol.toUpperCase(), price, ts: asOf };
  }
  return prices;
}

function buildStopRiskSnapshot({
  positions = [],
  stops = [],
  activity = [],
  history = [],
  quotes = {},
  asOf = new Date().toISOString(),
} = {}) {
  const names = Object.keys(DESIGNATED_STOPS).map((symbol) => {
    const position = (positions || []).find(
      (p) => String(p.symbol || '').toUpperCase() === symbol
    ) || { symbol, quantity: 0, current_price: 0, equity: 0 };
    const stop = resolveStop(symbol, stops, activity);
    return coverageFor(position, stop, DESIGNATED_STOPS[symbol]);
  });

  const events = tailEvents(engineOrderEvents(history));
  const prices = normalizePrices(quotes, asOf);
  // Engine positions carry no mark; fall back to the live quote.
  for (const name of names) {
    if (!name.mark && prices[name.symbol]) name.mark = prices[name.symbol].price;
  }

  return { as_of: asOf, names, events, prices };
}

function encodeSse({ event, id, data, retry } = {}) {
  const lines = [];
  if (event) lines.push(`event: ${event}`);
  if (id != null) lines.push(`id: ${id}`);
  if (retry != null) lines.push(`retry: ${retry}`);
  lines.push(`data: ${JSON.stringify(data ?? {})}`);
  return `${lines.join('\n')}\n\n`;
}

function snapshotToSse(snapshot, { retry = 8000 } = {}) {
  const frames = [
    encodeSse({ event: 'snapshot', id: snapshot.as_of, data: snapshot, retry }),
    ...snapshot.names.map((n) =>
      encodeSse({ event: 'coverage', id: n.symbol, data: n })
    ),
    ...Object.values(snapshot.prices || {}).map((p) =>
      encodeSse({ event: 'price', id: `${p.symbol}-${p.ts}`, data: p })
    ),
    ...snapshot.events.map((e, i) =>
      encodeSse({
        event: e.type,
        id: e.id || `${e.code}-${e.symbol || i}`,
        data: e,
      })
    ),
  ];
  return frames.join('');
}

module.exports = {
  DESIGNATED_STOPS,
  EVENT_TAIL,
  engineOrderEvents,
  tailEvents,
  buildStopRiskSnapshot,
  encodeSse,
  snapshotToSse,
  resolveStop,
};
