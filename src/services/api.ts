import axios from 'axios';
import { getApiBaseUrl, getApiMode, getApiTimeoutMs, mockRoutesFromEnv } from '../config/runtime';
import { saveRoute as saveDbRoute, DbRoute } from './routeService';

// Interface for flight details
export interface FlightDetails {
  carrier?: string;
  flightNumber?: string;
  departureTime?: string;
  arrivalTime?: string;
  duration?: string;
  stops?: number;
  bookingClass?: string;
}

// Interface for flight price data
export interface FlightPrice {
  date: Date | string;
  price: number;
  flightDetails?: FlightDetails;
}

// Interface for route metadata
export interface RouteMeta {
  fromCode: string;
  toCode: string;
  source: string;
  lowestPrice?: number;
  highestPrice?: number;
  updatedAt?: string;
  _error?: string;
}

// API configuration: same-origin `/.netlify/functions` by default; override with VITE_API_URL / VITE_REMOTE_API_BASE
const createApiClient = () => {
  const client = axios.create({
    baseURL: getApiBaseUrl(),
    timeout: getApiTimeoutMs(),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
  if (process.env.NODE_ENV === 'development') {
    client.interceptors.request.use((config) => {
      (config as { metadata?: { t: number } }).metadata = { t: performance.now() };
      return config;
    });
    client.interceptors.response.use(
      (res) => {
        const meta = (res.config as { metadata?: { t: number } }).metadata;
        if (meta?.t != null) {
          const ms = Math.round(performance.now() - meta.t);
          console.debug(`[api] ${res.config.baseURL ?? ''}${res.config.url ?? ''} ${ms}ms`);
        }
        return res;
      },
      (err) => Promise.reject(err)
    );
  }
  return client;
};

export const apiClient = createApiClient();

// Interface for API route
export interface ApiRoute {
  id: string;
  from: string;
  to: string;
  basePrice: number;
  prices: FlightPrice[];
  distance: string;
  duration: string;
  meta: RouteMeta;
}

// Interface for route data (legacy, keeping for backward compatibility)
export interface Route extends Omit<ApiRoute, 'meta'> {
  id: string;
  from: string;
  to: string;
  prices: Array<{ date: string | Date; price: number }>;
  basePrice: number;
  distance: string;
  duration: string;
}

// Helper function to convert between API and DB route formats
const toDbRoute = (route: ApiRoute): Omit<DbRoute, 'id' | 'created_at' | 'updated_at'> => {
  const firstPrice = route.prices[0];
  const secondPrice = route.prices[1];
  
  // Ensure we have valid date strings or Date objects
  const departureDate = firstPrice?.date 
    ? (firstPrice.date instanceof Date ? firstPrice.date : new Date(firstPrice.date))
    : new Date();
    
  const returnDate = secondPrice?.date 
    ? (secondPrice.date instanceof Date ? secondPrice.date : new Date(secondPrice.date))
    : null;
  
  return {
    origin: route.from,
    destination: route.to,
    price: route.basePrice,
    departure_date: departureDate,
    return_date: returnDate,
    airline: 'Unknown',
    flight_number: `FLT-${Math.floor(1000 + Math.random() * 9000)}`
  };
};

// Save route to database
export const saveRoute = async (route: ApiRoute): Promise<ApiRoute> => {
  const dbRoute = toDbRoute(route);
  const savedRoute = await saveDbRoute(dbRoute);
  return toApiRoute(savedRoute);
};

// Helper function to convert between DB and API route formats
const toApiRoute = (dbRoute: DbRoute): ApiRoute => {
  console.group('toApiRoute - Start');
  try {
    console.log('Input dbRoute:', JSON.stringify(dbRoute, null, 2));
    
    // Ensure we have valid dates
    let departureDate: Date;
    try {
      departureDate = dbRoute.departure_date 
        ? (typeof dbRoute.departure_date === 'string' 
            ? new Date(dbRoute.departure_date) 
            : dbRoute.departure_date)
        : new Date();
      
      if (isNaN(departureDate.getTime())) {
        console.warn('Invalid departure date, using current date');
        departureDate = new Date();
      }
    } catch (dateError) {
      console.warn('Error parsing departure date, using current date:', dateError);
      departureDate = new Date();
    }
    
    let returnDate: Date | null = null;
    if (dbRoute.return_date) {
      try {
        returnDate = typeof dbRoute.return_date === 'string' 
          ? new Date(dbRoute.return_date)
          : dbRoute.return_date;
          
        if (isNaN(returnDate.getTime())) {
          console.warn('Invalid return date, setting to null');
          returnDate = null;
        }
      } catch (dateError) {
        console.warn('Error parsing return date, setting to null:', dateError);
        returnDate = null;
      }
    }
    
    // Ensure we have a valid price
    let price = 0;
    if (dbRoute.price !== null && dbRoute.price !== undefined) {
      price = typeof dbRoute.price === 'number' 
        ? dbRoute.price 
        : parseFloat(dbRoute.price) || 0;
    }
    
    // Ensure we have valid origin and destination
    const origin = dbRoute.origin?.toString() || 'UNKNOWN';
    const destination = dbRoute.destination?.toString() || 'UNKNOWN';
    
    // Create the API route object
    const apiRoute: ApiRoute = {
      id: dbRoute.id?.toString() || `temp-${Date.now()}`,
      from: origin,
      to: destination,
      basePrice: price,
      distance: '0 km',
      duration: '0h 0m',
      prices: [
        { date: departureDate, price },
        ...(returnDate ? [{ date: returnDate, price }] : [])
      ],
      meta: {
        fromCode: origin,
        toCode: destination,
        source: 'database',
        lowestPrice: price,
        highestPrice: price
      }
    };
    
    console.log('Generated API route:', JSON.stringify(apiRoute, null, 2));
    return apiRoute;
  } catch (error) {
    console.error('Error in toApiRoute:', error);
    throw error;
  } finally {
    console.groupEnd();
  }
};

// Get price history for a route
interface PriceHistoryResponse {
  prices: Array<{ date: string; price: number; flightDetails?: FlightDetails }>;
  basePrice: number;
  lowestPrice: number;
  highestPrice: number;
  source: string;
}

export async function getPriceHistory(
  from: string,
  to: string,
  options?: { signal?: AbortSignal }
): Promise<PriceHistoryResponse> {
  if (getApiMode() === 'mock') {
    const mockPrices = generateMockPrices();
    return {
      prices: mockPrices.map((p) => ({
        date: typeof p.date === 'string' ? p.date : p.date.toISOString().split('T')[0],
        price: p.price,
      })),
      basePrice: 300,
      lowestPrice: Math.min(...mockPrices.map((p) => p.price)),
      highestPrice: Math.max(...mockPrices.map((p) => p.price)),
      source: 'mock',
    };
  }
  try {
    const response = await apiClient.get<PriceHistoryResponse>(`/flight-prices?from=${from}&to=${to}`, {
      signal: options?.signal,
    });
    // Ensure the response has the correct format
    if (response.data && Array.isArray(response.data.prices)) {
      return {
        ...response.data,
        prices: response.data.prices.map(p => ({
          date: typeof p.date === 'string' ? p.date : new Date(p.date).toISOString().split('T')[0],
          price: p.price,
          flightDetails: p.flightDetails
        }))
      };
    }
    throw new Error('Invalid response format from API');
  } catch (error) {
    console.error('Error fetching price history:', error);
    // Return mock data if API fails
    const mockPrices = generateMockPrices();
    return {
      prices: mockPrices.map(p => ({
        date: typeof p.date === 'string' ? p.date : p.date.toISOString().split('T')[0],
        price: p.price,
        flightDetails: p.flightDetails
      })),
      basePrice: 300,
      lowestPrice: Math.min(...mockPrices.map(p => p.price)),
      highestPrice: Math.max(...mockPrices.map(p => p.price)),
      source: 'mock'
    };
  }
}

// Get flight prices for a route over time
export const getFlightPrices = async (
  from: string,
  to: string,
  departDate: string,
  options?: { signal?: AbortSignal }
): Promise<FlightPrice[]> => {
  if (getApiMode() === 'mock') {
    const routeHash = from.charCodeAt(0) + to.charCodeAt(0);
    const basePrice = 400 + (routeHash % 500);
    return generateMockPrices(basePrice);
  }
  try {
    console.log(`Fetching prices from ${from} to ${to} for ${departDate}`);

    const response = await apiClient.get(`/flight-prices?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
      signal: options?.signal,
    });
    
    if (response.data && response.data.prices) {
      console.log(`Received ${response.data.prices.length} prices from ${response.data.source} source`);
      
      // Convert date strings to Date objects, preserve flightDetails so the
      // carrier slicer in RouteCard / PriceChart can group by airline.
      return response.data.prices.map((price: any) => ({
        date: new Date(price.date),
        price: price.price,
        flightDetails: price.flightDetails,
      }));
    }
    
    throw new Error('Invalid response format');
  } catch (error) {
    console.error('Error fetching flight prices:', error);
    // Fall back to mock data on error
    const routeHash = from.charCodeAt(0) + to.charCodeAt(0);
    const basePrice = 400 + (routeHash % 500); // Generate a base price between 400-900 based on route
    console.warn('Falling back to mock data');
    return generateMockPrices(basePrice);
  }
};

// Note: The isValidRoute function has been removed as it was not being used.
// If you need to validate route data, you can reimplement it as needed.

// Generate fallback routes when API fails
export const generateFallbackRoutes = (): ApiRoute[] => {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Simple mock prices for fallback
  const mockPrices = (basePrice: number): FlightPrice[] => {
    const prices: FlightPrice[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
      // Add some random variation to prices
      const variation = Math.random() * 0.2 - 0.1; // ±10%
      const price = Math.round(basePrice * (1 + variation));
      prices.push({ date, price });
    }
    return prices;
  };

  return [
    {
      id: 'fallback-1',
      from: 'JFK',
      to: 'LAX',
      basePrice: 299,
      prices: mockPrices(299),
      distance: '2,475 mi',
      duration: '5h 30m',
      meta: {
        fromCode: 'JFK',
        toCode: 'LAX',
        source: 'fallback',
        lowestPrice: 299,
        highestPrice: 450
      }
    },
    {
      id: 'fallback-2',
      from: 'JFK',
      to: 'SFO',
      basePrice: 349,
      prices: mockPrices(349),
      distance: '2,585 mi',
      duration: '6h 15m',
      meta: {
        fromCode: 'JFK',
        toCode: 'SFO',
        source: 'fallback',
        lowestPrice: 349,
        highestPrice: 520
      }
    },
    {
      id: 'fallback-3',
      from: 'JFK',
      to: 'MIA',
      basePrice: 199,
      prices: mockPrices(199),
      distance: '1,089 mi',
      duration: '3h 15m',
      meta: {
        fromCode: 'JFK',
        toCode: 'MIA',
        source: 'fallback',
        lowestPrice: 199,
        highestPrice: 320
      }
    },
    {
      id: 'fallback-4',
      from: 'JFK',
      to: 'ORD',
      basePrice: 149,
      prices: mockPrices(149),
      distance: '740 mi',
      duration: '2h 45m',
      meta: {
        fromCode: 'JFK',
        toCode: 'ORD',
        source: 'fallback',
        lowestPrice: 149,
        highestPrice: 280
      }
    },
    {
      id: 'fallback-5',
      from: 'JFK',
      to: 'DFW',
      basePrice: 249,
      prices: mockPrices(249),
      distance: '1,390 mi',
      duration: '3h 45m',
      meta: {
        fromCode: 'JFK',
        toCode: 'DFW',
        source: 'fallback',
        lowestPrice: 249,
        highestPrice: 390
      }
    }
  ];
};

// Helper function to generate mock price data for one-day flights starting from today
export const generateMockPrices = (basePrice: number = 550): FlightPrice[] => {
  const prices: FlightPrice[] = [];
  const today = new Date();
  
  // Generate prices for the next 7 days
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    
    // Add some random variation to the price
    const variation = Math.random() * 0.2 - 0.1; // ±10%
    const price = Math.round(basePrice * (1 + variation));
    
    prices.push({
      date,
      price
    });
  }
  
  return prices;
};

// Alias for backwards compatibility in tests
export const generateMockRoutes = (): ApiRoute[] => generateFallbackRoutes();

// ---------- Ski Trips API ----------

export type SkiTripTransportMode = 'flight' | 'bus';

export interface SkiTripStop {
  code: string;
  name: string;
}

export interface SkiTripOutboundLeg {
  operator: string;
  number?: string;
  from: SkiTripStop;
  to: SkiTripStop;
  depart: string;
  arrive: string;
  durationMin: number;
  priceUsd: number;
}

export interface SkiTripReturnOption extends SkiTripOutboundLeg {
  id: string;
  label: string;
  recommended: boolean;
  note?: string;
}

export interface SkiTripTransport {
  mode: SkiTripTransportMode;
  outbound: SkiTripOutboundLeg;
  returnOptions: SkiTripReturnOption[];
  groundTransferMin: number;
  groundTransferNote: string;
}

export interface SkiTripMountainStats {
  verticalFt: number;
  trails: number;
  lifts: number;
}

export interface SkiTripTotals {
  transportPriceUsdMin: number;
  transportPriceUsdMax: number;
  transitTimeMinOneWay: number;
}

export interface SkiTrip {
  id: string;
  resort: string;
  state: string;
  epicPass: boolean;
  heroAccent: string;
  mountainStats: SkiTripMountainStats;
  transport: SkiTripTransport;
  totals: SkiTripTotals;
  notes: string;
  sources: string[];
}

export interface SkiTripsWeekend {
  depart: string;
  return: string;
  label: string;
}

export interface SkiTripsOrigin {
  city: string;
  hubs: string[];
}

export interface SkiTripsListResponse {
  generatedAt: string;
  seasonTarget: string;
  weekend: SkiTripsWeekend;
  priceBasis: string;
  origin: SkiTripsOrigin;
  trips: SkiTrip[];
}

export interface SkiTripSingleResponse {
  generatedAt: string;
  seasonTarget: string;
  weekend: SkiTripsWeekend;
  priceBasis: string;
  origin: SkiTripsOrigin;
  trip: SkiTrip;
}

export type SkiTripsResponse = SkiTripsListResponse;

export interface GetSkiTripsOptions {
  mode?: SkiTripTransportMode;
  id?: string;
  signal?: AbortSignal;
}

export async function getSkiTrips(opts: { id: string } & Omit<GetSkiTripsOptions, 'id'>): Promise<SkiTripSingleResponse>;
export async function getSkiTrips(opts?: Omit<GetSkiTripsOptions, 'id'>): Promise<SkiTripsListResponse>;
export async function getSkiTrips(
  opts?: GetSkiTripsOptions
): Promise<SkiTripsListResponse | SkiTripSingleResponse> {
  const params: Record<string, string> = {};
  if (opts?.id) params.id = opts.id;
  if (opts?.mode) params.mode = opts.mode;
  try {
    const response = await apiClient.get<SkiTripsListResponse | SkiTripSingleResponse>(
      '/ski-trips',
      { params, signal: opts?.signal }
    );
    return response.data;
  } catch (error) {
    console.error('Error fetching ski trips:', error);
    throw error;
  }
}

// Import default routes
import { defaultRoutes } from '../config/defaultRoutes';

/**
 * Loads all default routes into the database if none exist
 * @returns Promise that resolves when loading is complete
 */
export const loadDefaultRoutes = async (): Promise<void> => {
  try {
    console.log('Checking if we need to load default routes...');
    const { hasRoutes, saveApiRoutes } = await import('./routeService');
    
    // Check if we already have routes in the database
    const routesExist = await hasRoutes();
    
    if (!routesExist) {
      console.log('No routes found in database, loading default routes...');
      // Save all default routes to the database
      await saveApiRoutes(defaultRoutes);
      console.log('Successfully loaded default routes into database');
    } else {
      console.log('Routes already exist in database, skipping default route loading');
    }
  } catch (error) {
    console.error('Error loading default routes:', error);
    throw error;
  }
};

// Get available routes with database fallback
export const getRoutes = async (): Promise<ApiRoute[]> => {
  if (mockRoutesFromEnv()) {
    return generateFallbackRoutes().map((route, index) => ({
      ...route,
      id: `mock-${index + 1}`,
      meta: { ...route.meta, source: 'mock-local' },
    }));
  }
  try {
    console.log('1. Loading default routes if needed...');
    await loadDefaultRoutes();
    
    console.log('2. Importing routeService...');
    // Import getRoutes from routeService to avoid circular dependency
    const { getRoutes: getDbRoutes } = await import('./routeService');
    
    // Get routes from the database
    console.log('3. Fetching routes from database...');
    const dbRoutes = await getDbRoutes();
    console.log('4. Raw database response:', JSON.stringify(dbRoutes, null, 2));
    
    if (dbRoutes && dbRoutes.length > 0) {
      console.log(`5. Found ${dbRoutes.length} routes in database`);
      const apiRoutes = dbRoutes.map((route, index) => {
        console.log(`6. Converting route ${index + 1}/${dbRoutes.length}:`, JSON.stringify(route, null, 2));
        try {
          const apiRoute = toApiRoute(route);
          console.log(`7. Successfully converted route ${index + 1}:`, JSON.stringify(apiRoute, null, 2));
          return apiRoute;
        } catch (error) {
          console.error(`Error converting route ${index + 1}:`, error);
          return null;
        }
      }).filter((route): route is ApiRoute => route !== null);
      
      console.log('8. All routes converted successfully:', apiRoutes.length > 0);
      
      // Return routes from database if we have any
      if (apiRoutes.length > 0) {
        return apiRoutes;
      }
    }
    
    // If we get here, either there were no routes in the database or they couldn't be converted
    console.log('8. No valid routes found in database, returning default routes');
    
    // Add IDs to default routes
    const routesWithIds = defaultRoutes.map((route, index) => ({
      ...route,
      id: `default-${index + 1}`,
      meta: {
        ...route.meta,
        source: 'default',
      },
    }));
    
    console.log('9. Returning default routes:', routesWithIds.length);
    return routesWithIds;
  } catch (error) {
    console.error('10. Error in getRoutes:', error);
    
    // Return empty array on error
    console.warn('11. Error occurred, returning empty array');
    return [];
  }
};
