import {
  ALL_CARRIERS_KEY,
  filterByCarrier,
  getUniqueCarriers,
  lowestPricePerDate,
} from '../carrierPrices';
import { FlightPrice } from '../../services/api';

const offer = (date: string, price: number, carrier?: string): FlightPrice => ({
  date,
  price,
  ...(carrier ? { flightDetails: { carrier, flightNumber: `${carrier}100` } } : {}),
});

describe('carrierPrices', () => {
  describe('getUniqueCarriers', () => {
    it('returns sorted unique carrier codes', () => {
      const prices = [
        offer('2026-05-01', 200, 'DL'),
        offer('2026-05-01', 220, 'AA'),
        offer('2026-05-02', 190, 'DL'),
        offer('2026-05-03', 300, 'UA'),
      ];
      expect(getUniqueCarriers(prices)).toEqual(['AA', 'DL', 'UA']);
    });

    it('skips entries with no carrier info (e.g. legacy data)', () => {
      const prices = [offer('2026-05-01', 200), offer('2026-05-02', 220, 'DL')];
      expect(getUniqueCarriers(prices)).toEqual(['DL']);
    });

    it('returns empty array when no carrier info anywhere', () => {
      expect(getUniqueCarriers([offer('2026-05-01', 200)])).toEqual([]);
    });
  });

  describe('filterByCarrier', () => {
    const prices = [
      offer('2026-05-01', 200, 'DL'),
      offer('2026-05-01', 220, 'AA'),
      offer('2026-05-02', 190, 'DL'),
    ];

    it('returns only matching carrier offers', () => {
      expect(filterByCarrier(prices, 'DL')).toHaveLength(2);
      expect(filterByCarrier(prices, 'AA')).toHaveLength(1);
    });

    it('returns all prices when carrier is null/undefined/ALL', () => {
      expect(filterByCarrier(prices, null)).toEqual(prices);
      expect(filterByCarrier(prices, undefined)).toEqual(prices);
      expect(filterByCarrier(prices, ALL_CARRIERS_KEY)).toEqual(prices);
    });

    it('returns empty array for unknown carrier', () => {
      expect(filterByCarrier(prices, 'XX')).toEqual([]);
    });
  });

  describe('lowestPricePerDate', () => {
    it('keeps the cheapest offer per date and sorts by date ascending', () => {
      const prices = [
        offer('2026-05-02', 250, 'AA'),
        offer('2026-05-01', 220, 'AA'),
        offer('2026-05-01', 200, 'DL'),
        offer('2026-05-02', 240, 'DL'),
      ];
      const result = lowestPricePerDate(prices);
      expect(result.map((p) => [p.date, p.price, p.flightDetails?.carrier])).toEqual([
        ['2026-05-01', 200, 'DL'],
        ['2026-05-02', 240, 'DL'],
      ]);
    });

    it('handles Date objects and ISO strings interchangeably', () => {
      const prices: FlightPrice[] = [
        { date: new Date('2026-05-01T00:00:00Z'), price: 200, flightDetails: { carrier: 'DL' } },
        { date: '2026-05-01', price: 180, flightDetails: { carrier: 'AA' } },
      ];
      expect(lowestPricePerDate(prices)).toHaveLength(1);
      expect(lowestPricePerDate(prices)[0].price).toBe(180);
    });

    it('returns empty array for empty input', () => {
      expect(lowestPricePerDate([])).toEqual([]);
    });
  });
});
