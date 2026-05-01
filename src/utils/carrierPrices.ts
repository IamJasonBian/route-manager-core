import { FlightPrice } from '../services/api';

const ALL_CARRIERS_KEY = 'ALL';

const dateKey = (date: FlightPrice['date']): string =>
  date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);

export const getUniqueCarriers = (prices: FlightPrice[]): string[] => {
  const seen = new Set<string>();
  for (const p of prices) {
    const c = p.flightDetails?.carrier;
    if (c) seen.add(c);
  }
  return Array.from(seen).sort();
};

export const filterByCarrier = (
  prices: FlightPrice[],
  carrier: string | null | undefined,
): FlightPrice[] => {
  if (!carrier || carrier === ALL_CARRIERS_KEY) return prices;
  return prices.filter((p) => p.flightDetails?.carrier === carrier);
};

// Reduce multiple offers per date down to one (the cheapest), so the chart's
// date axis stays unique. Used in "All carriers" mode.
export const lowestPricePerDate = (prices: FlightPrice[]): FlightPrice[] => {
  const cheapest = new Map<string, FlightPrice>();
  for (const p of prices) {
    const key = dateKey(p.date);
    const current = cheapest.get(key);
    if (!current || p.price < current.price) {
      cheapest.set(key, p);
    }
  }
  return Array.from(cheapest.values()).sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
};

export { ALL_CARRIERS_KEY };
