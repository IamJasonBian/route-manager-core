const {
  DESIGNATED_STOPS,
  buildStopRiskSnapshot,
  encodeSse,
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
    const snap = buildStopRiskSnapshot({ positions, stops, activity, bookEquity: 75662 });
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
      activity: [],
      bookEquity: 1000,
    });
    const mu = snap.names.find((n) => n.symbol === 'MU');
    expect(mu.covered_qty).toBe(0);
    expect(mu.trail_percent).toBe(4);
    expect(mu.uncovered_qty).toBe(1);
  });

  it('emits a coverage_gap risk when whole shares sit uncovered', () => {
    const snap = buildStopRiskSnapshot({ positions, stops, activity, bookEquity: 75662 });
    const gaps = snap.events.filter((e) => e.type === 'risk' && e.code === 'coverage_gap');
    expect(gaps.map((e) => e.symbol)).toContain('NBIS');
    expect(gaps.find((e) => e.symbol === 'NBIS').severity).toBe('critical');
  });

  it('does not emit coverage_gap for a fully covered designated name', () => {
    const snap = buildStopRiskSnapshot({
      positions: [positions[1]],
      stops,
      activity: [],
      bookEquity: 1000,
    });
    expect(snap.events.some((e) => e.symbol === 'MU' && e.code === 'coverage_gap')).toBe(false);
  });

  it('maps bot activity onto the live event list', () => {
    const snap = buildStopRiskSnapshot({ positions, stops, activity, bookEquity: 75662 });
    const acts = snap.events.filter((e) => e.type === 'activity');
    expect(acts).toHaveLength(1);
    expect(acts[0].symbol).toBe('NBIS');
    expect(acts[0].order_id).toBe('stop-nbis');
  });

  it('ignores non-designated names', () => {
    const snap = buildStopRiskSnapshot({ positions, stops, activity, bookEquity: 75662 });
    expect(snap.names.map((n) => n.symbol).sort()).toEqual(['MU', 'NBIS']);
  });

  it('flags concentration when a designated name is a large share of equity', () => {
    const snap = buildStopRiskSnapshot({ positions, stops, activity, bookEquity: 75662 });
    const conc = snap.events.find((e) => e.code === 'concentration' && e.symbol === 'NBIS');
    expect(conc).toBeTruthy();
    expect(conc.severity).toBe('warning');
    expect(conc.weight_pct).toBeCloseTo(25082 / 75662, 3);
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
