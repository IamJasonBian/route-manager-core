const { fetchWithTimeout, json, CORS } = require('../../netlify/functions/lib/http.cjs');
const bot = require('../../netlify/functions/robinhood-bot.cjs');

describe('lib/http', () => {
  let fetchMock;
  afterEach(() => fetchMock && fetchMock.mockRestore());

  test('json() sets CORS + content type and allows overrides', () => {
    const res = json(201, { a: 1 }, { 'X-Cache': 'HIT' });
    expect(res.statusCode).toBe(201);
    expect(res.headers).toMatchObject({ ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
    expect(JSON.parse(res.body)).toEqual({ a: 1 });
  });

  test('fetchWithTimeout aborts and names the host', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    await expect(fetchWithTimeout('https://slow.example/x', {}, 20))
      .rejects.toThrow('slow.example timed out after 20ms');
  });

  test('fetchWithTimeout honours a caller signal and passes other errors through', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('caller abort')))));
    const ctrl = new AbortController();
    const p = fetchWithTimeout('https://x.example', { signal: ctrl.signal }, 5000);
    ctrl.abort();
    await expect(p).rejects.toThrow('caller abort');
  });
});

describe('robinhood-bot guards', () => {
  const OLD = process.env.TRADING_DB_TOKEN;
  afterEach(() => {
    if (OLD === undefined) delete process.env.TRADING_DB_TOKEN;
    else process.env.TRADING_DB_TOKEN = OLD;
  });

  test('action=order requires write auth when TRADING_DB_TOKEN is set', async () => {
    process.env.TRADING_DB_TOKEN = 'secret';
    const res = await bot.handler({
      httpMethod: 'POST',
      queryStringParameters: { action: 'order' },
      headers: {},
      body: JSON.stringify({ symbol: 'AAPL', side: 'buy', quantity: 1, dryRun: false }),
    });
    expect(res.statusCode).toBe(401);
  });

  test('action=order is disabled when TRADING_DB_TOKEN is unset', async () => {
    delete process.env.TRADING_DB_TOKEN;
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const res = await bot.handler({
        httpMethod: 'POST',
        queryStringParameters: { action: 'order' },
        headers: {},
        body: JSON.stringify({ symbol: 'AAPL', side: 'buy', quantity: 1, dryRun: false }),
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(/disabled/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('validation errors are 400', async () => {
    const quote = await bot.handler({ httpMethod: 'GET', queryStringParameters: { action: 'quote' } });
    expect(quote.statusCode).toBe(400);
    const unknown = await bot.handler({ httpMethod: 'GET', queryStringParameters: { action: 'nope' } });
    expect(unknown.statusCode).toBe(400);
  });
});
