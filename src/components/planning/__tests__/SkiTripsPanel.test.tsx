import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { SkiTripsResponse } from '../../../services/api';

jest.mock('../../../services/api', () => ({
  __esModule: true,
  getSkiTrips: jest.fn(),
}));

import { getSkiTrips } from '../../../services/api';
import { SkiTripsPanel } from '../SkiTripsPanel';

const mockResponse: SkiTripsResponse = {
  generatedAt: '2026-04-23',
  seasonTarget: '2026-2027',
  weekend: { depart: '2027-01-15', return: '2027-01-17', label: 'Fri 2027-01-15 → Sun 2027-01-17' },
  priceBasis: 'test',
  origin: { city: 'New York City', hubs: ['JFK'] },
  trips: [
    {
      id: 'trip-hunter',
      resort: 'Hunter Mountain',
      state: 'NY',
      epicPass: true,
      heroAccent: 'emerald',
      mountainStats: { verticalFt: 1600, trails: 67, lifts: 13 },
      transport: {
        mode: 'bus',
        outbound: {
          operator: 'OvR Ski Bus',
          from: { code: 'NYC', name: 'Union Square' },
          to: { code: 'HUN', name: 'Hunter Mountain' },
          depart: '2027-01-15T18:00',
          arrive: '2027-01-15T21:30',
          durationMin: 210,
          priceUsd: 115,
        },
        returnOptions: [
          {
            id: 'hunter-ret-standard',
            label: 'Standard return',
            operator: 'OvR Ski Bus',
            from: { code: 'HUN', name: 'Hunter' },
            to: { code: 'NYC', name: 'Union Square' },
            depart: '2027-01-17T17:00',
            arrive: '2027-01-17T20:15',
            durationMin: 195,
            priceUsd: 115,
            recommended: true,
            note: 'rec',
          },
          {
            id: 'hunter-ret-late',
            label: 'Après-ski',
            operator: 'OvR Ski Bus',
            from: { code: 'HUN', name: 'Hunter' },
            to: { code: 'NYC', name: 'Union Square' },
            depart: '2027-01-17T18:30',
            arrive: '2027-01-17T21:55',
            durationMin: 205,
            priceUsd: 125,
            recommended: false,
            note: 'late',
          },
        ],
        groundTransferMin: 0,
        groundTransferNote: 'Direct',
      },
      totals: { transportPriceUsdMin: 230, transportPriceUsdMax: 240, transitTimeMinOneWay: 210 },
      notes: 'Cheapest option',
      sources: [],
    },
    {
      id: 'trip-stowe',
      resort: 'Stowe Mountain Resort',
      state: 'VT',
      epicPass: true,
      heroAccent: 'indigo',
      mountainStats: { verticalFt: 2360, trails: 116, lifts: 13 },
      transport: {
        mode: 'flight',
        outbound: {
          operator: 'Delta',
          number: 'DL 4821',
          from: { code: 'JFK', name: 'JFK' },
          to: { code: 'BTV', name: 'Burlington' },
          depart: '2027-01-15T17:25',
          arrive: '2027-01-15T19:00',
          durationMin: 95,
          priceUsd: 219,
        },
        returnOptions: [
          {
            id: 'stowe-ret-dl4824',
            label: 'Delta evening',
            operator: 'Delta',
            number: 'DL 4824',
            from: { code: 'BTV', name: 'Burlington' },
            to: { code: 'JFK', name: 'JFK' },
            depart: '2027-01-17T19:40',
            arrive: '2027-01-17T21:10',
            durationMin: 90,
            priceUsd: 198,
            recommended: true,
            note: 'rec',
          },
          {
            id: 'stowe-ret-b6',
            label: 'JetBlue via BOS',
            operator: 'JetBlue',
            number: 'B6 1842',
            from: { code: 'BTV', name: 'Burlington' },
            to: { code: 'LGA', name: 'LaGuardia' },
            depart: '2027-01-17T17:05',
            arrive: '2027-01-17T21:35',
            durationMin: 270,
            priceUsd: 174,
            recommended: false,
            note: 'cheap',
          },
        ],
        groundTransferMin: 45,
        groundTransferNote: 'Rental car from BTV',
      },
      totals: { transportPriceUsdMin: 393, transportPriceUsdMax: 443, transitTimeMinOneWay: 140 },
      notes: 'Marquee VT resort',
      sources: [],
    },
  ],
};

describe('SkiTripsPanel', () => {
  beforeEach(() => {
    (getSkiTrips as jest.Mock).mockReset();
  });

  it('renders both resorts and selects the recommended return option by default', async () => {
    (getSkiTrips as jest.Mock).mockResolvedValue(mockResponse);
    render(<SkiTripsPanel />);

    expect(await screen.findByText('Hunter Mountain')).toBeInTheDocument();
    expect(screen.getByText('Stowe Mountain Resort')).toBeInTheDocument();

    // Default selection should be the recommended: true options
    const hunterRecommended = screen.getByRole('radio', { name: /Standard return/i });
    expect(hunterRecommended).toHaveAttribute('aria-checked', 'true');

    const stoweRecommended = screen.getByRole('radio', { name: /Delta evening/i });
    expect(stoweRecommended).toHaveAttribute('aria-checked', 'true');

    // Hunter: outbound 115 + recommended return 115 = 230
    expect(screen.getByText('$230')).toBeInTheDocument();
    // Stowe: outbound 219 + recommended return 198 = 417
    expect(screen.getByText('$417')).toBeInTheDocument();
  });

  it('updates the total when a different return option is selected', async () => {
    (getSkiTrips as jest.Mock).mockResolvedValue(mockResponse);
    render(<SkiTripsPanel />);

    await screen.findByText('Hunter Mountain');

    // Switch Hunter to the Après-ski (late) option priced at 125
    const hunterLate = screen.getByRole('radio', { name: /Après-ski/i });
    fireEvent.click(hunterLate);

    await waitFor(() => {
      expect(hunterLate).toHaveAttribute('aria-checked', 'true');
    });

    // New Hunter total: 115 outbound + 125 return = 240
    expect(screen.getByText('$240')).toBeInTheDocument();
  });
});
