/**
 * Kiwi.com public flight search — replacement source for the decommissioned
 * Amadeus Self-Service API (keys disabled 2026-07-17).
 *
 * Talks JSON-RPC to Kiwi's public, credential-less MCP endpoint and calls its
 * `search-flight` tool directly. Results can be returned raw (Kiwi itineraries)
 * or mapped into the Amadeus FlightOffer shape the frontend already renders.
 */

export const KIWI_MCP_URL = process.env.KIWI_MCP_URL || 'https://mcp.kiwi.com/';

let rpcId = 0;

/** Parse an MCP response body that may be plain JSON or an SSE stream. */
function parseRpcBody(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  if (!dataLines.length) throw new Error(`Kiwi MCP: unparseable response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(dataLines[dataLines.length - 1]);
}

async function rpc(method, params, { timeoutMs = 45000 } = {}) {
  const res = await fetch(KIWI_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Kiwi MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
  const msg = parseRpcBody(text);
  if (msg.error) throw new Error(`Kiwi MCP error ${msg.error.code}: ${msg.error.message}`);
  return msg.result;
}

/** YYYY-MM-DD → dd/mm/yyyy (Kiwi's date format). */
export const toKiwiDate = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

/**
 * Search one-way or return flights on Kiwi.
 * @param {{ origin: string, destination: string, departureDate: string, returnDate?: string,
 *   adults?: number, nonStop?: boolean, maxPrice?: number, currency?: string,
 *   cabinClass?: 'M'|'W'|'C'|'F', sort?: string }} params  dates are YYYY-MM-DD
 * @returns {Promise<{ currency: string, itineraries: object[] }>}
 */
export async function searchKiwi(params) {
  const args = {
    flyFrom: params.origin,
    flyTo: params.destination,
    departureDate: toKiwiDate(params.departureDate),
    adults: Number(params.adults || 1),
    currency: params.currency || 'USD',
    sort: params.sort || 'price',
    ...(params.returnDate && { returnDate: toKiwiDate(params.returnDate) }),
    ...(params.nonStop && { max_sector_stopovers: 0 }),
    ...(params.maxPrice && { price_to: Math.floor(Number(params.maxPrice)) }),
    ...(params.cabinClass && { cabinClass: params.cabinClass }),
  };

  const result = await rpc('tools/call', { name: 'search-flight', arguments: args });
  if (result.isError) {
    const text = result.content?.map((c) => c.text).join(' ') || 'unknown error';
    throw new Error(`Kiwi search-flight failed: ${text}`);
  }
  const payload =
    result.structuredContent ??
    JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? '{}');
  return { currency: payload.currency || args.currency, itineraries: payload.itineraries || [] };
}

/** Seconds → ISO-8601 duration (PT2H5M), as Amadeus returns it. */
const isoDuration = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `PT${h ? `${h}H` : ''}${m || !h ? `${m}M` : ''}`;
};

function toAmadeusItinerary(leg) {
  return {
    duration: isoDuration(leg.durationSeconds || 0),
    segments: (leg.segments || []).map((seg, i) => ({
      departure: { iataCode: seg.from, at: seg.departureTime ?? (i === 0 ? leg.departureTime : undefined) },
      arrival: {
        iataCode: seg.to,
        at: seg.arrivalTime ?? (i === leg.segments.length - 1 ? leg.arrivalTime : undefined),
      },
      carrierCode: seg.carrier,
      number: String(seg.flightNumber ?? '').replace(/^[A-Z0-9]{2}(?=\d)/, ''),
      numberOfStops: 0,
    })),
  };
}

/**
 * Map a Kiwi itinerary into the Amadeus FlightOffer shape consumed by the UI,
 * the plan-nyc-mich MCP and the price loaders. Kiwi-only fields ride along
 * under `source`/`bookingUrl`.
 */
export function toAmadeusOffer(it, index, currency = 'USD') {
  const total = Number(it.price).toFixed(2);
  const legs = [it.outbound, it.inbound].filter(Boolean);
  const carriers = [...new Set(legs.flatMap((l) => l.segments.map((s) => s.carrier)))];
  return {
    type: 'flight-offer',
    id: String(index + 1),
    source: 'KIWI',
    oneWay: !it.inbound,
    numberOfBookableSeats: undefined,
    itineraries: legs.map(toAmadeusItinerary),
    price: { currency, total, base: total, grandTotal: total },
    validatingAirlineCodes: carriers.slice(0, 1),
    bookingUrl: it.bookingUrl,
    baggage: it.baggage,
  };
}
