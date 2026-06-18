// Metro area codes that Google Flights recognizes
// These map to multiple airports in a metro area
const METRO_AREA_CODES: Record<string, string> = {
  // New York
  'NYC': 'New York',
  'JFK': 'JFK',
  'LGA': 'LaGuardia',
  'EWR': 'Newark',
  // Los Angeles
  'LAX': 'Los Angeles',
  // Chicago
  'CHI': 'Chicago',
  'ORD': "O'Hare",
  'MDW': 'Midway',
  // San Francisco Bay Area
  'SFO': 'San Francisco',
  'OAK': 'Oakland',
  'SJC': 'San Jose',
  // Washington DC
  'WAS': 'Washington DC',
  'DCA': 'Reagan',
  'IAD': 'Dulles',
  'BWI': 'Baltimore',
  // London
  'LON': 'London',
  'LHR': 'Heathrow',
  'LGW': 'Gatwick',
  'STN': 'Stansted',
  // Tokyo
  'TYO': 'Tokyo',
  'NRT': 'Narita',
  'HND': 'Haneda',
  // Paris
  'PAR': 'Paris',
  'CDG': 'Charles de Gaulle',
  'ORY': 'Orly',
};

/**
 * Gets a display-friendly name for an airport/metro code
 */
function getLocationName(code: string): string {
  return METRO_AREA_CODES[code] || code;
}

/**
 * Generates a Google Flights URL for a given route and date.
 * Uses the search query format which handles both individual airports
 * and metro area codes (like NYC, CHI, LON).
 *
 * @param origin - Origin airport IATA code (e.g., 'JFK') or metro code (e.g., 'NYC')
 * @param destination - Destination airport IATA code or metro code
 * @param departureDate - Departure date (Date object or ISO string)
 * @param returnDate - Optional return date for round trip
 * @returns Google Flights URL
 */
export function generateGoogleFlightsUrl(
  origin: string,
  destination: string,
  departureDate: Date | string,
  returnDate?: Date | string
): string {
  const baseUrl = 'https://www.google.com/travel/flights';

  // Format date as YYYY-MM-DD
  const formatDate = (date: Date | string): string => {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toISOString().split('T')[0];
  };

  const depDate = formatDate(departureDate);

  // Use location names for better Google Flights parsing
  const originName = getLocationName(origin);
  const destName = getLocationName(destination);

  // For round-trip flights
  if (returnDate) {
    const retDate = formatDate(returnDate);
    // Round trip URL format - use names for metro areas, codes for airports
    return `${baseUrl}?q=flights+from+${encodeURIComponent(originName)}+to+${encodeURIComponent(destName)}+on+${depDate}+return+${retDate}`;
  }

  // One-way URL format
  return `${baseUrl}?q=flights+from+${encodeURIComponent(originName)}+to+${encodeURIComponent(destName)}+on+${depDate}+one+way`;
}

/**
 * Generates a Google Flights explore URL for flexible date searching.
 *
 * @param origin - Origin airport IATA code or metro code
 * @param destination - Destination airport IATA code or metro code
 * @returns Google Flights explore URL
 */
export function generateGoogleFlightsExploreUrl(
  origin: string,
  destination: string
): string {
  const originName = getLocationName(origin);
  const destName = getLocationName(destination);
  return `https://www.google.com/travel/flights?q=flights+from+${encodeURIComponent(originName)}+to+${encodeURIComponent(destName)}`;
}
