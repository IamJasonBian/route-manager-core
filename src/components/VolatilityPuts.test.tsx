import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import VolatilityPuts from './VolatilityPuts';
import { inDateRange, type StopRiskSnapshot } from '../services/stopEventStream';

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
  // The chart's 1D window is relative to now; pin it just after the fixture events.
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-14T23:00:00Z')));
  afterEach(() => jest.restoreAllMocks());

  it('renders MU/NBIS coverage, the engine event feed, and event tags on the price chart', () => {
    const ticks = { NBIS: [{ symbol: 'NBIS', price: 179, ts: '2026-10-14T22:40:00Z' }] };
    render(<VolatilityPuts snapshot={SNAPSHOT} ticks={ticks} connected focusSymbol="NBIS" />);
    expect(screen.getByTestId('coverage-NBIS').textContent).toMatch(/partial cover/);
    expect(screen.getByTestId('coverage-NBIS').id).toBe('coverage-NBIS');
    expect(screen.getByTestId('coverage-MU').textContent).toMatch(/covered/);
    expect(screen.getByTestId('sse-status').textContent).toMatch(/live/);
    expect(screen.getAllByTestId('live-event')[0].textContent).toMatch(/order_filled/);
    expect(screen.getByTestId('scatter').getAttribute('data-count')).toBe('2');
    expect(screen.getByRole('tab', { name: 'NBIS' }).getAttribute('aria-selected')).toBe('true');
  });

  it('date filter narrows both the event feed and the chart tags', () => {
    render(<VolatilityPuts snapshot={SNAPSHOT} ticks={{}} connected focusSymbol="NBIS" />);
    expect(screen.getAllByTestId('live-event')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-16' } });
    expect(screen.queryAllByTestId('live-event')).toHaveLength(0);
    expect(screen.getByText('No events in this date range')).toBeTruthy();
    expect(screen.getByTestId('scatter').getAttribute('data-count')).toBe('0');

    fireEvent.click(screen.getByText('Clear'));
    expect(screen.getAllByTestId('live-event')).toHaveLength(2);
  });

  it('inDateRange keeps events inside inclusive local-day bounds', () => {
    const at = (iso: string) => ({ type: 'engine', ts: iso });
    const local = (d: string, h: number) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).toISOString();
    const events = [at(local('2026-10-13', 23)), at(local('2026-10-14', 0)), at(local('2026-10-14', 23)), at(local('2026-10-15', 0)), { type: 'engine' }];
    expect(inDateRange(events, '2026-10-14', '2026-10-14')).toEqual([events[1], events[2]]);
    expect(inDateRange(events, '2026-10-15', '')).toEqual([events[3]]);
    expect(inDateRange(events, '', '')).toBe(events);
  });
});
