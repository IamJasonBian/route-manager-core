import { useState, useEffect, useRef, useMemo } from 'react';
import { Loader2, MapPin, RefreshCw, X } from 'lucide-react';
import axios from 'axios';
import PriceHistoryChart, { ChartType } from '../components/PriceHistoryChart';
import { getPriceHistory } from '../services/api';
import PageHeader from '../components/ui/PageHeader';
import AirportField, { type Airport } from '../components/ui/AirportField';

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
      className={`pt-4 ${isActive ? 'block' : 'hidden'}`}
      aria-labelledby={`${id}-tab`}
    >
      {children}
    </div>
  );
}

type StopsFilter = 'cheapest' | '0' | '1' | '2' | '3+';

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
    if (stopsFilter === 'cheapest') {
      return prices;
    }

    return prices.filter(p => {
      const stops = p.flightDetails?.stops;
      if (stops === undefined) return false;

      if (stopsFilter === '3+') {
        return stops >= 3;
      }
      return stops === parseInt(stopsFilter, 10);
    });
  }, [prices, stopsFilter]);

  // Headline numbers above the chart: where today sits against the window.
  const stats = useMemo(() => {
    if (filteredPrices.length === 0) return null;
    const values = filteredPrices.map((p) => p.price);
    const latest = values[values.length - 1];
    const low = Math.min(...values);
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    const vsAvg = ((latest - avg) / avg) * 100;
    const usd = (v: number) => `$${Math.round(v)}`;
    return [
      { label: 'Latest', value: usd(latest) },
      { label: 'Low', value: usd(low), tone: 'text-emerald-300' },
      { label: 'Average', value: usd(avg) },
      {
        label: 'Latest vs avg',
        value: `${vsAvg > 0 ? '+' : ''}${vsAvg.toFixed(1)}%`,
        tone: vsAvg > 0 ? 'text-rose-300' : 'text-emerald-300',
      },
    ];
  }, [filteredPrices]);

  const chartTypes: ChartType[] = ['line', 'burn-down', 'draw-down'];
  const chartTitles = [
    'History',
    'Burn down',
    'Draw down'
  ];

  const handleTabChange = (newValue: number) => {
    setTabValue(newValue);
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
      setOrigin(originInput);
      setDestination(destinationInput);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <PageHeader eyebrow="Price history" title="Trends" subtitle="Is today's fare noise or signal? History and drawdowns for one route." />

      {showLocationPrompt && (
        <div className="panel mt-6 flex items-start gap-3 border-cyan-400/20 p-4">
          <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-cyan-400" aria-hidden />
          <div className="flex-1">
            <p className="text-sm font-medium text-white">Set your home airport</p>
            <p className="mt-0.5 text-sm text-slate-400">
              {detectedAirport
                ? `You look close to ${detectedAirport.name} (${detectedAirport.code}). Use it as your home airport?`
                : 'Share your location to pick the nearest airport.'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {!detectedAirport && !isDetectingLocation && (
                <button onClick={requestLocation} className="btn-primary">
                  <MapPin className="h-4 w-4" /> Use my location
                </button>
              )}
              {isDetectingLocation && (
                <span className="flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Finding you…
                </span>
              )}
              {detectedAirport && (
                <>
                  <button onClick={confirmDetectedAirport} className="btn-primary">
                    Use {detectedAirport.code}
                  </button>
                  <button onClick={() => setDetectedAirport(null)} className="btn-ghost">
                    Try again
                  </button>
                </>
              )}
            </div>
          </div>
          <button
            onClick={dismissLocationPrompt}
            className="rounded-md p-1 text-slate-500 hover:bg-white/5 hover:text-white"
            title="Skip and use JFK"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <section className="panel mt-6 p-5 sm:p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
          <AirportField
            id="origin"
            label="From"
            placeholder="JFK, NYC…"
            containerRef={originRef}
            value={originInput}
            onChange={handleOriginInputChange}
            onFocus={() => originInput.length >= 2 && setShowOriginSuggestions(true)}
            suggestions={showOriginSuggestions ? originSuggestions : []}
            onSelect={handleSelectOrigin}
          />
          <AirportField
            id="destination"
            label="To"
            placeholder="DTW, Detroit…"
            containerRef={destinationRef}
            value={destinationInput}
            onChange={handleDestinationInputChange}
            onFocus={() => destinationInput.length >= 2 && setShowDestinationSuggestions(true)}
            suggestions={showDestinationSuggestions ? destinationSuggestions : []}
            onSelect={handleSelectDestination}
          />
          <div>
            <label htmlFor="stops" className="field-label">Stops</label>
            <select
              id="stops"
              value={stopsFilter}
              onChange={(e) => setStopsFilter(e.target.value as StopsFilter)}
              className="input"
            >
              <option value="cheapest">Cheapest</option>
              <option value="0">Nonstop</option>
              <option value="1">1 stop</option>
              <option value="2">2 stops</option>
              <option value="3+">3+ stops</option>
            </select>
          </div>
          <button
            type="button"
            onClick={handleUpdate}
            disabled={isLoading || isSearching}
            className="btn-primary h-[38px] sm:col-span-2 lg:col-span-1"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Update
          </button>
        </div>

        {stats && (
          <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/5 sm:grid-cols-4">
            {stats.map((st) => (
              <div key={st.label} className="bg-slate-950/60 px-4 py-3">
                <dt className="eyebrow">{st.label}</dt>
                <dd className={`mt-1 text-lg font-semibold ${st.tone ?? 'text-white'}`}>{st.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="mt-6">
          <div className="segmented" role="tablist" aria-label="Chart types">
            {chartTypes.map((type, index) => (
              <button
                key={type}
                onClick={() => handleTabChange(index)}
                aria-pressed={tabValue === index}
                aria-selected={tabValue === index}
                aria-controls={`${type}-panel`}
                id={`${type}-tab`}
                role="tab"
                type="button"
              >
                {chartTitles[index]}
              </button>
            ))}
          </div>

          {chartTypes.map((type, index) => (
            <TabPanel key={type} id={`${type}-panel`} isActive={tabValue === index}>
              <div className="h-96">
                {isLoading ? (
                  <div className="h-full animate-pulse rounded-xl bg-white/[0.03]" />
                ) : error ? (
                  <p className="alert-error">{error}</p>
                ) : filteredPrices.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-slate-500">
                    No fares recorded with {stopsFilter === '0' ? 'nonstop' : stopsFilter === '3+' ? '3+ stops' : `${stopsFilter} stop${stopsFilter === '1' ? '' : 's'}`}
                  </div>
                ) : (
                  <PriceHistoryChart prices={filteredPrices} loading={isLoading} chartType={type} title={chartTitles[index]} />
                )}
              </div>
            </TabPanel>
          ))}
        </div>
      </section>
    </div>
  );
}
