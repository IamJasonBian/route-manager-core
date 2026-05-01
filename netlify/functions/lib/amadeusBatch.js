/**
 * Shared Amadeus batched date pricing — used by flight-prices and popular-routes.
 * @param {import('amadeus').default} amadeus
 * @param {string} origin
 * @param {string} destination
 * @param {string[]} dates
 * @param {{ maxPerDate?: number }} [options] maxPerDate=1 returns the cheapest offer per date
 *   (legacy shape: one entry per date). maxPerDate>1 returns up to N offers per date as a
 *   flat array, exposing per-carrier price points for the trends chart slicer.
 */
export async function getFlightPricesForDates(amadeus, origin, destination, dates, options = {}) {
  const maxPerDate = Math.max(1, options.maxPerDate ?? 1);

  const offerArrays = await Promise.all(
    dates.map(async (date) => {
      try {
        const response = await amadeus.shopping.flightOffersSearch.get({
          originLocationCode: origin,
          destinationLocationCode: destination,
          departureDate: date,
          adults: '1',
          max: String(maxPerDate),
          currencyCode: 'USD',
        });

        if (!response.data || response.data.length === 0) return [];

        return response.data.map((flight) => {
          const itinerary = flight.itineraries[0];
          const firstSegment = itinerary.segments[0];
          const lastSegment = itinerary.segments[itinerary.segments.length - 1];
          return {
            date,
            price: parseFloat(flight.price.total),
            flightDetails: {
              carrier: firstSegment.carrierCode,
              flightNumber: `${firstSegment.carrierCode}${firstSegment.number}`,
              departureTime: firstSegment.departure.at,
              arrivalTime: lastSegment.arrival.at,
              duration: itinerary.duration,
              stops: itinerary.segments.length - 1,
              bookingClass:
                flight.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.cabin || 'ECONOMY',
            },
          };
        });
      } catch (error) {
        console.error(`Error fetching offers for ${date}:`, error);
        return [];
      }
    }),
  );

  return offerArrays.flat().filter((p) => Number.isFinite(p.price));
}
