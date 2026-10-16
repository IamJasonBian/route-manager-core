import type React from 'react';
import { render, act, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TickerPnLPage from './TickerPnLPage';
import { findDarkModeViolations, describeViolations } from '../testUtils/darkMode';
import type { EnrichedSnapshot, SnapshotOrder, SnapshotOptionOrder } from '../services/robinhoodService';

// jsdom has no layout engine — render charts into a fixed-size box
jest.mock('recharts', () => {
  const Original = jest.requireActual('recharts');
  const { cloneElement } = jest.requireActual('react');
  return {
    ...Original,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) => (
      <div data-testid="responsive-container">{cloneElement(children, { width: 600, height: 300 })}</div>
    ),
  };
});

const mockSnapshot = jest.fn();
const mockDbOrders = jest.fn();
const mockSeries = jest.fn();

jest.mock('../services/robinhoodService', () => {
  const actual = jest.requireActual('../services/robinhoodService');
  return {
    ...actual,
    getEnrichedSnapshot: (...args: unknown[]) => mockSnapshot(...args),
    getDbOrdersForSymbol: (...args: unknown[]) => mockDbOrders(...args),
  };
});

const mockQuotes = jest.fn();

jest.mock('../services/twelveDataService', () => ({
  getTimeSeries: (...args: unknown[]) => mockSeries(...args),
  getQuotes: (...args: unknown[]) => mockQuotes(...args),
}));

const mockFillContext = jest.fn();
const mockOptionSnapshots = jest.fn();
const mockSurface = jest.fn();
const mockRefresh = jest.fn();

jest.mock('../services/marketContextService', () => ({
  getFillContext: (...args: unknown[]) => mockFillContext(...args),
  getOptionSnapshots: (...args: unknown[]) => mockOptionSnapshots(...args),
  getVolSurface: (...args: unknown[]) => mockSurface(...args),
  triggerSnapshotRefresh: (...args: unknown[]) => mockRefresh(...args),
}));

let n = 0;
const fill = (side: 'BUY' | 'SELL', qty: number, price: number, at: string, extra: Partial<SnapshotOrder> = {}): SnapshotOrder => ({
  order_id: `o${++n}`, symbol: 'NBIS', side, order_type: 'limit', trigger: 'immediate', state: 'filled',
  quantity: qty, limit_price: price, stop_price: null, filled_quantity: qty, average_price: price,
  created_at: at, updated_at: at, ...extra,
});

const HISTORY: SnapshotOrder[] = [
  fill('BUY', 35, 225.0, '2026-10-05T14:00:00Z'),
  fill('BUY', 10, 205.0, '2026-10-10T15:00:00Z'),
  fill('SELL', 35, 195.14, '2026-10-12T15:00:00Z', { order_type: 'market', trigger: 'stop' }),
  fill('BUY', 75, 207.11, '2026-10-13T14:00:00Z', { order_type: 'market' }),
  fill('BUY', 45, 186.6, '2026-10-14T13:35:00Z'),
  fill('SELL', 50, 180.11, '2026-10-14T14:00:00Z'),
  fill('BUY', 50, 170.0, '2026-10-14T15:00:00Z'),
  fill('SELL', 20, 175.01, '2026-10-14T16:00:00Z', { order_type: 'market', trigger: 'stop' }),
  fill('BUY', 1, 178.5, '2026-10-14T17:00:00Z'),
  fill('BUY', 1, 178.3, '2026-10-14T18:00:00Z'),
  fill('SELL', 110, 185.0, '2026-10-15T15:00:00Z'),
];

const QUEUED_CALL: SnapshotOptionOrder = {
  order_id: 'opt1', chain_symbol: 'NBIS', state: 'queued', quantity: 1, price: 11, direction: 'debit',
  created_at: '2026-10-16T08:15:00Z', updated_at: '2026-10-16T08:15:00Z',
  legs: [{ chain_symbol: 'NBIS', side: 'BUY', position_effect: 'open', option_type: 'call', strike_price: '220.0000', expiration_date: '2026-11-27' }],
};

const SERIES = [
  ['2026-10-02', 228], ['2026-10-05', 224], ['2026-10-06', 219], ['2026-10-07', 214], ['2026-10-08', 210],
  ['2026-10-09', 206], ['2026-10-12', 196], ['2026-10-13', 205], ['2026-10-14', 179], ['2026-10-15', 184],
].map(([date, price]) => ({ date: date as string, timestamp: Date.parse(date as string), price: price as number }));

const EMPTY_PNL = { total_realized_pnl: 0, total_buy_volume: 0, total_sell_volume: 0, filled_count: 0, symbols: [] };

function snapshot(over: Partial<EnrichedSnapshot> = {}): EnrichedSnapshot {
  return {
    timestamp: '2026-10-16T12:00:00',
    market_data: null,
    order_book: [],
    recent_orders: [],
    recent_option_orders: [],
    recent_pnl: EMPTY_PNL,
    option_pnl: EMPTY_PNL,
    combined_7d_pnl: 0,
    pnl_by_period: {} as EnrichedSnapshot['pnl_by_period'],
    portfolio: {
      cash: { cash: 50000, cash_available_for_withdrawal: 50000, buying_power: 50000, tradeable_cash: 50000 },
      equity: 120000, rh_market_value: null, market_value: 70000, stock_market_value: 70000, options_market_value: 0,
      margin_used: 0, reconciliation: { rh_equity: 120000, computed_equity: 120000 },
      positions: [{ symbol: 'NBIS', quantity: 2, avg_buy_price: 188.91, current_price: 190.5, equity: 381, profit_loss: 3.18, profit_loss_pct: 0.84 }],
      open_orders: [], open_option_orders: [], options: [], options_summary: null, total_pl: 0, total_pl_pct: 0,
    },
    ...over,
  };
}

const dbOrders = (over: Record<string, unknown> = {}) => ({
  open_orders: [], open_option_orders: [QUEUED_CALL], historical_orders: HISTORY, historical_option_orders: [],
  untracked_orders: [], untracked_option_orders: [], truncated: false, ...over,
});

async function renderPage(path = '/ticker/NBIS') {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/ticker/:symbol" element={<TickerPnLPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await waitFor(() => expect(result!.container.querySelector('.animate-pulse')).toBeNull());
  return result!;
}

// NBBO one cent either side of each fill: buys lift the ask, sells hit the bid
function quotesAtTouch(_symbol: string, times: string[]) {
  const byTime = new Map(HISTORY.map(o => [new Date(o.updated_at!).toISOString(), o]));
  return Promise.resolve(times.map(t => {
    const o = byTime.get(t)!;
    const px = o.average_price!;
    const [bid, ask] = o.side === 'BUY' ? [px - 0.02, px] : [px, px + 0.02];
    return {
      t, session: 'regular', feed: 'sip', error: null,
      quote: { bid, ask, bid_size: 100, ask_size: 200, bid_exchange: 'Q', ask_exchange: 'P', time: t, age_ms: 250 },
      bar: { time: t, open: px, high: px + 0.5, low: px - 0.5, close: px, volume: 1000, vwap: px, trades: 10 },
    };
  }));
}

const SURFACE = {
  ok: true, symbol: 'NBIS', cached: false,
  meta: { source: 'alpaca', timestamp: '2026-10-16T08:58:53.808Z', quoteCount: 1337 },
  surface: { underlying: 'NBIS', spot: 190, strikes: [150, 190, 230], dtes: [8, 43], iv: [[0.95, 0.9, 0.92], [0.9, 0.85, 0.88]], source: 'alpaca' },
};

describe('TickerPnLPage', () => {
  beforeEach(() => {
    mockSnapshot.mockResolvedValue(snapshot());
    mockDbOrders.mockResolvedValue(dbOrders());
    mockSeries.mockResolvedValue(SERIES);
    mockQuotes.mockResolvedValue({});
    mockFillContext.mockImplementation(quotesAtTouch);
    mockSurface.mockResolvedValue(SURFACE);
    mockOptionSnapshots.mockResolvedValue([{
      occ: 'NBIS261127C00220000', found: true, bid: 10.06, ask: 12.17, bid_size: 291, ask_size: 291,
      iv: 0.885, greeks: { delta: 0.3468 },
    }]);
    mockRefresh.mockResolvedValue({ ok: false, error: 'auth box unreachable' });
  });

  it('shows realized, unrealized and total P&L from the DB fills', async () => {
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    expect(mockDbOrders).toHaveBeenCalledWith('NBIS');
    expect(text).toContain('NBIS P&L & risk');
    expect(text).toContain('−$2,648.62'); // realized
    expect(text).toContain('+$3.17');     // 2 sh × (190.50 − 188.91)
    expect(text).toContain('−$2,645.45'); // total
    expect(text).toContain('0W / 4L');
  });

  it('lists the queued option order with its premium and breakeven', async () => {
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain('$220 Call 11/27');
    expect(text).toContain('$231.00');
    expect(text).toContain('option premium at risk $1,100.00');
  });

  it('measures every fill against the NBBO at execution', async () => {
    const { container } = await renderPage();
    await waitFor(() => expect(container.textContent).toContain('11 of 11 fills have a quote'));
    const text = container.textContent ?? '';
    expect(mockFillContext).toHaveBeenCalledWith('NBIS', expect.arrayContaining(['2026-10-15T15:00:00.000Z']));
    // Every fill at the touch → paid half the 2¢ spread vs mid
    expect(text).toContain('11 at touch');
    expect(text).toContain('$185.00 × 100'); // the Oct 15 sell hit a $185.00 bid
    expect(text).toMatch(/Cost vs mid\+\$\d/);
  });

  it('shows the live quote, IV and implied move for a queued option', async () => {
    const { container } = await renderPage();
    await waitFor(() => expect(container.textContent).toContain('$10.06 × 291'));
    const text = container.textContent ?? '';
    expect(mockOptionSnapshots).toHaveBeenCalledWith(['NBIS261127C00220000']);
    expect(text).toContain('$12.17 × 291');
    expect(text).toContain('88.5%');
    expect(text).toContain('0.35');
    expect(text).toMatch(/±\d+\.\d%/); // 1σ move to expiry
  });

  it('calibrates realized against implied vol', async () => {
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain('NBIS volatility calibration');
    expect(text).toContain('alpaca surface');
    expect(text).toMatch(/Implied ATM 30D\d+\.\d%alpaca option quotes/);
    expect(text).toContain('VaR breaches');
  });

  it('reports a failed broker sync', async () => {
    const { container, getByText } = await renderPage();
    await act(async () => { fireEvent.click(getByText('Sync now')); });
    await waitFor(() => expect(container.textContent).toContain('Sync: auth box unreachable'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('flags a short sample instead of hiding Sharpe', async () => {
    const { container } = await renderPage();
    expect(container.textContent).toMatch(/Sharpe \(ann\.\)-?\d+\.\d{2}\d+ days, low sample/);
  });

  it('falls back to the snapshot when the DB has no orders for the ticker', async () => {
    mockDbOrders.mockResolvedValue(dbOrders({ open_option_orders: [], historical_orders: [] }));
    mockSnapshot.mockResolvedValue(snapshot({ recent_orders: HISTORY.slice(0, 2) }));
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain('blob snapshot');
    // 45 sh bought in the snapshot window vs 2 held at Robinhood
    expect(text).toContain('The fill history leaves 45 shares but Robinhood reports 2');
  });

  it('marks the position at the freshest price source', async () => {
    // A Twelve Data quote newer than the Robinhood snapshot wins
    mockQuotes.mockResolvedValue({ NBIS: { symbol: 'NBIS', price: 200, timestamp: Date.parse('2026-10-16T13:00:00Z') } });
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain('Last $200.00');
    expect(text).toContain('Twelve Data');
    expect(text).toContain('+$22.17'); // 2 sh × (200 − 188.91)
  });

  it('notes missing price history without failing the page', async () => {
    mockSeries.mockRejectedValue(new Error('TwelveData quota'));
    const { container } = await renderPage();
    expect(container.textContent).toContain('Price history is unavailable (TwelveData quota)');
    expect(container.textContent).toContain('−$2,648.62');
  });

  it('has no light-only classes missing dark: counterparts', async () => {
    document.documentElement.classList.add('dark');
    try {
      const { container } = await renderPage();
      const violations = findDarkModeViolations(container);
      if (violations.length) throw new Error(`Found ${violations.length} dark mode violations:\n${describeViolations(violations)}`);
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
