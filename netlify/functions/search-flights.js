import { searchKiwi, toAmadeusOffer } from './lib/kiwi.js';

// POST { origin, destination, departureDate, returnDate?, adults?, maxResults?,
//        nonStop?, maxStops?, maxPrice?, sort? } → { data: FlightOffer[], meta }
// Kiwi's public search, mapped into the FlightOffer shape the web app and
// route-manager-ios decode.
export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed', allowed: ['POST'] }) };
  }

  let params;
  try {
    params = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!params.origin || !params.destination || !params.departureDate) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required parameters: origin, destination, departureDate' }) };
  }

  try {
    const { currency, itineraries } = await searchKiwi(params);
    const max = Number(params.maxResults || 10);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: itineraries.slice(0, max).map((it, i) => toAmadeusOffer(it, i, currency)),
        meta: { count: Math.min(itineraries.length, max), source: 'kiwi' },
      }),
    };
  } catch (error) {
    console.error('Kiwi search error:', error);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to fetch flight data', message: error.message, source: 'kiwi' }) };
  }
};
