import Amadeus from 'amadeus';

const getConfig = async () => {
  if (process.env.AMADEUS_API_KEY && process.env.AMADEUS_API_SECRET) {
    return {
      apiKey: process.env.AMADEUS_API_KEY,
      apiSecret: process.env.AMADEUS_API_SECRET,
      hostname: process.env.AMADEUS_HOSTNAME || 'test'
    };
  }
  const config = await import('../../src/config/env.js');
  return {
    apiKey: config.default.amadeus.apiKey,
    apiSecret: config.default.amadeus.apiSecret,
    hostname: config.default.amadeus.hostname
  };
};

let amadeus;

export const handler = async (event) => {
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed', allowed: ['POST'] })
    };
  }

  try {
    if (!amadeus) {
      const config = await getConfig();
      amadeus = new Amadeus({
        clientId: config.apiKey,
        clientSecret: config.apiSecret,
        hostname: config.hostname
      });
    }

    const { flightOffer } = JSON.parse(event.body || '{}');
    if (!flightOffer) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required field: flightOffer' })
      };
    }

    const response = await amadeus.shopping.flightOffers.pricing.post(
      JSON.stringify({
        data: {
          type: 'flight-offers-pricing',
          flightOffers: [flightOffer]
        }
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ data: response.data })
    };
  } catch (error) {
    console.error('price-offer error:', error);
    return {
      statusCode: error.response?.statusCode || 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to confirm price',
        message: error.description || error.message,
        body: error.response?.body
      })
    };
  }
};
