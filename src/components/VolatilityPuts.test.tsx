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
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
  };
});

jest.mock('../hooks/useStopEventStream', () => ({
  useStopEventStream: () => ({
    snapshot: { as_of: '', names: [], events: [] },
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
      type: 'risk',
      code: 'coverage_gap',
      symbol: 'NBIS',
      severity: 'critical',
      message: 'NBIS stop covers 35 of 120.126 shares (29%)',
    },
  ],
};

describe('VolatilityPuts', () => {
  it('renders MU/NBIS coverage and the live event feed', () => {
    render(<VolatilityPuts snapshot={SNAPSHOT} connected focusSymbol="NBIS" />);
    expect(screen.getByTestId('coverage-NBIS').textContent).toMatch(/partial cover/);
    expect(screen.getByTestId('coverage-MU').textContent).toMatch(/covered/);
    expect(screen.getByTestId('sse-status').textContent).toMatch(/live/);
    expect(screen.getAllByTestId('live-event')[0].textContent).toMatch(/coverage_gap/);
  });
});
