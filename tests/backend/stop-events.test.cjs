const {
  DESIGNATED_STOPS,
  EVENT_TAIL,
  buildStopRiskSnapshot,
  encodeSse,
  engineOrderEvents,
  snapshotToSse,
} = require('../../netlify/functions/lib/stopEvents.cjs');

describe('DESIGNATED_STOPS', () => {
  it('codes MU at 4% and NBIS at 6%', () => {
    expect(DESIGNATED_STOPS).toEqual({ MU: 4, NBIS: 6 });
  });
});

describe('buildStopRiskSnapshot', () => {
  const positions = [
    {
      symbol: 'NBIS',
      quantity: 120.126,
      avg_buy_price: 212.14,
      current_price: 208.8,
      equity: 25082,
      profit_loss: -402,
      profit_loss_pct: -1.58,
    },
    {
      symbol: 'MU',
      quantity: 1,
      avg_buy_price: 100,
      current_price: 96,
      equity: 96,
      profit_loss: -4,
      profit_loss_pct: -4,
    },
    {
      symbol: 'SPY',
      quantity: 27,
      avg_buy_price: 640,
      current_price: 685,
      equity: 18495,
      profit_loss: 1215,
      profit_loss_pct: 7,
    },
  ];

  const stops = [
    {
      id: 'stop-nbis',
      symbol: null,
      quantity: '35',
      stop_price: '194.96',
      type: 'market',
      state: 'confirmed',
      trailing_peg: { percentage: 6, type: 'percentage' },
      last_trail_price: { amount: '195.36' },
    },
    {
      id: 'stop-mu',
      symbol: 'MU',
      quantity: '1',
      stop_price: '92.16',
      type: 'limit',
      state: 'confirmed',
      trailing_peg: { percentage: 4, type: 'percentage' },
      last_trail_price: { amount: '92.20' },
    },
  ];

  const activity = [
    {
      id: 127,
      order_id: 'stop-nbis',
      event_type: 'TRAILING_STOP_ORDER',
      status: 'queued',
      symbol: 'NBIS',
      quantity: 35.126,
      created_at: '2026-10-12T23:55:14.385Z',
    },
  ];

  it('joins a symbol-less stop to NBIS via bot-activity order_id', () => {
    const snap = buildStopRiskSnapshot({ positions, stops, activity });
    const nbis = snap.names.find((n) => n.symbol === 'NBIS');
    expect(nbis.covered_qty).toBe(35);
    expect(nbis.uncovered_qty).toBeCloseTo(85.126, 3);
    expect(nbis.trail_percent).toBe(6);
    expect(nbis.stop_price).toBeCloseTo(194.96, 2);
    expect(nbis.coverage_pct).toBeCloseTo(35 / 120.126, 3);
  });

  it('uses the coded trail when the live stop is missing', () => {
    const snap = buildStopRiskSnapshot({
      positions: [positions[1]],
      stops: [],
      activity: []
    });
    const mu = snap.names.find((n) => n.symbol === 'MU');
    expect(mu.covered_qty).toBe(0);
    expect(mu.trail_percent).toBe(4);
    expect(mu.uncovered_qty).toBe(1);
  });

  it('ignores non-designated names', () => {
    const snap = buildStopRiskSnapshot({ positions, stops, activity });
    expect(snap.names.map((n) => n.symbol).sort()).toEqual(['MU', 'NBIS']);
  });


  const order = (i, extra = {}) => ({
    id: `o-${i}`,
    symbol: i % 2 ? 'NBIS' : 'SPY',
    side: i % 3 ? 'BUY' : 'SELL',
    state: 'filled',
    type: 'limit',
    quantity: 1,
    filled_quantity: 1,
    price: 100 + i,
    limit_price: 100 + i,
    stop_price: null,
    created_at: new Date(Date.UTC(2026, 9, 14, 13, 0, i)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 9, 14, 14, 0, i)).toISOString(),
    ...extra,
  });

  it('maps engine order history into tagged events for every symbol', () => {
    const [evt] = engineOrderEvents([
      order(1, { state: 'queued', price: null, limit_price: null, stop_price: 174.92, type: 'market' }),
    ]);
    expect(evt).toMatchObject({
      type: 'engine',
      id: 'o-1',
      code: 'order_queued',
      symbol: 'NBIS',
      order_type: 'stop',
      price: 174.92,
      ts: order(1).updated_at,
    });
  });

  it('keeps only the newest EVENT_TAIL engine events, newest first', () => {
    const history = Array.from({ length: EVENT_TAIL + 30 }, (_, i) => order(i));
    const snap = buildStopRiskSnapshot({ positions, stops, history });
    expect(EVENT_TAIL).toBe(120);
    expect(snap.events).toHaveLength(EVENT_TAIL);
    expect(snap.events[0].id).toBe(`o-${EVENT_TAIL + 29}`);
    expect(snap.events.every((e) => e.type === 'engine')).toBe(true);
  });

  it('emits a price frame per quoted symbol and fills a missing mark from it', () => {
    const snap = buildStopRiskSnapshot({
      positions: [{ symbol: 'NBIS', quantity: 10 }],
      stops,
      quotes: { prices: { NBIS: 211.01, MU: 96 } },
      asOf: '2026-10-14T22:00:00Z',
    });
    expect(snap.names.find((n) => n.symbol === 'NBIS').mark).toBe(211.01);
    expect(snap.prices.NBIS).toEqual({ symbol: 'NBIS', price: 211.01, ts: '2026-10-14T22:00:00Z' });
    expect(snapshotToSse(snap)).toContain('event: price\nid: NBIS-2026-10-14T22:00:00Z');
  });
});

describe('stop-events-sse handler', () => {
  const { handler } = require('../../netlify/functions/stop-events-sse.cjs');

  beforeEach(() => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { positions: [], account: { equity: 1 } }, orders: [] }),
      })
    );
  });

  it('returns JSON by default and SSE when requested', async () => {
    const json = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    expect(json.statusCode).toBe(200);
    const body = JSON.parse(json.body);
    expect(body.names.map((n) => n.symbol).sort()).toEqual(['MU', 'NBIS']);

    const sse = await handler({
      httpMethod: 'GET',
      headers: { accept: 'text/event-stream' },
      queryStringParameters: { format: 'sse' },
    });
    expect(sse.headers['Content-Type']).toBe('text/event-stream');
    expect(sse.body).toContain('event: snapshot');
    expect(sse.body).toContain('event: coverage');
  });
});

describe('encodeSse', () => {
  it('writes event / id / data / retry frames', () => {
    const frame = encodeSse({
      event: 'coverage',
      id: 'NBIS',
      data: { symbol: 'NBIS', covered_qty: 35 },
      retry: 8000,
    });
    expect(frame).toContain('event: coverage\n');
    expect(frame).toContain('id: NBIS\n');
    expect(frame).toContain('retry: 8000\n');
    expect(frame).toContain('data: {"symbol":"NBIS","covered_qty":35}\n');
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});
