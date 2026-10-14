/**
 * Vite dev plugin — serves mock data from shared/mocks/ on Netlify function endpoints.
 *
 * Usage: `npm run dev:mock` starts Vite with this plugin active.
 * All /.netlify/functions/* requests return realistic mock data seeded from live market data.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type { Plugin } from 'vite';

const MOCK_DIR = path.resolve(__dirname, 'shared/mocks');

// Import the production enrichSnapshot function directly — the mock and the
// deployed Netlify function share the exact same P&L computation code.
const require_ = createRequire(import.meta.url);
const { enrichSnapshot } = require_('./netlify/functions/enriched-snapshot.cjs') as {
  enrichSnapshot: (raw: Record<string, unknown>) => Record<string, unknown>;
};

// Same for market-depth: the mock serves exactly what the deployed function
// returns, so contracts and vol surfaces never drift between the two.
const { buildPayload: buildMarketDepth } = require_('./netlify/functions/market-depth.cjs') as {
  buildPayload: () => Record<string, unknown>;
};

function loadMock(name: string): unknown {
  const file = path.join(MOCK_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const PROD_BASE = 'https://5thstreetcapital.netlify.app/.netlify/functions';

let _liveCache: { data: Record<string, unknown>; ts: number } | null = null;

async function fetchLiveSnapshot(): Promise<Record<string, unknown> | null> {
  // Cache for 30s to avoid hammering prod on every refresh
  if (_liveCache && Date.now() - _liveCache.ts < 30_000) return _liveCache.data;
  try {
    const res = await fetch(`${PROD_BASE}/enriched-snapshot`);
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    _liveCache = { data, ts: Date.now() };
    return data;
  } catch {
    return _liveCache?.data ?? null;
  }
}

/**
 * Build a raw snapshot in the shape `order-book-snapshot` returns, from
 * the local mock fixtures. Then let the production enrichSnapshot do the work.
 */
function buildRawSnapshot(): Record<string, unknown> | null {
  const snapshot = loadMock('order_book_snapshot') as Record<string, unknown> | null;
  if (!snapshot) return null;
  const historicalOrders = (loadMock('_historical_orders') ?? []) as Record<string, unknown>[];

  const portfolio = snapshot.portfolio as Record<string, unknown>;

  return {
    timestamp: snapshot.timestamp,
    portfolio: {
      ...portfolio,
      equity: (portfolio.equity ?? 0) as number,
      market_value: (portfolio.market_value ?? 0) as number,
    },
    order_book: snapshot.order_book ?? [],
    recent_orders: historicalOrders,
    recent_option_orders: [],
    market_data: snapshot.market_data ?? null,
  };
}

// Build mock responses for each Netlify function endpoint
async function getMockResponse(pathname: string, params: URLSearchParams): Promise<{ status: number; body: unknown } | null> {
  const fn = pathname.replace('/.netlify/functions/', '');

  // Order Book Snapshot
  if (fn === 'order-book-snapshot') {
    const snapshot = loadMock('order_book_snapshot');
    return snapshot ? { status: 200, body: snapshot } : null;
  }

  // Robinhood Portfolio
  if (fn === 'robinhood-portfolio') {
    const action = params.get('action');
    const account = loadMock('account') as Record<string, unknown> | null;
    const snapshot = loadMock('order_book_snapshot') as Record<string, unknown> | null;
    const positions = (snapshot?.portfolio as Record<string, unknown>)?.positions ?? [];

    if (action === 'portfolio') {
      return {
        status: 200,
        body: {
          accountNumber: 'MOCK-001',
          buyingPower: account?.buying_power ?? 10000,
          cash: account?.cash ?? 5000,
          portfolioValue: account?.portfolio_value ?? 48750,
          extendedHoursValue: account?.portfolio_value ?? 48750,
          totalGain: 2500,
          positions: (positions as Record<string, unknown>[]).map(p => ({
            symbol: p.symbol,
            name: p.name ?? p.symbol,
            quantity: p.quantity,
            averageCost: p.avg_buy_price,
            currentPrice: p.current_price,
            totalCost: (p.quantity as number) * (p.avg_buy_price as number),
            currentValue: p.equity,
            gain: p.profit_loss,
            gainPercent: p.profit_loss_pct,
          })),
        },
      };
    }

    if (action === 'orders') {
      const orders = (snapshot?.portfolio as Record<string, unknown>)?.open_orders ?? [];
      return {
        status: 200,
        body: (orders as Record<string, unknown>[]).map(o => ({
          id: o.order_id,
          symbol: o.symbol,
          name: o.symbol,
          side: (o.side as string).toLowerCase(),
          type: o.order_type,
          quantity: o.quantity,
          price: o.limit_price,
          state: o.state,
          createdAt: o.created_at,
          updatedAt: o.updated_at,
        })),
      };
    }

    if (action === 'pnl') {
      return {
        status: 200,
        body: {
          totalRealizedPnL: 1250.50,
          totalBuyVolume: 25000,
          totalSellVolume: 26250.50,
          symbols: [],
          orders: [],
        },
      };
    }

    return { status: 200, body: {} };
  }

  // Robinhood Auth
  if (fn === 'robinhood-auth') {
    const action = params.get('action');
    if (action === 'status') {
      return {
        status: 200,
        body: {
          authenticated: true,
          message: 'Mock authenticated',
          expiresIn: 86400,
        },
      };
    }
    if (action === 'connect') {
      return {
        status: 200,
        body: { authenticated: true, message: 'Mock connected' },
      };
    }
    return { status: 200, body: { authenticated: true, message: 'OK' } };
  }

  // Robinhood Bot
  if (fn === 'robinhood-bot') {
    const action = params.get('action');
    if (action === 'status') {
      return {
        status: 200,
        body: { status: 'idle', actionsCount: 0, lastAction: null },
      };
    }
    if (action === 'actions') {
      return { status: 200, body: { actions: [], total: 0 } };
    }
    if (action === 'analyze') {
      const quote = loadMock('quote') as Record<string, unknown> | null;
      return {
        status: 200,
        body: {
          timestamp: new Date().toISOString(),
          buyingPower: 10864.20,
          suggestions: [
            {
              type: 'buy',
              symbol: quote?.symbol ?? 'BTC/USD',
              reason: 'Mock analysis: price below 200-day MA',
              priority: 'medium',
            },
          ],
          holdings: [],
        },
      };
    }
    if (action === 'quote') {
      const quote = loadMock('quote');
      return quote ? { status: 200, body: quote } : null;
    }
    if (action === 'order') {
      return {
        status: 200,
        body: { status: 'ok', message: 'Mock order placed (dry run)', orderId: 'mock-order-001' },
      };
    }
    return { status: 200, body: {} };
  }

  if (fn === 'stop-events-sse') {
    const snapshot = {
      as_of: '2026-10-14T00:00:00Z',
      names: [
        {
          symbol: 'MU',
          quantity: 1,
          covered_qty: 1,
          uncovered_qty: 0,
          coverage_pct: 1,
          trail_percent: 4,
          coded_trail_percent: 4,
          stop_price: 92.16,
          last_trail_price: 92.2,
          mark: 96,
          avg_entry: 100,
          equity: 96,
          profit_loss: -4,
          profit_loss_pct: -4,
          stop_id: 'mock-mu',
          stop_type: 'limit',
          stop_state: 'confirmed',
        },
        {
          symbol: 'NBIS',
          quantity: 120.126,
          covered_qty: 35,
          uncovered_qty: 85.126,
          coverage_pct: 0.291,
          trail_percent: 6,
          coded_trail_percent: 6,
          stop_price: 194.96,
          last_trail_price: 195.36,
          mark: 208.8,
          avg_entry: 212.14,
          equity: 25082,
          profit_loss: -402,
          profit_loss_pct: -1.58,
          stop_id: 'mock-nbis',
          stop_type: 'market',
          stop_state: 'confirmed',
        },
      ],
      events: [
        {
          type: 'engine',
          id: 'mock-nbis-fill',
          code: 'order_filled',
          symbol: 'NBIS',
          side: 'SELL',
          status: 'filled',
          order_type: 'limit',
          quantity: 50,
          price: 207.9,
          ts: '2026-10-13T23:50:00Z',
          message: 'SELL 50 NBIS limit @ 207.90',
        },
        {
          type: 'engine',
          id: 'mock-nbis-stop',
          code: 'order_queued',
          symbol: 'NBIS',
          side: 'SELL',
          status: 'queued',
          order_type: 'stop',
          quantity: 35,
          price: 194.96,
          ts: '2026-10-13T23:55:00Z',
          message: 'SELL 35 NBIS stop @ 194.96',
        },
      ],
      prices: {
        MU: { symbol: 'MU', price: 96, ts: new Date().toISOString() },
        NBIS: { symbol: 'NBIS', price: 208.8 + Math.sin(Date.now() / 60000) * 2, ts: new Date().toISOString() },
      },
    };
    return { status: 200, body: snapshot };
  }

  // Vend blobs
  if (fn === 'vend-blobs') {
    const store = params.get('store');
    const action = params.get('action') ?? 'list';
    const key = params.get('key');

    if (action === 'list') {
      const raw = loadMock('_raw_market_quotes');
      if (store === 'market-quotes' && raw) {
        return {
          status: 200,
          body: { store, count: 1, keys: [(raw as Record<string, unknown>).timestamp ?? 'latest'] },
        };
      }
      if (store === 'option-positions-history') {
        const series = loadMock('_option_position_history') as
          | { timestamp: string }[]
          | null;
        if (series && Array.isArray(series)) {
          // Mirror the live store: keys are ISO timestamps with ":" → "-".
          const keys = series.map(s =>
            s.timestamp.replace(/:/g, '-').replace(/\..*$/, '').replace(/\+.*$/, ''),
          );
          return { status: 200, body: { store, count: keys.length, keys } };
        }
      }
      return { status: 200, body: { store, count: 0, keys: [] } };
    }

    if (action === 'get' && store === 'market-quotes') {
      const raw = loadMock('_raw_market_quotes');
      return raw ? { status: 200, body: { store, key, value: raw } } : null;
    }

    if (action === 'list-symbols' && store === 'options-chain') {
      return { status: 200, body: { symbols: ['AAPL', 'TSLA', 'NVDA', 'MSFT'] } };
    }

    if (action === 'list-dates' && store === 'options-chain') {
      return { status: 200, body: { dates: ['2026-04-13', '2026-04-12', '2026-04-11'] } };
    }

    if (action === 'market-data') {
      const symbol = params.get('symbol') ?? 'AAPL';
      const raw = loadMock('_raw_market_quotes') as Record<string, unknown> | null;
      const quotes = raw?.quotes as Record<string, unknown> | undefined;
      const symbolQuote = quotes?.[symbol] as Record<string, unknown> | undefined;

      return {
        status: 200,
        body: {
          options: null,
          quotes: {
            timestamp: new Date().toISOString(),
            blobKey: 'mock-latest',
            latestQuotes: symbolQuote
              ? { [symbol]: symbolQuote }
              : {},
            historyCount: 0,
            history: [],
          },
        },
      };
    }

    if (action === 'get' && store === 'option-positions-history' && key) {
      const series = loadMock('_option_position_history') as
        | { timestamp: string }[]
        | null;
      if (series && Array.isArray(series)) {
        const match = series.find(s => {
          const k = s.timestamp.replace(/:/g, '-').replace(/\..*$/, '').replace(/\+.*$/, '');
          return k === key;
        });
        if (match) return { status: 200, body: { store, key, value: match } };
      }
      return { status: 200, body: { store, key, value: null } };
    }

    return { status: 200, body: { store, count: 0, keys: [] } };
  }

  // Alert Slack (fire and forget)
  if (fn === 'alert-slack') {
    return { status: 200, body: { ok: true, message: 'Mock alert sent' } };
  }

  // CoinGecko market
  if (fn === 'coingecko-market') {
    return {
      status: 200,
      body: [{
        id: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        current_price: 70885.88,
        market_cap: 1400000000000,
        total_volume: 35000000000,
        price_change_24h: 1250.50,
        price_change_percentage_24h: 1.8,
        high_24h: 71500,
        low_24h: 69200,
        last_updated: new Date().toISOString(),
      }],
    };
  }

  // Polygon / CoinDesk news
  if (fn === 'polygon-news' || fn === 'coindesk-news') {
    return {
      status: 200,
      body: {
        results: [
          {
            id: 'mock-news-1',
            title: 'Bitcoin Surges Past $70K on Institutional Demand',
            author: 'Mock Reporter',
            published_utc: new Date().toISOString(),
            article_url: 'https://example.com/mock-news',
            image_url: null,
            description: 'Mock news article for local development.',
            tickers: ['BTC'],
            publisher: { name: 'Mock News', logo_url: null, favicon_url: null },
          },
        ],
        count: 1,
      },
    };
  }

  // Finnhub news
  if (fn === 'finnhub-news') {
    return {
      status: 200,
      body: {
        results: [
          {
            id: 'mock-finnhub-1',
            title: 'Fed Signals Steady Rates Through Q3, Markets React Positively',
            author: 'Mock Analyst',
            published_utc: new Date().toISOString(),
            article_url: 'https://example.com/mock-finnhub-news',
            image_url: null,
            description: 'Mock Finnhub news article for local development.',
            tickers: ['SPY', 'QQQ'],
            publisher: { name: 'Finnhub Mock', logo_url: null, favicon_url: null },
          },
        ],
        count: 1,
      },
    };
  }

  // Perplexity news
  if (fn === 'perplexity-news') {
    const ticker = params.get('ticker') ?? 'IWN';
    return {
      status: 200,
      body: {
        articles: [
          {
            title: `${ticker} Shows Strong Momentum Amid Sector Rotation`,
            date: new Date().toISOString().split('T')[0],
            summary: `Mock analysis: ${ticker} has seen increased institutional interest driven by value rotation trends.`,
            impact: 'positive',
            source: 'Mock Perplexity',
          },
          {
            title: `${ticker} Volatility Remains Elevated Ahead of Earnings Season`,
            date: new Date().toISOString().split('T')[0],
            summary: `Options implied volatility for ${ticker} sits above the 75th percentile, suggesting caution.`,
            impact: 'neutral',
            source: 'Mock Perplexity',
          },
        ],
        citations: ['https://example.com/mock-citation-1'],
        ticker,
      },
    };
  }

  // Plaid link
  if (fn === 'plaid-link') {
    const action = params.get('action');
    if (action === 'create-link-token') {
      return { status: 200, body: { linkToken: 'mock-link-token-001' } };
    }
    if (action === 'status') {
      return { status: 200, body: { connected: false, institution: null } };
    }
    if (action === 'holdings') {
      return { status: 200, body: { positions: [], accounts: [] } };
    }
    return { status: 200, body: {} };
  }

  // Deribit DVOL
  if (fn === 'deribit-dvol') {
    return {
      status: 200,
      body: { dvol: 55.2, timestamp: new Date().toISOString() },
    };
  }

  // Enriched snapshot — try live data from prod with mock option overlay,
  // fall back to local mock fixtures + production enrichSnapshot function.
  if (fn === 'enriched-snapshot') {
    const live = await fetchLiveSnapshot();

    if (live) {
      // Live path: use prod data, overlay mock option positions/orders
      const livePortfolio = live.portfolio as Record<string, unknown>;

      const mockOptions = [
        {
          chain_symbol: 'SNDK', symbol: 'SNDK 05/08/2026 $1200 C', option_type: 'call',
          strike: 1200, strike_price: '1200.0000', expiration: '2026-05-08', expiration_date: '2026-05-08',
          dte: 23, quantity: 2, position_type: 'long', avg_price: 4.85, mark_price: 6.10, multiplier: 100,
          cost_basis: 970.00, current_value: 1220.00, unrealized_pl: 250.00, unrealized_pl_pct: 25.77,
          underlying_price: 952.50, break_even: 1204.85,
          greeks: { delta: 0.085, gamma: 0.0004, theta: -0.92, vega: 1.45, rho: 0.08, iv: 0.58 },
          expected_pl: { theta_daily: -1.84, '+5%': 820.00, '-5%': -380.00 }, chance_of_profit: 0.12,
        },
        {
          chain_symbol: 'IWN', symbol: 'IWN 05/15/2026 $185 P', option_type: 'put',
          strike: 185, strike_price: '185.0000', expiration: '2026-05-15', expiration_date: '2026-05-15',
          dte: 30, quantity: 5, position_type: 'long', avg_price: 1.45, mark_price: 1.25, multiplier: 100,
          cost_basis: 725.00, current_value: 625.00, unrealized_pl: -100.00, unrealized_pl_pct: -13.79,
          underlying_price: 200.85, break_even: 183.55,
          greeks: { delta: -0.155, gamma: 0.0125, theta: -0.032, vega: 0.115, rho: -0.025, iv: 0.215 },
          expected_pl: { theta_daily: -0.16, '+5%': -420.00, '-5%': 380.00 }, chance_of_profit: 0.18,
        },
        {
          chain_symbol: 'SNDK', symbol: 'SNDK 04/17/2026 $7.70 P', option_type: 'put',
          strike: 7.70, strike_price: '7.7000', expiration: '2026-04-17', expiration_date: '2026-04-17',
          dte: 2, quantity: 10, position_type: 'long', avg_price: 0.01, mark_price: 0.02, multiplier: 100,
          cost_basis: 10.00, current_value: 20.00, unrealized_pl: 10.00, unrealized_pl_pct: 100.00,
          underlying_price: 952.50, break_even: 7.69,
          greeks: { delta: -0.0001, gamma: 0.00001, theta: -0.005, vega: 0.0005, rho: -0.00001, iv: 2.10 },
          expected_pl: { theta_daily: -0.05, '+5%': -10.00, '-5%': -10.00 }, chance_of_profit: 0.0,
        },
      ];

      const mockOpenOptionOrders = [
        {
          order_id: 'mock-opt-order-001', chain_symbol: 'SNDK', direction: 'debit', state: 'queued',
          quantity: 3, price: 5.20, processed_premium: null, order_type: 'limit', opening_strategy: 'long_call',
          created_at: '2026-04-15T14:30:00Z', updated_at: '2026-04-15T14:30:00Z',
          legs: [{ chain_symbol: 'SNDK', strike_price: '1200.0000', expiration_date: '2026-05-08', option_type: 'call', side: 'BUY', position_effect: 'open' }],
        },
        {
          order_id: 'mock-opt-order-002', chain_symbol: 'IWN', direction: 'debit', state: 'queued',
          quantity: 10, price: 1.10, processed_premium: null, order_type: 'limit', opening_strategy: 'long_put',
          created_at: '2026-04-15T15:00:00Z', updated_at: '2026-04-15T15:00:00Z',
          legs: [{ chain_symbol: 'IWN', strike_price: '185.0000', expiration_date: '2026-05-15', option_type: 'put', side: 'BUY', position_effect: 'open' }],
        },
      ];

      const mockRecentOptionOrders = [
        {
          order_id: 'mock-opt-filled-001', chain_symbol: 'SNDK', direction: 'debit', state: 'filled',
          quantity: 2, price: 4.85, processed_premium: 970.00, order_type: 'limit', opening_strategy: 'long_call',
          created_at: '2026-04-10T10:15:00Z', updated_at: '2026-04-10T10:15:05Z',
          legs: [{ chain_symbol: 'SNDK', strike_price: '1200.0000', expiration_date: '2026-05-08', option_type: 'call', side: 'BUY', position_effect: 'open' }],
        },
        {
          order_id: 'mock-opt-filled-002', chain_symbol: 'IWN', direction: 'debit', state: 'filled',
          quantity: 5, price: 1.45, processed_premium: 725.00, order_type: 'limit', opening_strategy: 'long_put',
          created_at: '2026-04-08T11:30:00Z', updated_at: '2026-04-08T11:30:03Z',
          legs: [{ chain_symbol: 'IWN', strike_price: '185.0000', expiration_date: '2026-05-15', option_type: 'put', side: 'BUY', position_effect: 'open' }],
        },
        {
          order_id: 'mock-opt-filled-003', chain_symbol: 'SNDK', direction: 'debit', state: 'filled',
          quantity: 10, price: 0.01, processed_premium: 10.00, order_type: 'limit', opening_strategy: 'long_put',
          created_at: '2026-04-14T09:45:00Z', updated_at: '2026-04-14T09:45:02Z',
          legs: [{ chain_symbol: 'SNDK', strike_price: '7.7000', expiration_date: '2026-04-17', option_type: 'put', side: 'BUY', position_effect: 'open' }],
        },
      ];

      const liveOptions = (livePortfolio.options as unknown[]) ?? [];
      const liveOpenOptOrders = (livePortfolio.open_option_orders as unknown[]) ?? [];
      const liveRecentOptOrders = (live.recent_option_orders as unknown[]) ?? [];

      const mergedOptions = [...liveOptions, ...mockOptions];
      const mergedOpenOptOrders = [...liveOpenOptOrders, ...mockOpenOptionOrders];
      const mergedRecentOptOrders = [...liveRecentOptOrders, ...mockRecentOptionOrders];

      const optionsMV = mockOptions.reduce((s, o) => s + o.current_value, 0);
      const optionsSummary = {
        count: mergedOptions.length,
        total_cost_basis: mockOptions.reduce((s, o) => s + o.cost_basis, 0),
        total_current_value: optionsMV,
        total_unrealized_pl: mockOptions.reduce((s, o) => s + o.unrealized_pl, 0),
        total_theta_daily: mockOptions.reduce((s, o) => s + o.expected_pl.theta_daily, 0),
      };

      return {
        status: 200,
        body: {
          ...live,
          recent_option_orders: mergedRecentOptOrders,
          portfolio: {
            ...livePortfolio,
            options_market_value: (livePortfolio.options_market_value as number ?? 0) + optionsMV,
            market_value: (livePortfolio.market_value as number ?? 0) + optionsMV,
            open_option_orders: mergedOpenOptOrders,
            options: mergedOptions,
            options_summary: optionsSummary,
          },
        },
      };
    }

    // Fallback: use local mock fixtures + production enrichSnapshot
    const raw = buildRawSnapshot();
    if (!raw) return null;
    return { status: 200, body: enrichSnapshot(raw) };
  }

  // Market Depth — options contracts with greeks, depth ladder, theta decay,
  // and the IV surfaces. Served straight from the production function.
  if (fn === 'market-depth') {
    return { status: 200, body: buildMarketDepth() };
  }

  return null;
}

type Req = { url?: string };
type Res = {
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};
type NextFn = () => void;

async function mockMiddleware(req: Req, res: Res, next: NextFn) {
  if (!req.url?.startsWith('/.netlify/functions/')) {
    return next();
  }
  const url = new URL(req.url, 'http://localhost');
  const params = url.searchParams;
  const result = await getMockResponse(url.pathname, params);

  if (!result) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Mock not found for ' + url.pathname }));
    return;
  }
  if (url.pathname.includes('stop-events-sse') && params.get('format') === 'sse') {
    const { snapshotToSse } = require_('./netlify/functions/lib/stopEvents.cjs');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(snapshotToSse(result.body));
    return;
  }
  res.writeHead(result.status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(result.body));
}

export function mockApiPlugin(): Plugin {
  return {
    name: 'mock-netlify-functions',
    configureServer(server) {
      server.middlewares.use(mockMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mockMiddleware);
    },
  };
}
