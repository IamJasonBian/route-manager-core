// GET ?keyword=se → { airports: [{ iataCode, name, cityName, countryName, type }], source: 'static' }
export const handler = async (event) => {
  // Set CORS headers - allow both localhost and production
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://apollo-route-manager.windsurf.build',
    'https://route-manager-demo.netlify.app'
  ];

  const headers = {
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[2],
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const keyword = event.queryStringParameters?.keyword || '';
  if (keyword.length < 2) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Keyword must be at least 2 characters' }) };
  }
  return { statusCode: 200, headers, body: JSON.stringify({ airports: searchAirports(keyword), source: 'static' }) };
};

// Static airport list (no search provider since Amadeus was retired)
const searchAirports = (keyword) => {
  const allAirports = [
    { iataCode: 'JFK', name: 'John F. Kennedy International Airport', cityName: 'New York', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'LHR', name: 'London Heathrow Airport', cityName: 'London', countryName: 'United Kingdom', type: 'AIRPORT' },
    { iataCode: 'LAX', name: 'Los Angeles International Airport', cityName: 'Los Angeles', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'ORD', name: "Chicago O'Hare International Airport", cityName: 'Chicago', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'SFO', name: 'San Francisco International Airport', cityName: 'San Francisco', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'CDG', name: 'Paris Charles de Gaulle Airport', cityName: 'Paris', countryName: 'France', type: 'AIRPORT' },
    { iataCode: 'NRT', name: 'Narita International Airport', cityName: 'Tokyo', countryName: 'Japan', type: 'AIRPORT' },
    { iataCode: 'SYD', name: 'Sydney Kingsford Smith Airport', cityName: 'Sydney', countryName: 'Australia', type: 'AIRPORT' },
    { iataCode: 'DXB', name: 'Dubai International Airport', cityName: 'Dubai', countryName: 'United Arab Emirates', type: 'AIRPORT' },
    { iataCode: 'SIN', name: 'Singapore Changi Airport', cityName: 'Singapore', countryName: 'Singapore', type: 'AIRPORT' },
    { iataCode: 'HKG', name: 'Hong Kong International Airport', cityName: 'Hong Kong', countryName: 'Hong Kong', type: 'AIRPORT' },
    { iataCode: 'MIA', name: 'Miami International Airport', cityName: 'Miami', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'SEA', name: 'Seattle-Tacoma International Airport', cityName: 'Seattle', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'BOS', name: 'Boston Logan International Airport', cityName: 'Boston', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'ATL', name: 'Hartsfield-Jackson Atlanta International Airport', cityName: 'Atlanta', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'DTW', name: 'Detroit Metropolitan Wayne County Airport', cityName: 'Detroit', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'GRR', name: 'Gerald R. Ford International Airport', cityName: 'Grand Rapids', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'LGA', name: 'LaGuardia Airport', cityName: 'New York', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'EWR', name: 'Newark Liberty International Airport', cityName: 'Newark', countryName: 'United States', type: 'AIRPORT' },
    { iataCode: 'NYC', name: 'All New York airports', cityName: 'New York', countryName: 'United States', type: 'CITY' },
    { iataCode: 'YVR', name: 'Vancouver International Airport', cityName: 'Vancouver', countryName: 'Canada', type: 'AIRPORT' },
    { iataCode: 'DEN', name: 'Denver International Airport', cityName: 'Denver', countryName: 'United States', type: 'AIRPORT' },
  ];

  const lowerKeyword = keyword.toLowerCase();
  return allAirports.filter(airport =>
    airport.iataCode.toLowerCase().includes(lowerKeyword) ||
    airport.name.toLowerCase().includes(lowerKeyword) ||
    airport.cityName.toLowerCase().includes(lowerKeyword)
  ).slice(0, 10);
};
