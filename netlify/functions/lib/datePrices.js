import { searchKiwi } from './kiwi.js';

/**
 * Up to `maxPerDate` cheapest one-way offers per date via Kiwi, flattened, for
 * the price-trends chart (per-carrier slicer). Bounded concurrency keeps a
 * 14-date batch inside the function timeout and off Kiwi's rate limit.
 * @returns {Promise<{ date: string, price: number, flightDetails: object }[]>}
 */
export async function getFlightPricesForDates(origin, destination, dates, { maxPerDate = 1, concurrency = 7 } = {}) {
  const out = [];
  const queue = [...dates];
  async function worker() {
    for (let date = queue.shift(); date; date = queue.shift()) {
      try {
        const { itineraries } = await searchKiwi({ origin, destination, departureDate: date });
        for (const it of itineraries.slice(0, maxPerDate)) {
          const segs = it.outbound?.segments || [];
          const first = segs[0], last = segs[segs.length - 1];
          if (!first || !Number.isFinite(Number(it.price))) continue;
          out.push({
            date,
            price: Number(it.price),
            flightDetails: {
              carrier: first.carrier,
              flightNumber: `${first.carrier}${String(first.flightNumber ?? '').replace(/^[A-Z0-9]{2}(?=\d)/, '')}`,
              departureTime: first.departureTime ?? it.outbound.departureTime,
              arrivalTime: last.arrivalTime ?? it.outbound.arrivalTime,
              durationSeconds: it.outbound.durationSeconds,
              stops: segs.length - 1,
              bookingClass: 'ECONOMY',
              bookingUrl: it.bookingUrl,
            },
          });
        }
      } catch (error) {
        console.error(`Kiwi prices ${origin}-${destination} ${date}:`, error.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, dates.length) }, worker));
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.price - b.price);
}
