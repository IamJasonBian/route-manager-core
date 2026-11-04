import { getFlightPricesForDates } from './lib/datePrices.js';

// Helper function to format date to YYYY-MM-DD
const formatDate = (date) => date.toISOString().slice(0, 10);

// Next 14 days: one Kiwi search per date has to fit inside the function timeout.
const generateDatesForNextMonth = () => {
  const dates = [];
  const today = new Date();
  
  for (let i = 0; i < 14; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    dates.push(formatDate(date));
  }
  
  return dates;
};

export const handler = async (event, context) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://apollo-route-manager.windsurf.build',
    'https://route-manager-demo.netlify.app',
  ];
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[2],
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // Fast local/staging UI without hitting Kiwi (netlify.toml or .env)
  if (process.env.USE_MOCK_DATA === 'true') {
    const params = event.queryStringParameters || {};
    const from = params.from || 'JFK';
    const to = params.to || 'LAX';
    const dates = generateDatesForNextMonth();
    const basePrice = 400 + ((from.charCodeAt(0) + to.charCodeAt(0)) % 400);
    const mockPrices = dates.map((date, index) => ({
      date,
      price: Math.round(basePrice + Math.sin(index / 5) * 40 + (index % 7) * 3),
      flightDetails: {
        carrier: 'MOCK',
        flightNumber: 'MOCK100',
        departureTime: `${date}T08:00:00`,
        arrivalTime: `${date}T16:00:00`,
        duration: 'PT6H',
        stops: 0,
        bookingClass: 'ECONOMY',
      },
    }));
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-Data-Source': 'mock-env',
      },
      body: JSON.stringify({
        prices: mockPrices,
        basePrice: mockPrices[0]?.price ?? basePrice,
        lowestPrice: Math.min(...mockPrices.map((p) => p.price)),
        highestPrice: Math.max(...mockPrices.map((p) => p.price)),
        source: 'mock',
      }),
    };
  }

  const headers = corsHeaders;

  try {
    // Parse request parameters
    const params = event.queryStringParameters || {};
    const { from, to } = params;
    
    // Validate required parameters
    if (!from || !to) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required parameters: from and to' })
      };
    }
    
    // Accept a few city names as well as IATA codes
    const cityToCode = {
      'New York': 'JFK',
      'London': 'LHR',
      'Seattle': 'SEA',
      'Detroit': 'DTW',
      'Grand Rapids': 'GRR',
      'Los Angeles': 'LAX',
      'San Francisco': 'SFO',
      'Las Vegas': 'LAS',
      'Austin': 'AUS',
      'Vienna': 'VIE'
    };
    
    const originCode = cityToCode[from] || from;
    const destinationCode = cityToCode[to] || to;
    
    // Dates to price
    const dates = generateDatesForNextMonth();

    // Pull up to 5 offers per date so the trends chart can slice/overlay by carrier.
    const prices = await getFlightPricesForDates(originCode, destinationCode, dates, { maxPerDate: 5 });
    
    // If no prices found, return an error
    if (prices.length === 0) {
      console.log('No prices found, falling back to mock data');
      // Generate mock data as fallback
      const basePrice = 500 + Math.random() * 200;
      const carriers = ['AA', 'DL', 'UA', 'BA', 'AF'];
      const mockPrices = dates.map((date, index) => {
        const randomVariation = Math.random() * 100 - 50;
        const carrier = carriers[index % carriers.length];
        const flightNum = Math.floor(1000 + Math.random() * 9000);

        return {
          date,
          price: Math.round(basePrice + randomVariation),
          flightDetails: {
            carrier: carrier,
            flightNumber: `${carrier}${flightNum}`,
            departureTime: `${date}T08:00:00`,
            arrivalTime: `${date}T16:30:00`,
            duration: 'PT8H30M',
            stops: Math.floor(Math.random() * 2),
            bookingClass: 'ECONOMY'
          }
        };
      });
      
      // Log the mock fallback data
      console.log(`Mock fallback data for ${originCode} to ${destinationCode}:`, JSON.stringify(mockPrices, null, 2));
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          prices: mockPrices,
          source: 'mock'
        })
      };
    }
    
    // Calculate statistics
    const priceValues = prices.map(p => p.price);
    const basePrice = Math.round(priceValues.reduce((sum, price) => sum + price, 0) / priceValues.length);
    const lowestPrice = Math.min(...priceValues);
    const highestPrice = Math.max(...priceValues);
    
    // Return the results
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        prices,
        basePrice,
        lowestPrice,
        highestPrice,
        source: 'kiwi'
      })
    };
    
  } catch (error) {
    console.error('Error in flight-prices function:', error);
    
    // Return error response
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Error fetching flight prices',
        message: error.message
      })
    };
  }
};
