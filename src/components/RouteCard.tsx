import * as React from 'react';
import { MapPinIcon, ClockIcon, ArrowRightIcon, TrendingDownIcon, ExternalLinkIcon } from 'lucide-react';
import { PriceChart } from './PriceChart';
import { FlightDetails } from '../services/api';
import {
  ALL_CARRIERS_KEY,
  filterByCarrier,
  getUniqueCarriers,
  lowestPricePerDate,
} from '../utils/carrierPrices';
// Helper function to generate a Google Flights URL with preset origin, destination, one-way, and economy
const getGoogleFlightsUrl = (from: string, to: string): string => {
  // Get tomorrow's date for the departure (gives more search options than today)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const departDate = tomorrow.toISOString().split('T')[0];

  // Build the URL using Google Flights query string format
  // Format: "Flights from [origin] to [destination] on [date] one way economy"
  const query = `Flights from ${from} to ${to} on ${departDate} one way economy`;

  const params = new URLSearchParams({
    hl: 'en',
    gl: 'us',
    curr: 'USD',
    q: query,
  });

  return `https://www.google.com/travel/flights?${params.toString()}`;
};

interface RouteCardProps {
  route: {
    id: string;
    from: string;
    to: string;
    basePrice: number;
    prices: Array<{ date: string | Date; price: number; flightDetails?: FlightDetails }>;
    distance: string;
    duration: string;
  };
  onLoad?: () => void;
}

export const RouteCard: React.FC<RouteCardProps> = ({
  route,
  onLoad
}) => {
  // Call onLoad when the component mounts
  const isMounted = React.useRef(false);
  
  React.useEffect(() => {
    if (onLoad && !isMounted.current) {
      isMounted.current = true;
      onLoad();
    }
  }, [onLoad]);
  const {
    from,
    to,
    basePrice,
    prices,
    distance,
    duration
  } = route;

  const [carrier, setCarrier] = React.useState<string>(ALL_CARRIERS_KEY);
  const carriers = React.useMemo(() => getUniqueCarriers(prices), [prices]);
  const displayedPrices = React.useMemo(() => {
    const filtered = filterByCarrier(prices, carrier);
    // Even when filtered to one carrier, multiple offers may share a date — keep cheapest.
    return lowestPricePerDate(filtered);
  }, [prices, carrier]);

  const lowestPrice = displayedPrices.length
    ? Math.min(...displayedPrices.map(p => p.price))
    : 0;
  const highestPrice = displayedPrices.length
    ? Math.max(...displayedPrices.map(p => p.price))
    : 0;
  const savings = basePrice - lowestPrice;
  return <div className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
      <div className="flex flex-col space-y-4">
        <div className="flex justify-between items-start">
          <div>
            <div className="flex items-center space-x-2">
              <MapPinIcon className="h-5 w-5 text-blue-600" />
              <h3 className="text-lg font-semibold text-gray-800">
                {from} <ArrowRightIcon className="inline h-4 w-4 mx-1" /> {to}
              </h3>
            </div>
            <div className="flex items-center text-sm text-gray-600 mt-1">
              <ClockIcon className="h-4 w-4 mr-1" />
              <span>{duration}</span>
              <span className="mx-2">•</span>
              <span>{distance}</span>
            </div>
            <a 
              href={getGoogleFlightsUrl(from, to)} 
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center text-xs text-blue-600 mt-2 hover:text-blue-800 transition-colors"
            >
              <ExternalLinkIcon className="h-3 w-3 mr-1" />
              View on Google Flights
            </a>
          </div>
          <div className="bg-green-50 px-4 py-2 rounded-lg">
            <div className="flex items-center text-green-700">
              <TrendingDownIcon className="h-4 w-4 mr-1" />
              <span className="text-sm font-medium">Best Deal</span>
            </div>
            <div className="text-xl font-bold text-green-800">
              ${lowestPrice}
            </div>
            {savings > 0 && <div className="text-xs text-green-600">Save ${savings}</div>}
          </div>
        </div>
        {carriers.length > 1 && (
          <div className="flex items-center justify-end text-xs text-gray-600">
            <label htmlFor={`carrier-${route.id}`} className="mr-2">Carrier</label>
            <select
              id={`carrier-${route.id}`}
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              className="border border-gray-200 rounded px-2 py-1 bg-white"
              data-testid="carrier-slicer"
            >
              <option value={ALL_CARRIERS_KEY}>All ({carriers.length})</option>
              {carriers.map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
          </div>
        )}
        <div className="h-52 mt-2">
          <PriceChart prices={displayedPrices} basePrice={basePrice} lowestPrice={lowestPrice} highestPrice={highestPrice} />
        </div>
      </div>
    </div>;
};