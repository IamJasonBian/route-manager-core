import { useState, useEffect, useRef, useCallback } from 'react';
import { ExternalLink, Loader2, Plane, Search } from 'lucide-react';
import axios from 'axios';
import { useLivePolling } from '../hooks/useLivePolling';
import LiveStatusIndicator from '../components/LiveStatusIndicator';
import PageHeader from '../components/ui/PageHeader';
import AirportField, { type Airport } from '../components/ui/AirportField';

interface Flight {
  id: string;
  departure: {
    iataCode: string;
    at: string;
  };
  arrival: {
    iataCode: string;
    at: string;
  };
  itineraries: Array<{
    segments: Array<{
      departure: {
        iataCode: string;
        at: string;
      };
      arrival: {
        iataCode: string;
        at: string;
      };
      carrierCode: string;
      number: string;
      aircraft: {
        code: string;
      };
    }>;
  }>;
  price: {
    total: string;
    currency: string;
  };
  travelerPricings: Array<{
    fareDetailsBySegment: Array<{
      cabin: string;
      class: string;
    }>;
  }>;
}

export default function SearchFlightsPage() {
  const [origin, setOrigin] = useState('JFK');
  const [destination, setDestination] = useState('LAX');
  const [departureDate, setDepartureDate] = useState(new Date().toISOString().split('T')[0]);
  const [returnDate, setReturnDate] = useState('');
  const [tripType, setTripType] = useState<'one-way' | 'round-trip'>('one-way');
  const [isSearching, setIsSearching] = useState(false);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const lastSearchParamsRef = useRef<{
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    tripType: 'one-way' | 'round-trip';
  } | null>(null);

  // Airport search states
  const [originInput, setOriginInput] = useState('JFK');
  const [destinationInput, setDestinationInput] = useState('LAX');
  const [originSuggestions, setOriginSuggestions] = useState<Airport[]>([]);
  const [destinationSuggestions, setDestinationSuggestions] = useState<Airport[]>([]);
  const [showOriginSuggestions, setShowOriginSuggestions] = useState(false);
  const [showDestinationSuggestions, setShowDestinationSuggestions] = useState(false);
  const [isLoadingAirports, setIsLoadingAirports] = useState(false);

  const originRef = useRef<HTMLDivElement>(null);
  const destinationRef = useRef<HTMLDivElement>(null);
  
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };
  
  const formatDuration = (start: string, end: string) => {
    const diff = new Date(end).getTime() - new Date(start).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  };

  // Airline name mapping
  const getAirlineName = (carrierCode: string): string => {
    const airlines: { [key: string]: string } = {
      'AA': 'American Airlines',
      'DL': 'Delta Air Lines',
      'UA': 'United Airlines',
      'WN': 'Southwest Airlines',
      'B6': 'JetBlue Airways',
      'AS': 'Alaska Airlines',
      'NK': 'Spirit Airlines',
      'F9': 'Frontier Airlines',
      'G4': 'Allegiant Air',
      'TP': 'TAP Portugal',
      'BA': 'British Airways',
      'LH': 'Lufthansa',
      'AF': 'Air France',
      'KL': 'KLM Royal Dutch Airlines',
      'IB': 'Iberia',
      'AZ': 'ITA Airways',
      'EI': 'Aer Lingus',
      'LX': 'Swiss International Air Lines',
      'OS': 'Austrian Airlines',
      'SN': 'Brussels Airlines',
      'TK': 'Turkish Airlines',
      'EK': 'Emirates',
      'QR': 'Qatar Airways',
      'EY': 'Etihad Airways',
      'SV': 'Saudia',
      'AC': 'Air Canada',
      'NH': 'All Nippon Airways',
      'JL': 'Japan Airlines',
      'SQ': 'Singapore Airlines',
      'CX': 'Cathay Pacific',
      'QF': 'Qantas',
      'NZ': 'Air New Zealand'
    };
    return airlines[carrierCode] || carrierCode;
  };

  // Generate Google Flights booking link with one-way and economy preset
  const getBookingLink = (flight: Flight): string => {
    const dep = flight.itineraries[0].segments[0];
    const arr = flight.itineraries[0].segments[flight.itineraries[0].segments.length - 1];
    const depDate = dep.departure.at.split('T')[0];

    const origin = dep.departure.iataCode;
    const destination = arr.arrival.iataCode;

    // Build URL using Google Flights query string format
    const query = `Flights from ${origin} to ${destination} on ${depDate} one way economy`;
    const params = new URLSearchParams({
      hl: 'en',
      gl: 'us',
      curr: 'USD',
      q: query,
    });

    return `https://www.google.com/travel/flights?${params.toString()}`;
  };

  // Search for airports using Amadeus API
  const searchAirports = async (keyword: string): Promise<Airport[]> => {
    if (keyword.length < 2) return [];

    try {
      setIsLoadingAirports(true);
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
      setIsLoadingAirports(false);
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

  const fetchFlights = async (
    params: {
      origin: string;
      destination: string;
      departureDate: string;
      returnDate?: string;
      tripType: 'one-way' | 'round-trip';
    },
    options: { silent?: boolean } = {}
  ) => {
    const { silent = false } = options;
    if (!silent) {
      setIsSearching(true);
      setError(null);
    }

    try {
      const response = await axios.post('/.netlify/functions/search-flights', {
        origin: params.origin.toUpperCase(),
        destination: params.destination.toUpperCase(),
        departureDate: params.departureDate,
        returnDate: params.tripType === 'round-trip' ? params.returnDate : undefined,
        maxResults: 10,
        nonStop: false
      });

      if (response.data && response.data.data) {
        setFlights(response.data.data);
        setError(null);
      } else if (!silent) {
        setError('No flights found. Please try different search criteria.');
        setFlights([]);
      }
    } catch (err) {
      console.error('Error searching flights:', err);
      if (!silent) {
        setError('Failed to search for flights. Please try again later.');
        setFlights([]);
      }
    } finally {
      if (!silent) setIsSearching(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Typed codes count even when no suggestion was picked.
    const from = originInput.trim() || origin;
    const to = destinationInput.trim() || destination;
    setOrigin(from);
    setDestination(to);

    if (!from || !to || !departureDate || (tripType === 'round-trip' && !returnDate)) {
      setError('Please fill in all required fields');
      return;
    }

    const params = { origin: from, destination: to, departureDate, returnDate, tripType };
    lastSearchParamsRef.current = params;
    setHasSearched(true);
    await fetchFlights(params);
    markUpdated();
  };

  const pollFetcher = useCallback(async () => {
    if (isSearching) return;
    if (!lastSearchParamsRef.current) return;
    await fetchFlights(lastSearchParamsRef.current, { silent: true });
  }, [isSearching]);

  const { isRefreshing, lastUpdated, markUpdated } = useLivePolling({
    enabled: hasSearched,
    intervalMs: 5000,
    fetcher: pollFetcher,
  });

  const today = new Date().toISOString().split('T')[0];

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <PageHeader eyebrow="Live offers" title="Search flights" subtitle="Shop fares for your route and dates." />

      <form onSubmit={handleSearch} className="panel mt-6 p-5 sm:p-6">
        <div className="segmented" role="group" aria-label="Trip type">
          <button type="button" aria-pressed={tripType === 'one-way'} onClick={() => setTripType('one-way')}>
            One way
          </button>
          <button type="button" aria-pressed={tripType === 'round-trip'} onClick={() => setTripType('round-trip')}>
            Round trip
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end">
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
            <label htmlFor="departureDate" className="field-label">Departure</label>
            <input
              type="date"
              id="departureDate"
              className="input"
              required
              value={departureDate}
              onChange={(e) => setDepartureDate(e.target.value)}
              min={today}
            />
          </div>
          <div>
            <label htmlFor="returnDate" className="field-label">Return</label>
            <input
              type="date"
              id="returnDate"
              className="input"
              disabled={tripType !== 'round-trip'}
              required={tripType === 'round-trip'}
              value={tripType === 'round-trip' ? returnDate : ''}
              onChange={(e) => setReturnDate(e.target.value)}
              min={departureDate || today}
            />
          </div>
          <button type="submit" disabled={isSearching || isLoadingAirports} className="btn-primary h-[38px] sm:col-span-2 lg:col-span-1">
            {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {isSearching ? 'Searching…' : 'Search'}
          </button>
        </div>

        {error && <p className="alert-error mt-4">{error}</p>}
      </form>

      <section className="mt-8" aria-labelledby="results-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h2 id="results-heading" className="whitespace-nowrap text-sm font-medium text-slate-300">
            {flights.length > 0 ? `${flights.length} offers` : 'Results'}
          </h2>
          {hasSearched && <LiveStatusIndicator isRefreshing={isRefreshing} lastUpdated={lastUpdated} intervalMs={5000} />}
        </div>

        {isSearching ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="panel h-28 animate-pulse" />
            ))}
          </div>
        ) : flights.length > 0 ? (
          <ul className="space-y-3">
            {flights.map((flight, index) => (
              <FlightCard
                key={flight.id ?? index}
                flight={flight}
                airline={getAirlineName(flight.itineraries[0].segments[0].carrierCode)}
                bookingLink={getBookingLink(flight)}
                formatDate={formatDate}
                formatDuration={formatDuration}
              />
            ))}
          </ul>
        ) : (
          <div className="panel flex flex-col items-center px-6 py-12 text-center">
            <Plane className="h-8 w-8 text-slate-600" aria-hidden />
            <p className="mt-3 text-sm font-medium text-slate-300">{hasSearched ? 'No flights found' : 'No search yet'}</p>
            <p className="mt-1 text-sm text-slate-500">
              {hasSearched ? 'Try other dates or nearby airports.' : 'Pick a route and date, then search.'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function FlightCard({
  flight,
  airline,
  bookingLink,
  formatDate,
  formatDuration,
}: {
  flight: Flight;
  airline: string;
  bookingLink: string;
  formatDate: (d: string) => string;
  formatDuration: (a: string, b: string) => string;
}) {
  const segments = flight.itineraries[0].segments;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const stops = segments.length - 1;
  const cabin = flight.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.cabin ?? '';

  return (
    <li className="panel group flex flex-col gap-4 p-4 transition hover:border-cyan-400/30 sm:flex-row sm:items-center sm:p-5">
      <div className="flex min-w-0 flex-1 items-center gap-4 sm:gap-6">
        <div className="text-left">
          <p className="font-mono text-lg font-semibold text-white">{first.departure.iataCode}</p>
          <p className="text-xs text-slate-500">{formatDate(first.departure.at)}</p>
        </div>
        <div className="flex flex-1 flex-col items-center text-xs text-slate-500">
          <span>{formatDuration(first.departure.at, last.arrival.at)}</span>
          <span className="my-1 h-px w-full bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          <span className={stops === 0 ? 'text-emerald-400' : ''}>
            {stops === 0 ? 'Nonstop' : `${stops} stop${stops > 1 ? 's' : ''} · ${segments.slice(0, -1).map((s) => s.arrival.iataCode).join(', ')}`}
          </span>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg font-semibold text-white">{last.arrival.iataCode}</p>
          <p className="text-xs text-slate-500">{formatDate(last.arrival.at)}</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-white/5 pt-3 sm:w-64 sm:flex-col sm:items-end sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
        <div className="sm:text-right">
          <p className="text-xl font-semibold text-white">${parseFloat(flight.price.total).toFixed(0)}</p>
          <p className="text-xs text-slate-500">
            {airline} · {first.carrierCode}
            {first.number}
            {cabin && ` · ${cabin.charAt(0)}${cabin.slice(1).toLowerCase()}`}
          </p>
        </div>
        <a href={bookingLink} target="_blank" rel="noopener noreferrer" className="btn-ghost">
          View fare <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </li>
  );
}
