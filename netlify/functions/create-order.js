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

const validateTraveler = (t, i) => {
  const missing = [];
  if (!t?.firstName) missing.push(`travelers[${i}].firstName`);
  if (!t?.lastName) missing.push(`travelers[${i}].lastName`);
  if (!t?.dateOfBirth) missing.push(`travelers[${i}].dateOfBirth`);
  if (!t?.gender) missing.push(`travelers[${i}].gender`);
  if (!t?.email) missing.push(`travelers[${i}].email`);
  if (!t?.phone) missing.push(`travelers[${i}].phone`);
  return missing;
};

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

    const { pricedOffer, travelers } = JSON.parse(event.body || '{}');

    if (!pricedOffer) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required field: pricedOffer' })
      };
    }
    if (!Array.isArray(travelers) || travelers.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required field: travelers (non-empty array)' })
      };
    }
    const missing = travelers.flatMap(validateTraveler);
    if (missing.length) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing traveler fields', missing })
      };
    }

    const amadeusTravelers = travelers.map((t, idx) => ({
      id: String(idx + 1),
      dateOfBirth: t.dateOfBirth,
      name: { firstName: t.firstName, lastName: t.lastName },
      gender: t.gender.toUpperCase(),
      contact: {
        emailAddress: t.email,
        phones: [
          {
            deviceType: 'MOBILE',
            countryCallingCode: t.phoneCountryCode || '1',
            number: t.phone
          }
        ]
      }
    }));

    const response = await amadeus.booking.flightOrders.post(
      JSON.stringify({
        data: {
          type: 'flight-order',
          flightOffers: [pricedOffer],
          travelers: amadeusTravelers
        }
      })
    );

    const order = response.data || {};
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: order,
        confirmation: {
          orderId: order.id,
          pnr: order.associatedRecords?.[0]?.reference,
          environment: process.env.AMADEUS_HOSTNAME || 'test'
        }
      })
    };
  } catch (error) {
    console.error('create-order error:', error);
    return {
      statusCode: error.response?.statusCode || 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to create booking',
        message: error.description || error.message,
        body: error.response?.body
      })
    };
  }
};
