import Amadeus from 'amadeus';
import { searchKiwi, toAmadeusOffer } from './lib/kiwi.js';

// Amadeus Self-Service keys were disabled on 2026-07-17, so Kiwi's public search
// is the default. Set FLIGHT_SEARCH_PROVIDER=amadeus to try Amadeus first
// (falls back to Kiwi on failure).
const PROVIDER = (process.env.FLIGHT_SEARCH_PROVIDER || 'kiwi').toLowerCase();

async function searchViaKiwi(params) {
  const { currency, itineraries } = await searchKiwi(params);
  const max = Number(params.maxResults || 10);
  return {
    data: itineraries.slice(0, max).map((it, i) => toAmadeusOffer(it, i, currency)),
    meta: { count: Math.min(itineraries.length, max), source: 'kiwi' },
  };
}

// Helper function to get config with fallbacks
const getConfig = async () => {
  // Try to get from environment variables first (for Netlify)
  if (process.env.AMADEUS_API_KEY && process.env.AMADEUS_API_SECRET) {
    console.log('Using environment variables for Amadeus config');
    return {
      apiKey: process.env.AMADEUS_API_KEY,
      apiSecret: process.env.AMADEUS_API_SECRET,
      hostname: process.env.AMADEUS_HOSTNAME || 'production'
    };
  }
  
  // Fallback to config import (for local development)
  try {
    console.log('Trying to load config from ../../src/config/env.js');
    const config = await import('../../src/config/env.js');
    return {
      apiKey: config.default.amadeus.apiKey,
      apiSecret: config.default.amadeus.apiSecret,
      hostname: config.default.amadeus.hostname
    };
  } catch (error) {
    console.error('Failed to load config:', error);
    throw new Error('Failed to load configuration');
  }
};

// Initialize Amadeus client
let amadeus;

export const handler = async (event, context) => {
  console.log('=== New Request ===');
  console.log('Method:', event.httpMethod);
  console.log('Path:', event.path);
  console.log('Query:', event.queryStringParameters);

  // Set CORS headers - use environment variable or allow all origins
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    const error = { error: 'Method Not Allowed', allowed: ['POST'] };
    console.error('Method not allowed:', error);
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify(error),
    };
  }

  let params;
  try {
    params = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Validate required parameters
  if (!params.origin || !params.destination || !params.departureDate) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: 'Missing required parameters: origin, destination, departureDate'
      })
    };
  }

  if (PROVIDER !== 'amadeus') {
    try {
      return { statusCode: 200, headers, body: JSON.stringify(await searchViaKiwi(params)) };
    } catch (error) {
      console.error('Kiwi search error:', error);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch flight data', message: error.message, source: 'kiwi' })
      };
    }
  }

  try {
    // Initialize Amadeus client if not already initialized
    if (!amadeus) {
      console.log('Initializing Amadeus client...');
      const config = await getConfig();
      amadeus = new Amadeus({
        clientId: config.apiKey,
        clientSecret: config.apiSecret,
        hostname: config.hostname
      });
      console.log('Amadeus client initialized successfully');
    }

    console.log('Searching flights with params:', {
      origin: params.origin,
      destination: params.destination,
      departureDate: params.departureDate,
      returnDate: params.returnDate
    });

    // Make the API call to Amadeus
    const response = await amadeus.shopping.flightOffersSearch.get({
      originLocationCode: params.origin,
      destinationLocationCode: params.destination,
      departureDate: params.departureDate,
      ...(params.returnDate && { returnDate: params.returnDate }),
      adults: params.adults || 1,
      nonStop: params.nonStop || false,
      maxPrice: params.maxPrice,
      max: params.maxResults || 10,
      currencyCode: 'USD',
    });

    console.log('Received response from Amadeus API');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        data: response.data || [],
        meta: { ...(response.meta || {}), source: 'amadeus' }
      })
    };
  } catch (error) {
    console.error('Amadeus API error:', error);

    try {
      console.log('Falling back to Kiwi search');
      return { statusCode: 200, headers, body: JSON.stringify(await searchViaKiwi(params)) };
    } catch (kiwiError) {
      console.error('Kiwi fallback failed:', kiwiError);
    }
    
    // Enhanced error logging
    const errorDetails = {
      message: error.message,
      code: error.code,
      statusCode: error.response?.statusCode,
      body: error.response?.body,
      description: error.description,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    };
    
    console.error('Error details:', JSON.stringify(errorDetails, null, 2));

    return {
      statusCode: error.response?.statusCode || 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to fetch flight data',
        details: process.env.NODE_ENV === 'development' ? errorDetails : undefined,
        message: error.description || error.message
      })
    };
  }
};
