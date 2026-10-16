// Tests for market-context: NBBO + minute bar at execution times (Alpaca),
// option snapshots, and the per-symbol vol surface.

const t = require('../../netlify/functions/lib/tradingDb.cjs');
const mc = require('../../netlify/functions/market-context.cjs');

const event = (params) => ({ httpMethod: 'GET', path: '/.netlify/functions/market-context', queryStringParameters: params, headers: {} });
const parse = (res) => JSON.parse(res.body);

function alpacaResponse(body, status = 200) {
  return { ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) };
}

const QUOTE = { t: '2026-10-14T22:26:30.900Z', bp: 180.05, bs: 2, ap: 180.2, as: 3, bx: 'Q', ax: 'P' };
const BAR = { t: '2026-10-14T22:26:00Z', o: 180.3, h: 180.4, l: 179.9, c: 180.1, v: 5200, n: 140, vw: 180.12 };

let fetchMock;

beforeEach(() => {
  t.__resetForTests();
  t.__setTestClient(t.createMemoryClient());
  process.env.ALPACA_API_KEY = 'k';
  process.env.ALPACA_SECRET_KEY = 's';
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/quotes?')) return Promise.resolve(alpacaResponse({ quotes: [QUOTE], symbol: 'NBIS' }));
    if (u.includes('/bars?')) return Promise.resolve(alpacaResponse({ bars: [BAR], symbol: 'NBIS' }));
    if (u.includes('/options/snapshots')) {
      return Promise.resolve(alpacaResponse({
        snapshots: {
          NBIS261127C00220000: {
            latestQuote: { bp: 10, bs: 258, ap: 12, as: 120, t: '2026-10-16T08:15:00Z' },
            latestTrade: { p: 11.2, s: 1, t: '2026-10-15T19:59:00Z' },
            impliedVolatility: 0.81,
            greeks: { delta: 0.31, gamma: 0.008, theta: -0.21, vega: 0.25 },
          },
        },
      }));
    }
    return Promise.resolve(alpacaResponse({ message: 'not mocked' }, 404));
  });
});

afterEach(() => {
  fetchMock.mockRestore();
  delete process.env.ALPACA_API_KEY;
  delete process.env.ALPACA_SECRET_KEY;
});

afterAll(() => t.__resetForTests());

describe('sessionOf', () => {
  test.each([
    ['2026-10-14T13:35:00Z', 'regular'],   // 9:35 ET Wed
    ['2026-10-14T12:00:00Z', 'pre'],       // 8:00 ET
    ['2026-10-14T22:26:31Z', 'post'],      // 18:26 ET
    ['2026-10-13T00:07:18Z', 'overnight'], // 20:07 ET Mon
    ['2026-10-10T15:00:00Z', 'closed'],    // Saturday
    ['2026-10-17T01:00:00Z', 'closed'],    // Fri 21:00 ET
    ['2026-10-19T00:30:00Z', 'overnight'], // Sun 20:30 ET — 24h market reopens
  ])('%s → %s', (iso, session) => {
    expect(mc.sessionOf(Date.parse(iso))).toBe(session);
  });
});

describe('action=fills', () => {
  test('returns the NBBO in force and the minute bar for each time', async () => {
    const res = await mc.handler(event({ action: 'fills', symbol: 'nbis', t: '2026-10-14T22:26:31.183Z' }));
    expect(res.statusCode).toBe(200);
    const body = parse(res);
    expect(body.symbol).toBe('NBIS');
    const [r] = body.results;
    expect(r.session).toBe('post');
    expect(r.feed).toBe('sip');
    expect(r.quote).toMatchObject({ bid: 180.05, ask: 180.2, bid_size: 2, ask_size: 3, bid_exchange: 'Q' });
    expect(r.quote.age_ms).toBe(283);
    expect(r.bar).toMatchObject({ high: 180.4, low: 179.9, vwap: 180.12, volume: 5200 });

    const quoteUrl = fetchMock.mock.calls.map(c => String(c[0])).find(u => u.includes('/quotes?'));
    expect(quoteUrl).toContain('/v2/stocks/NBIS/quotes?');
    expect(quoteUrl).toContain('end=2026-10-14T22:26:31.183Z');
    expect(quoteUrl).toContain('sort=desc');
    expect(quoteUrl).toContain('feed=sip');
  });

  test('caches historical lookups so repeat loads cost no upstream calls', async () => {
    await mc.handler(event({ action: 'fills', symbol: 'NBIS', t: '2026-10-14T22:26:31.183Z' }));
    const calls = fetchMock.mock.calls.length;
    const res = await mc.handler(event({ action: 'fills', symbol: 'NBIS', t: '2026-10-14T22:26:31.183Z' }));
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(parse(res).results[0].cached).toBe(true);
  });

  test('falls back to IEX when the plan refuses SIP', async () => {
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('feed=sip')) return Promise.resolve(alpacaResponse({ message: 'subscription does not permit querying recent SIP data' }, 403));
      if (u.includes('/quotes?')) return Promise.resolve(alpacaResponse({ quotes: [QUOTE] }));
      return Promise.resolve(alpacaResponse({ bars: [BAR] }));
    });
    const res = await mc.handler(event({ action: 'fills', symbol: 'NBIS', t: new Date(Date.now() - 60_000).toISOString() }));
    expect(parse(res).results[0].feed).toBe('iex');
  });

  test('reports a missing quote instead of failing the batch', async () => {
    fetchMock.mockImplementation((url) => Promise.resolve(alpacaResponse(String(url).includes('/quotes?') ? { quotes: [] } : { bars: [] })));
    const res = await mc.handler(event({ action: 'fills', symbol: 'NBIS', t: '2026-10-13T00:07:18.449Z' }));
    const [r] = parse(res).results;
    expect(r.session).toBe('overnight');
    expect(r.quote).toBeNull();
    expect(r.bar).toBeNull();
  });

  test('validates input', async () => {
    expect((await mc.handler(event({ action: 'fills', symbol: 'NBIS' }))).statusCode).toBe(400);
    expect((await mc.handler(event({ action: 'fills', symbol: 'NBIS', t: 'yesterday' }))).statusCode).toBe(400);
    const many = Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2026, 9, 1, 14, i)).toISOString()).join(',');
    expect((await mc.handler(event({ action: 'fills', symbol: 'NBIS', t: many }))).statusCode).toBe(400);
    expect((await mc.handler(event({ action: 'nope' }))).statusCode).toBe(400);
  });

  test('503 without Alpaca credentials', async () => {
    delete process.env.ALPACA_API_KEY;
    const res = await mc.handler(event({ action: 'fills', symbol: 'NBIS', t: '2026-10-14T22:26:31Z' }));
    expect(res.statusCode).toBe(503);
  });
});

describe('action=options', () => {
  test('maps the latest quote, IV and greeks per contract', async () => {
    const res = await mc.handler(event({ action: 'options', occ: 'NBIS261127C00220000,NBIS261127P00150000' }));
    const body = parse(res);
    expect(body.contracts[0]).toMatchObject({ occ: 'NBIS261127C00220000', found: true, bid: 10, ask: 12, bid_size: 258, ask_size: 120, iv: 0.81, last: 11.2 });
    expect(body.contracts[1]).toEqual({ occ: 'NBIS261127P00150000', found: false });
  });

  test('rejects malformed OCC symbols', async () => {
    expect((await mc.handler(event({ action: 'options', occ: 'NBIS 220 C' }))).statusCode).toBe(400);
  });
});

describe('action=surface', () => {
  test('returns the configured surface for one symbol', async () => {
    const res = await mc.handler(event({ action: 'surface', symbol: 'NBIS' }));
    const body = parse(res);
    expect(body.ok).toBe(true);
    expect(body.surface.underlying).toBe('NBIS');
    expect(body.meta.source).toBe('mock'); // VOL_SURFACE_SOURCE unset → parametric mock
    expect(Array.isArray(body.surface.iv)).toBe(true);
  });
});
