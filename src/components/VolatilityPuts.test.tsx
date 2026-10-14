import React from 'react';
import { render, screen } from '@testing-library/react';
import VolatilityPuts from './VolatilityPuts';
import type { StopRiskSnapshot } from '../services/stopEventStream';

jest.mock('recharts', () => {
  const Original = jest.requireActual('recharts');
  return {
    ...Original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
    BarChart: ({ children }: { children: React.ReactNode }) => <svg>{children}</svg>,
    Bar: () => null,
    ComposedChart: ({ children }: { children: React.ReactNode }) => <svg>{children}</svg>,
    Line: () => null,
    Scatter: ({ data }: { data: unknown[] }) => <g data-testid="scatter" data-count={data.length} />,
    ReferenceLine: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
  };
});

jest.mock('../services/twelveDataService', () => ({
  getIntradaySeries: () => Promise.resolve([]),
}));

jest.mock('../hooks/useStopEventStream', () => ({
  useStopEventStream: () => ({
    snapshot: { as_of: '', names: [], events: [] },
    ticks: {},
    connected: false,
    error: null,
  }),
}));

const SNAPSHOT: StopRiskSnapshot = {
  as_of: '2026-10-14T00:00:00Z',
  names: [
    {
      symbol: 'NBIS',
      quantity: 120.126,
      covered_qty: 35,
      uncovered_qty: 85.126,
      coverage_pct: 0.29,
      trail_percent: 6,
      coded_trail_percent: 6,
      stop_price: 194.96,
      last_trail_price: 195.36,
      mark: 208.8,
      avg_entry: 212.14,
      equity: 25082,
      profit_loss: -402,
      profit_loss_pct: -1.58,
      stop_id: 'stop-nbis',
      stop_type: 'market',
      stop_state: 'confirmed',
    },
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
      stop_id: 'stop-mu',
      stop_type: 'limit',
      stop_state: 'confirmed',
    },
  ],
  events: [
    {
      type: 'engine',
      id: 'o-1',
      code: 'order_filled',
      symbol: 'NBIS',
      side: 'BUY',
      status: 'filled',
      order_type: 'limit',
      price: 178.5,
      ts: '2026-10-14T22:39:30Z',
      message: 'BUY 1 NBIS limit @ 178.50',
    },
    {
      type: 'engine',
      id: 'o-2',
      code: 'order_queued',
      symbol: 'NBIS',
      side: 'SELL',
      status: 'queued',
      order_type: 'stop',
      price: 174.92,
      ts: '2026-10-14T22:30:02Z',
      message: 'SELL 20 NBIS stop @ 174.92',
    },
  ],
};

describe('VolatilityPuts', () => {
  it('renders MU/NBIS coverage, the engine event feed, and event tags on the price chart', () => {
    const ticks = { NBIS: [{ symbol: 'NBIS', price: 179, ts: '2026-10-14T22:40:00Z' }] };
    render(<VolatilityPuts snapshot={SNAPSHOT} ticks={ticks} connected focusSymbol="NBIS" />);
    expect(screen.getByTestId('coverage-NBIS').textContent).toMatch(/partial cover/);
    expect(screen.getByTestId('coverage-MU').textContent).toMatch(/covered/);
    expect(screen.getByTestId('sse-status').textContent).toMatch(/live/);
    expect(screen.getAllByTestId('live-event')[0].textContent).toMatch(/order_filled/);
    expect(screen.getByTestId('scatter').getAttribute('data-count')).toBe('2');
    expect(screen.getByRole('tab', { name: 'NBIS' }).getAttribute('aria-selected')).toBe('true');
  });
});
