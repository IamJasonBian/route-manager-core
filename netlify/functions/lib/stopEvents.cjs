/** Designated trailing-stop names and the coded trail percentages. */
const DESIGNATED_STOPS = Object.freeze({ MU: 4, NBIS: 6 });

const CONCENTRATION_WARN = 0.15;
const COVERAGE_CRITICAL = 0.5;

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

function riskEventsFor(name, bookEquity) {
  const events = [];
  const wholeUncovered = Math.floor(name.uncovered_qty);
  if (wholeUncovered >= 1) {
    events.push({
      type: 'risk',
      code: 'coverage_gap',
      symbol: name.symbol,
      severity: name.coverage_pct < COVERAGE_CRITICAL ? 'critical' : 'warning',
      message: `${name.symbol} stop covers ${name.covered_qty} of ${name.quantity} shares (${(name.coverage_pct * 100).toFixed(0)}%)`,
      uncovered_qty: name.uncovered_qty,
      covered_qty: name.covered_qty,
    });
  }

  const weight = bookEquity > 0 ? name.equity / bookEquity : 0;
  if (weight >= CONCENTRATION_WARN) {
    events.push({
      type: 'risk',
      code: 'concentration',
      symbol: name.symbol,
      severity: 'warning',
      message: `${name.symbol} is ${(weight * 100).toFixed(1)}% of equity`,
      weight_pct: weight,
    });
  }

  if (name.mark > 0 && name.stop_price > 0) {
    const room = (name.mark - name.stop_price) / name.mark;
    if (room >= 0 && room <= 0.02) {
      events.push({
        type: 'risk',
        code: 'tight_trail',
        symbol: name.symbol,
        severity: 'warning',
        message: `${name.symbol} mark is ${(room * 100).toFixed(1)}% above the stop`,
        room_pct: room,
      });
    }
  }
  return events;
}

function activityEvents(activity) {
  const designated = new Set(Object.keys(DESIGNATED_STOPS));
  const rows = Array.isArray(activity) ? activity : [];
  return rows
    .filter((a) => designated.has(String(a.symbol || '').toUpperCase()))
    .map((a) => ({
      type: 'activity',
      id: a.id != null ? String(a.id) : a.event_id || a.order_id,
      order_id: a.order_id || null,
      symbol: String(a.symbol).toUpperCase(),
      event_type: a.event_type || a.type || 'TRAILING_STOP_ORDER',
      status: a.status || 'queued',
      quantity: num(a.quantity),
      created_at: a.created_at || a.timestamp || null,
      message: a.message || null,
    }));
}

function buildStopRiskSnapshot({
  positions = [],
  stops = [],
  activity = [],
  bookEquity = 0,
  asOf = new Date().toISOString(),
} = {}) {
  const names = Object.keys(DESIGNATED_STOPS).map((symbol) => {
    const position = (positions || []).find(
      (p) => String(p.symbol || '').toUpperCase() === symbol
    ) || { symbol, quantity: 0, current_price: 0, equity: 0 };
    const stop = resolveStop(symbol, stops, activity);
    return coverageFor(position, stop, DESIGNATED_STOPS[symbol]);
  });

  const events = [
    ...names.flatMap((n) => riskEventsFor(n, bookEquity)),
    ...activityEvents(activity),
  ];

  return { as_of: asOf, names, events };
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
    ...snapshot.events.map((e, i) =>
      encodeSse({
        event: e.type,
        id: e.id || `${e.code || e.type}-${e.symbol || i}`,
        data: e,
      })
    ),
  ];
  return frames.join('');
}

module.exports = {
  DESIGNATED_STOPS,
  buildStopRiskSnapshot,
  encodeSse,
  snapshotToSse,
  resolveStop,
};
