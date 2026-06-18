import { useState, useEffect, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import PriceHistoryChart, { ChartType } from '../components/PriceHistoryChart';
import { getPriceHistory } from '../services/api';
import { generateGoogleFlightsUrl, generateGoogleFlightsExploreUrl } from '../utils/googleFlights';
import PassengerForm from '../components/PassengerForm';

interface Airport {
  iataCode: string;
  name: string;
  cityName: string;
  countryName: string;
  type: string;
}

interface FlightDetails {
  carrier?: string;
  flightNumber?: string;
  departureTime?: string;
  arrivalTime?: string;
  duration?: string;
  stops?: number;
  bookingClass?: string;
}

interface PricePoint {
  price: number;
  recorded_at: string;
  flightDetails?: FlightDetails;
}

interface TabPanelProps {
  children: React.ReactNode;
  isActive: boolean;
  id: string;
}

function TabPanel({ children, isActive, id }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={id}
      className={`p-4 ${isActive ? 'block' : 'hidden'}`}
      aria-labelledby={`${id}-tab`}
    >
      {children}
    </div>
  );
}

type StopsFilter = 'cheapest' | '0' | '1' | '2' | '3+';
type FarePreference = '' | 'refundable' | 'no_penalty' | 'no_restriction';

const farePreferenceOptions = [
  { code: '' as FarePreference, name: 'Any fare type' },
  { code: 'refundable' as FarePreference, name: 'Refundable fares only' },
  { code: 'no_penalty' as FarePreference, name: 'No change fees' },
  { code: 'no_restriction' as FarePreference, name: 'No restrictions (flexible)' },
];

// Airlines that can be excluded from chart display
const excludableAirlines = [
  { code: 'NK', name: 'Spirit' },
  { code: 'AA', name: 'American' },
  { code: 'F9', name: 'Frontier' },
  { code: 'B6', name: 'JetBlue' },
];

// Map of coordinates to nearest major airport
const AIRPORT_COORDS: { code: string; lat: number; lon: number; name: string }[] = [
  { code: 'DTW', lat: 42.2124, lon: -83.3534, name: 'Detroit' },
  { code: 'JFK', lat: 40.6413, lon: -73.7781, name: 'New York JFK' },
  { code: 'LGA', lat: 40.7769, lon: -73.8740, name: 'New York LaGuardia' },
  { code: 'EWR', lat: 40.6895, lon: -74.1745, name: 'Newark' },
  { code: 'LAX', lat: 33.9416, lon: -118.4085, name: 'Los Angeles' },
  { code: 'ORD', lat: 41.9742, lon: -87.9073, name: 'Chicago O\'Hare' },
  { code: 'SFO', lat: 37.6213, lon: -122.3790, name: 'San Francisco' },
  { code: 'SEA', lat: 47.4502, lon: -122.3088, name: 'Seattle' },
  { code: 'MIA', lat: 25.7959, lon: -80.2870, name: 'Miami' },
  { code: 'DFW', lat: 32.8998, lon: -97.0403, name: 'Dallas' },
  { code: 'ATL', lat: 33.6407, lon: -84.4277, name: 'Atlanta' },
  { code: 'BOS', lat: 42.3656, lon: -71.0096, name: 'Boston' },
  { code: 'DEN', lat: 39.8561, lon: -104.6737, name: 'Denver' },
  { code: 'PHX', lat: 33.4373, lon: -112.0078, name: 'Phoenix' },
  { code: 'IAH', lat: 29.9902, lon: -95.3368, name: 'Houston' },
];

function findNearestAirport(lat: number, lon: number): { code: string; name: string } {
  let nearest = AIRPORT_COORDS[0];
  let minDist = Infinity;

  for (const airport of AIRPORT_COORDS) {
    const dist = Math.sqrt(
      Math.pow(airport.lat - lat, 2) + Math.pow(airport.lon - lon, 2)
    );
    if (dist < minDist) {
      minDist = dist;
      nearest = airport;
    }
  }

  return { code: nearest.code, name: nearest.name };
}

export default function PriceTrendsPage() {
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState('JFK');
  const [destination, setDestination] = useState('DTW');
  const [tabValue, setTabValue] = useState(0);
  const [stopsFilter, setStopsFilter] = useState<StopsFilter>('cheapest');
  const [farePreference, setFarePreference] = useState<FarePreference>('');
  const [excludedAirlines, setExcludedAirlines] = useState<string[]>([]);
  const [showLocationPrompt, setShowLocationPrompt] = useState(false);
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);
  const [detectedAirport, setDetectedAirport] = useState<{ code: string; name: string } | null>(null);

  // Airport search states
  const [originInput, setOriginInput] = useState('JFK');
  const [destinationInput, setDestinationInput] = useState('DTW');
  const [originSuggestions, setOriginSuggestions] = useState<Airport[]>([]);
  const [destinationSuggestions, setDestinationSuggestions] = useState<Airport[]>([]);
  const [showOriginSuggestions, setShowOriginSuggestions] = useState(false);
  const [showDestinationSuggestions, setShowDestinationSuggestions] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  const originRef = useRef<HTMLDivElement>(null);
  const destinationRef = useRef<HTMLDivElement>(null);

  const filteredPrices = useMemo(() => {
    let filtered = prices;

    // Filter by excluded airlines
    if (excludedAirlines.length > 0) {
      filtered = filtered.filter(p => {
        const carrier = p.flightDetails?.carrier;
        if (!carrier) return true; // Keep if no carrier info
        // Extract airline code from carrier (e.g., "AA1234" -> "AA")
        const airlineCode = carrier.match(/^[A-Z]{2}/)?.[0];
        return !airlineCode || !excludedAirlines.includes(airlineCode);
      });
    }

    // Filter by stops
    if (stopsFilter !== 'cheapest') {
      filtered = filtered.filter(p => {
        const stops = p.flightDetails?.stops;
        if (stops === undefined) return false;

        if (stopsFilter === '3+') {
          return stops >= 3;
        }
        return stops === parseInt(stopsFilter, 10);
      });
    }

    return filtered;
  }, [prices, stopsFilter, excludedAirlines]);

  const chartTypes: ChartType[] = ['line', 'burn-down', 'draw-down'];
  const chartTitles = [
    'Price History',
    'Price Burn Down',
    'Price Draw Down'
  ];

  const handleTabChange = (newValue: number) => {
    setTabValue(newValue);
  };

  const handleAirlineExclusion = (airlineCode: string) => {
    setExcludedAirlines(prev => {
      if (prev.includes(airlineCode)) {
        return prev.filter(code => code !== airlineCode);
      } else {
        return [...prev, airlineCode];
      }
    });
  };

  // Search for airports using Amadeus API
  const searchAirports = async (keyword: string): Promise<Airport[]> => {
    if (keyword.length < 2) return [];

    try {
      setIsSearching(true);
      const response = await axios.get('/.netlify/functions/airport-search', {
        params: { keyword }
      });

      if (response.data && response.data.airports) {
        return response.data.airports;
      }
      return [];
    } catch (error) {
      console.error('Error searching airports:', error);
      return [];
    } finally {
      setIsSearching(false);
    }
  };

  // Handle origin input change
  const handleOriginInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase();
    setOriginInput(value);

    if (value.length >= 2) {
      const airports = await searchAirports(value);
      setOriginSuggestions(airports);
      setShowOriginSuggestions(true);
    } else {
      setOriginSuggestions([]);
      setShowOriginSuggestions(false);
    }
  };

  // Handle destination input change
  const handleDestinationInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase();
    setDestinationInput(value);

    if (value.length >= 2) {
      const airports = await searchAirports(value);
      setDestinationSuggestions(airports);
      setShowDestinationSuggestions(true);
    } else {
      setDestinationSuggestions([]);
      setShowDestinationSuggestions(false);
    }
  };

  // Select origin airport
  const handleSelectOrigin = (airport: Airport) => {
    setOriginInput(airport.iataCode);
    setOrigin(airport.iataCode);
    setShowOriginSuggestions(false);
  };

  // Select destination airport
  const handleSelectDestination = (airport: Airport) => {
    setDestinationInput(airport.iataCode);
    setDestination(airport.iataCode);
    setShowDestinationSuggestions(false);
  };

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (originRef.current && !originRef.current.contains(event.target as Node)) {
        setShowOriginSuggestions(false);
      }
      if (destinationRef.current && !destinationRef.current.contains(event.target as Node)) {
        setShowDestinationSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Check if we should show location prompt and load saved airport
  useEffect(() => {
    const savedAirport = localStorage.getItem('userHomeAirport');
    if (savedAirport) {
      setOrigin(savedAirport);
      setOriginInput(savedAirport);
    } else {
      setShowLocationPrompt(true);
    }
  }, []);

  const requestLocation = () => {
    if (!navigator.geolocation) {
      // Fallback if geolocation not supported
      setDetectedAirport({ code: 'JFK', name: 'New York JFK' });
      return;
    }

    setIsDetectingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const nearest = findNearestAirport(latitude, longitude);
        setDetectedAirport(nearest);
        setIsDetectingLocation(false);
      },
      () => {
        // On error or denial, default to JFK
        setDetectedAirport({ code: 'JFK', name: 'New York JFK' });
        setIsDetectingLocation(false);
      },
      { timeout: 10000 }
    );
  };

  const confirmDetectedAirport = () => {
    if (detectedAirport) {
      localStorage.setItem('userHomeAirport', detectedAirport.code);
      setOrigin(detectedAirport.code);
      setOriginInput(detectedAirport.code);
      setShowLocationPrompt(false);
      setDetectedAirport(null);
    }
  };

  const dismissLocationPrompt = () => {
    localStorage.setItem('userHomeAirport', 'JFK'); // Default to JFK
    setShowLocationPrompt(false);
    setDetectedAirport(null);
  };

  const fetchPriceTrends = async (from: string, to: string) => {
    try {
      setIsLoading(true);
      const response = await getPriceHistory(from, to);
      
      // Transform the prices array to match the expected format
      const formattedPrices = response.prices.map(item => ({
        price: item.price,
        recorded_at: item.date,
        flightDetails: item.flightDetails
      }));
      
      setPrices(formattedPrices);
      setError(null);
    } catch (err) {
      console.error('Error fetching price trends:', err);
      setError('Failed to load price trends. Please try again later.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPriceTrends(origin, destination);
  }, [origin, destination]);

  const handleUpdate = () => {
    if (originInput.length >= 3 && destinationInput.length >= 3) {
      // Update origin/destination state
      setOrigin(originInput);
      setDestination(destinationInput);
      // Always refresh price data (even if origin/destination unchanged)
      fetchPriceTrends(originInput, destinationInput);
    }
  };

  return (
    <div className="min-h-screen px-4 py-8 sm:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Price Trends</h1>
            <p className="text-sm text-slate-500">History and bands for your corridor</p>
          </div>
          <Link to="/" className="text-sm font-medium text-cyan-400/90 hover:text-cyan-300">
            ← Back home
          </Link>
        </div>
        
        {showLocationPrompt && (
          <div className="mb-6 rounded-xl border border-cyan-500/20 bg-slate-900/60 p-4 backdrop-blur-sm">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-cyan-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-cyan-200">Set your home airport</h3>
                <p className="mt-1 text-sm text-slate-400">
                  {detectedAirport
                    ? `We detected you're near ${detectedAirport.name} (${detectedAirport.code}). Use this as your home airport?`
                    : 'Allow location access to find your nearest airport.'}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {!detectedAirport && !isDetectingLocation && (
                    <button
                      onClick={requestLocation}
                      className="flex items-center rounded-md border border-transparent bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500"
                    >
                      <svg className="h-4 w-4 mr-2" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                      </svg>
                      Use My Location
                    </button>
                  )}
                  {isDetectingLocation && (
                    <div className="flex items-center text-sm text-slate-400">
                      <svg className="animate-spin h-4 w-4 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Detecting location...
                    </div>
                  )}
                  {detectedAirport && (
                    <>
                      <button
                        onClick={confirmDetectedAirport}
                        className="rounded-md border border-transparent bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500"
                      >
                        Yes, use {detectedAirport.code}
                      </button>
                      <button
                        onClick={() => setDetectedAirport(null)}
                        className="rounded-md border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-white/15"
                      >
                        Try again
                      </button>
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={dismissLocationPrompt}
                className="ml-4 text-slate-500 hover:text-cyan-400"
                title="Skip and use default (JFK)"
              >
                <svg className="h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          </div>
        )}

        <div className="surface-paper p-6">
          <div className="mb-6">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
              {/* Origin Input with Autocomplete */}
              <div ref={originRef} className="relative">
                <label htmlFor="origin" className="block text-sm font-medium text-gray-700 mb-1">From</label>
                <input
                  type="text"
                  id="origin"
                  value={originInput}
                  onChange={handleOriginInputChange}
                  onFocus={() => originInput.length >= 2 && setShowOriginSuggestions(true)}
                  placeholder="City or IATA code (e.g., JFK, NYC)"
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500 text-sm"
                />
                {showOriginSuggestions && originSuggestions.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-auto">
                    {originSuggestions.map((airport) => (
                      <div
                        key={airport.iataCode}
                        className="px-4 py-2 hover:bg-gray-100 cursor-pointer"
                        onClick={() => handleSelectOrigin(airport)}
                      >
                        <div className="font-medium text-sm">{airport.iataCode}</div>
                        <div className="text-xs text-gray-500">
                          {airport.name}
                          {airport.cityName && `, ${airport.cityName}`}
                          {airport.countryName && `, ${airport.countryName}`}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Destination Input with Autocomplete */}
              <div ref={destinationRef} className="relative">
                <label htmlFor="destination" className="block text-sm font-medium text-gray-700 mb-1">To</label>
                <input
                  type="text"
                  id="destination"
                  value={destinationInput}
                  onChange={handleDestinationInputChange}
                  onFocus={() => destinationInput.length >= 2 && setShowDestinationSuggestions(true)}
                  placeholder="City or IATA code (e.g., LHR, London)"
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500 text-sm"
                />
                {showDestinationSuggestions && destinationSuggestions.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-auto">
                    {destinationSuggestions.map((airport) => (
                      <div
                        key={airport.iataCode}
                        className="px-4 py-2 hover:bg-gray-100 cursor-pointer"
                        onClick={() => handleSelectDestination(airport)}
                      >
                        <div className="font-medium text-sm">{airport.iataCode}</div>
                        <div className="text-xs text-gray-500">
                          {airport.name}
                          {airport.cityName && `, ${airport.cityName}`}
                          {airport.countryName && `, ${airport.countryName}`}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Stops Filter */}
              <div>
                <label htmlFor="stops" className="block text-sm font-medium text-gray-700 mb-1">Stops</label>
                <select
                  id="stops"
                  value={stopsFilter}
                  onChange={(e) => setStopsFilter(e.target.value as StopsFilter)}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500 text-sm"
                >
                  <option value="cheapest">Cheapest</option>
                  <option value="0">Nonstop</option>
                  <option value="1">1 Stop</option>
                  <option value="2">2 Stops</option>
                  <option value="3+">3+ Stops</option>
                </select>
              </div>

              {/* Fare Preference */}
              <div>
                <label htmlFor="farePreference" className="block text-sm font-medium text-gray-700 mb-1">Fare Type</label>
                <select
                  id="farePreference"
                  value={farePreference}
                  onChange={(e) => setFarePreference(e.target.value as FarePreference)}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                >
                  {farePreferenceOptions.map(({ code, name }) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleUpdate}
                  disabled={isLoading || isSearching}
                  className={`w-full inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white ${
                    isLoading || isSearching ? 'bg-cyan-400' : 'bg-cyan-600 hover:bg-cyan-500'
                  } focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500`}
                >
                  {isLoading ? 'Loading...' : 'Update Chart'}
                </button>
              </div>
            </div>

            {/* Airline Exclusions */}
            <div className="flex flex-wrap items-center gap-4 pt-4 border-t border-gray-200">
              <span className="text-sm font-medium text-gray-700">Exclude Airlines:</span>
              {excludableAirlines.map(({ code, name }) => (
                <label key={code} className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={excludedAirlines.includes(code)}
                    onChange={() => handleAirlineExclusion(code)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="text-sm text-gray-700">{name} ({code})</span>
                </label>
              ))}
            </div>
            
            <div className="mt-6">
              <div className="border-b border-gray-200">
                <nav className="flex -mb-px" aria-label="Chart types">
                  {chartTypes.map((type, index) => (
                    <button
                      key={type}
                      onClick={() => handleTabChange(index)}
                      className={`py-4 px-6 text-center border-b-2 font-medium text-sm ${
                        tabValue === index
                          ? 'border-cyan-500 text-cyan-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                      }`}
                      id={`${type}-tab`}
                      aria-controls={`${type}-panel`}
                      role="tab"
                      type="button"
                    >
                      {chartTitles[index]}
                    </button>
                  ))}
                </nav>
              </div>
              
              {chartTypes.map((type, index) => (
                <TabPanel
                  key={type}
                  id={`${type}-panel`}
                  isActive={tabValue === index}
                >
                  <div className="h-96">
                    {isLoading ? (
                      <div className="flex items-center justify-center h-full">
                        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-cyan-500"></div>
                      </div>
                    ) : error ? (
                      <div className="bg-red-50 border-l-4 border-red-400 p-4">
                        <div className="flex">
                          <div className="flex-shrink-0">
                            <svg className="h-5 w-5 text-red-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                            </svg>
                          </div>
                          <div className="ml-3">
                            <p className="text-sm text-red-700">{error}</p>
                          </div>
                        </div>
                      </div>
                    ) : filteredPrices.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-gray-500">
                        No flights found with {stopsFilter === '0' ? 'nonstop' : stopsFilter === '3+' ? '3+ stops' : `${stopsFilter} stop${stopsFilter === '1' ? '' : 's'}`}
                      </div>
                    ) : (
                      <PriceHistoryChart
                        prices={filteredPrices}
                        loading={isLoading}
                        chartType={type}
                        title={chartTitles[index]}
                      />
                    )}
                  </div>
                </TabPanel>
              ))}
          </div>
          </div>

          {/* Google Flights Quick Links */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">Book on Google Flights</h3>
              <a
                href={generateGoogleFlightsExploreUrl(origin, destination)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
              >
                <svg className="h-4 w-4 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Search {origin} → {destination}
              </a>
            </div>

            {/* Flight List with Links */}
            {filteredPrices.length > 0 && (
              <div
                className="bg-gray-50 rounded-lg p-4"
                key={`flights-container-${origin}-${destination}-${stopsFilter}-${excludedAirlines.join(',')}-${filteredPrices.length}`}
              >
                <h4 className="text-sm font-medium text-gray-700 mb-3">Recent Price Points (click to book)</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {filteredPrices.slice(0, 6).map((pricePoint, index) => {
                    const date = pricePoint.flightDetails?.departureTime
                      ? new Date(pricePoint.flightDetails.departureTime)
                      : new Date(pricePoint.recorded_at);
                    const googleFlightsUrl = generateGoogleFlightsUrl(origin, destination, date);

                    return (
                      <a
                        key={`${origin}-${destination}-${stopsFilter}-${excludedAirlines.join(',')}-${pricePoint.recorded_at}-${pricePoint.price}-${index}`}
                        href={googleFlightsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between p-3 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all"
                      >
                        <div>
                          <div className="text-sm font-medium text-gray-900">
                            {date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                          </div>
                          {pricePoint.flightDetails?.flightNumber && (
                            <div className="text-xs text-gray-500">
                              {pricePoint.flightDetails.flightNumber}
                              {pricePoint.flightDetails.stops !== undefined && (
                                <span className="ml-2">
                                  {pricePoint.flightDetails.stops === 0 ? 'Nonstop' : `${pricePoint.flightDetails.stops} stop${pricePoint.flightDetails.stops > 1 ? 's' : ''}`}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center">
                          <span className="text-lg font-bold text-green-600">${pricePoint.price}</span>
                          <svg className="ml-2 h-4 w-4 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

        </div>

        {/* Passenger Form Section */}
        <div className="mt-8">
          <PassengerForm origin={origin} destination={destination} />
        </div>
      </div>
    </div>
  );
}
