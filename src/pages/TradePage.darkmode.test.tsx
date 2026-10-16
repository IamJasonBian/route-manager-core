/**
 * Dark mode regression tests for TradePage.
 *
 * Renders each major sub-component with mock data inside a `dark`-classed
 * document, then scans the rendered DOM for light-only Tailwind classes
 * (bg-white, bg-gray-*, text-gray-*, border-gray-*) that are NOT paired
 * with a `dark:` counterpart in the same element's className.
 */
import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TradePage from './TradePage';
import { findDarkModeViolations } from '../testUtils/darkMode';
import type {
  EnrichedSnapshot,
  EnrichedPortfolio,
  BotAction,
  StockPnLResult,
  OptionPnLResult,
} from '../services/robinhoodService';

// ── Mock recharts (jsdom has no canvas) ────────────────────────────
jest.mock('recharts', () => {
  const Original = jest.requireActual('recharts');
  return {
    ...Original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
    PieChart: ({ children }: { children: React.ReactNode }) => <svg>{children}</svg>,
    Pie: () => null,
    Cell: () => null,
    Tooltip: () => null,
    Legend: () => null,
  };
});

// ── Mock service calls ─────────────────────────────────────────────

const EMPTY_STOCK_PNL: StockPnLResult = {
  total_realized_pnl: 0,
  total_buy_volume: 0,
  total_sell_volume: 0,
  filled_count: 0,
  symbols: [],
};

const EMPTY_OPTION_PNL: OptionPnLResult = {
  total_realized_pnl: 0,
  total_buy_volume: 0,
  total_sell_volume: 0,
  filled_count: 0,
  symbols: [],
};

const MOCK_PORTFOLIO: EnrichedPortfolio = {
  cash: { cash: 10000, cash_available_for_withdrawal: 9000, buying_power: 15000, tradeable_cash: 10000 },
  equity: 50000,
  rh_market_value: 40000,
  market_value: 40000,
  stock_market_value: 30000,
  options_market_value: 10000,
  margin_used: 0,
  reconciliation: { rh_equity: 50000, computed_equity: 50000 },
  positions: [
    { symbol: 'AAPL', quantity: 10, avg_buy_price: 150, current_price: 170, equity: 1700, profit_loss: 200, profit_loss_pct: 13.3 },
    { symbol: 'TSLA', quantity: 5, avg_buy_price: 200, current_price: 210, equity: 1050, profit_loss: 50, profit_loss_pct: 5 },
  ],
  open_orders: [
    { order_id: 'o1', symbol: 'AAPL', side: 'BUY', order_type: 'limit', trigger: 'immediate', state: 'queued', quantity: 5, limit_price: 165, stop_price: null, created_at: '2026-04-07T10:00:00Z', updated_at: '2026-04-07T10:00:00Z' },
  ],
  open_option_orders: [
    { order_id: 'oo1', chain_symbol: 'AAPL', state: 'queued', quantity: 1, price: 3.5, direction: 'debit', created_at: '2026-04-07T10:00:00Z', updated_at: '2026-04-07T10:00:00Z', legs: [{ side: 'buy', option_type: 'call', strike: 180, expiration: '2026-05-16', chain_symbol: 'AAPL' }] },
  ],
  options: [
    {
      chain_symbol: 'AAPL', option_type: 'call', strike: 175, expiration: '2026-05-16', dte: 39,
      quantity: 2, cost_basis: 600, current_value: 850, unrealized_pl: 250, unrealized_pl_pct: 41.6,
      greeks: { delta: 0.55, gamma: 0.03, theta: -0.12, vega: 0.25, rho: 0.01, iv: 0.32 },
      recommended_action: { action: 'HOLD', reasons: ['Still in profit'] },
    },
  ],
  options_summary: { count: 1, total_cost_basis: 600, total_current_value: 850, total_unrealized_pl: 250, total_theta_daily: -0.12 },
  total_pl: 450,
  total_pl_pct: 3.2,
};

const MOCK_SNAPSHOT: EnrichedSnapshot = {
  timestamp: '2026-04-07T15:30:00Z',
  market_data: null,
  order_book: [
    { order_id: 'ob1', symbol: 'AAPL', side: 'BUY', order_type: 'limit', trigger: 'immediate', state: 'filled', quantity: 10, limit_price: 150, stop_price: null, created_at: '2026-04-01T09:00:00Z', updated_at: '2026-04-01T09:05:00Z', filled_quantity: 10, average_price: 149.5 },
  ],
  recent_orders: [
    { order_id: 'ro1', symbol: 'TSLA', side: 'SELL', order_type: 'market', trigger: 'immediate', state: 'filled', quantity: 3, limit_price: 210, stop_price: null, created_at: '2026-04-06T14:00:00Z', updated_at: '2026-04-06T14:01:00Z', filled_quantity: 3, average_price: 210 },
  ],
  recent_option_orders: [
    { order_id: 'roo1', chain_symbol: 'AAPL', state: 'filled', quantity: 1, price: 3.2, direction: 'debit', created_at: '2026-04-06T13:00:00Z', updated_at: '2026-04-06T13:01:00Z', legs: [{ side: 'buy', option_type: 'put', strike: 170, expiration: '2026-05-16', chain_symbol: 'AAPL' }] },
  ],
  recent_pnl: { ...EMPTY_STOCK_PNL, total_realized_pnl: 180, symbols: [{ symbol: 'TSLA', realized_pnl: 180, total_bought: 600, total_sold: 780, buy_count: 1, sell_count: 1, shares_held: 2, cost_basis: 400 }] },
  option_pnl: EMPTY_OPTION_PNL,
  combined_7d_pnl: 180,
  pnl_by_period: {
    '1W': { stock: EMPTY_STOCK_PNL, option: EMPTY_OPTION_PNL },
    '1M': { stock: EMPTY_STOCK_PNL, option: EMPTY_OPTION_PNL },
    '3M': { stock: EMPTY_STOCK_PNL, option: EMPTY_OPTION_PNL },
    '6M': { stock: EMPTY_STOCK_PNL, option: EMPTY_OPTION_PNL },
    '1Y': { stock: EMPTY_STOCK_PNL, option: EMPTY_OPTION_PNL },
    '5Y': { stock: EMPTY_STOCK_PNL, option: EMPTY_OPTION_PNL },
  },
  portfolio: MOCK_PORTFOLIO,
};

const MOCK_BOT_ACTIONS: BotAction[] = [
  { id: 'ba1', timestamp: '2026-04-07T14:00:00Z', type: 'BUY_ORDER', status: 'executed', symbol: 'AAPL', quantity: 5, price: 170, message: 'Bought AAPL' },
  { id: 'ba2', timestamp: '2026-04-07T13:00:00Z', type: 'ANALYSIS', status: 'completed', message: 'Daily analysis', dryRun: true },
];

const mockGetEnrichedSnapshot = jest.fn();
const mockGetBotActions = jest.fn();

jest.mock('../services/robinhoodService', () => {
  const actual = jest.requireActual('../services/robinhoodService');
  return {
    ...actual,
    getEnrichedSnapshot: (...args: unknown[]) => mockGetEnrichedSnapshot(...args),
    getBotActions: (...args: unknown[]) => mockGetBotActions(...args),
  };
});

// ── Tests ──────────────────────────────────────────────────────────

describe('TradePage dark mode', () => {
  beforeEach(() => {
    document.documentElement.classList.add('dark');
    mockGetEnrichedSnapshot.mockResolvedValue(MOCK_SNAPSHOT);
    mockGetBotActions.mockResolvedValue({ actions: MOCK_BOT_ACTIONS });
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  async function renderTradePage() {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <MemoryRouter>
          <TradePage />
        </MemoryRouter>,
      );
    });
    // Wait for data to load and state to settle
    await waitFor(() => {
      expect(result!.container.querySelector('.animate-pulse')).toBeNull();
    });
    return result!;
  }

  it('renders without crashing in dark mode', async () => {
    const { container } = await renderTradePage();
    expect(container.querySelector('.max-w-7xl')).toBeTruthy();
  });

  it('has no light-only classes missing dark: counterparts', async () => {
    const { container } = await renderTradePage();
    const violations = findDarkModeViolations(container);

    if (violations.length > 0) {
      const summary = violations
        .slice(0, 20)
        .map((v) => `  <${v.tag}> has "${v.lightClass}" without dark: pair\n    className="${v.className.slice(0, 120)}"`)
        .join('\n');
      throw new Error(`Found ${violations.length} dark mode violations:\n${summary}`);
    }
  });

  it('key containers use dark backgrounds', async () => {
    const { container } = await renderTradePage();

    const cards = container.querySelectorAll('.bg-white');
    for (const card of cards) {
      const cn = card.className;
      expect(cn).toMatch(/dark:(bg-zinc|bg-gray)-/);
    }
  });

  it('table headers have dark backgrounds', async () => {
    const { container } = await renderTradePage();

    const theads = container.querySelectorAll('thead');
    for (const thead of theads) {
      const cn = thead.className;
      if (cn.includes('bg-gray-50')) {
        expect(cn).toMatch(/dark:bg-zinc-800/);
      }
    }
  });

  it('text colors have dark variants', async () => {
    const { container } = await renderTradePage();

    const darkTextElements = container.querySelectorAll('[class*="text-gray-900"]');
    for (const el of darkTextElements) {
      const cn = typeof el.className === 'string' ? el.className : (el.className as SVGAnimatedString)?.baseVal ?? '';
      expect(cn).toMatch(/dark:text-gray-/);
    }

    const mediumTextElements = container.querySelectorAll('[class*="text-gray-700"]');
    for (const el of mediumTextElements) {
      const cn = typeof el.className === 'string' ? el.className : (el.className as SVGAnimatedString)?.baseVal ?? '';
      if (!cn) continue; // Skip SVG elements without class strings
      expect(cn).toMatch(/dark:text-gray-/);
    }
  });

  it('dividers have dark variants', async () => {
    const { container } = await renderTradePage();

    const dividers = container.querySelectorAll('[class*="divide-gray"]');
    for (const el of dividers) {
      expect(el.className).toMatch(/dark:divide-zinc-/);
    }
  });
});
