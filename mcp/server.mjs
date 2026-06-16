#!/usr/bin/env node
// MCP server: flight price lookups for the route-manager project.
//
// AUTH: this server is intentionally credential-less. It proxies to the
// deployed Netlify function `search-flights`, which holds the Amadeus API
// key/secret in its environment (AMADEUS_API_KEY / AMADEUS_API_SECRET, set
// per-site in the Netlify UI — see netlify/functions/search-flights.js).
// Override the endpoint with the ROUTE_MANAGER_ENDPOINT env var if needed.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const ENDPOINT =
  process.env.ROUTE_MANAGER_ENDPOINT ||
  'https://route-manager-prod.netlify.app/.netlify/functions/search-flights';

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
const iso = (d) => d.toISOString().slice(0, 10);
const dayLabel = (s) =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(s + 'T00:00:00Z').getUTCDay()
  ];

function googleFlightsUrl(origin, destination, date) {
  return `https://www.google.com/travel/flights?q=One-way%20flights%20from%20${origin}%20to%20${destination}%20on%20${date}`;
}

async function fetchCheapest(origin, destination, departureDate, maxResults = 5) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin,
      destination,
      departureDate,
      adults: 1,
      nonStop: false,
      maxResults,
    }),
  });
  if (!res.ok) throw new Error(`Netlify function returned HTTP ${res.status}`);
  const json = await res.json();
  const offers = json.data || [];
  const prices = offers
    .map((o) => parseFloat(o.price?.grandTotal ?? o.price?.total))
    .filter(Number.isFinite);
  return {
    price: prices.length ? Math.min(...prices) : null,
    offerCount: offers.length,
  };
}

function weekendDatesFromToday(weeks) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dow = today.getUTCDay();
  const daysToSat = ((6 - dow + 7) % 7) || 7;
  const firstSat = addDays(today, daysToSat);
  const dates = [];
  for (let w = 0; w < weeks; w++) {
    const sat = addDays(firstSat, 7 * w);
    dates.push(iso(sat), iso(addDays(sat, 1)));
  }
  return dates;
}

function weeklyDatesFromToday(weeks) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: weeks }, (_, i) => iso(addDays(today, 7 * (i + 1))));
}

const server = new Server(
  { name: 'route-manager-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'flight_price',
      description:
        'Get the cheapest one-way flight price for a specific route on a specific date (via Amadeus through the deployed route-manager Netlify function).',
      inputSchema: {
        type: 'object',
        required: ['origin', 'destination', 'departureDate'],
        properties: {
          origin: { type: 'string', description: 'IATA airport or city code (e.g. JFK, NYC)' },
          destination: { type: 'string', description: 'IATA airport or city code (e.g. DTW)' },
          departureDate: { type: 'string', description: 'YYYY-MM-DD' },
          maxResults: { type: 'number', default: 5 },
        },
      },
    },
    {
      name: 'price_matrix',
      description:
        'Build a markdown price matrix (cheapest one-way per cell) over the next N weeks for the cartesian product of origins × destinations. Each cell links to Google Flights.',
      inputSchema: {
        type: 'object',
        properties: {
          origins: {
            type: 'array',
            items: { type: 'string' },
            default: ['JFK', 'NYC'],
          },
          destinations: {
            type: 'array',
            items: { type: 'string' },
            default: ['GRR', 'DTW'],
          },
          weeks: { type: 'number', default: 4 },
          weekendsOnly: {
            type: 'boolean',
            default: false,
            description: 'If true, query Saturdays and Sundays only.',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  if (name === 'flight_price') {
    const { origin, destination, departureDate, maxResults } = args;
    const r = await fetchCheapest(origin, destination, departureDate, maxResults);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              origin,
              destination,
              departureDate,
              cheapestUSD: r.price,
              offerCount: r.offerCount,
              googleFlights: googleFlightsUrl(origin, destination, departureDate),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === 'price_matrix') {
    const origins = args.origins ?? ['JFK', 'NYC'];
    const destinations = args.destinations ?? ['GRR', 'DTW'];
    const weeks = args.weeks ?? 4;
    const weekendsOnly = args.weekendsOnly ?? false;
    const dates = weekendsOnly
      ? weekendDatesFromToday(weeks)
      : weeklyDatesFromToday(weeks);

    const rows = [];
    for (const o of origins) {
      for (const d of destinations) {
        const cells = {};
        for (const date of dates) {
          try {
            cells[date] = await fetchCheapest(o, d, date);
          } catch (e) {
            cells[date] = { error: e.message };
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        rows.push({ origin: o, destination: d, cells });
      }
    }

    const header = dates.map((d) => (weekendsOnly ? `${dayLabel(d)} ${d.slice(5)}` : d));
    const lines = [];
    lines.push('| Route | ' + header.join(' | ') + ' |');
    lines.push('|---|' + dates.map(() => '---').join('|') + '|');
    for (const row of rows) {
      const cells = dates.map((date) => {
        const c = row.cells[date];
        const v = c.error ? 'ERR' : c.price == null ? '—' : `$${c.price.toFixed(2)}`;
        return `[${v}](${googleFlightsUrl(row.origin, row.destination, date)})`;
      });
      lines.push(`| ${row.origin}→${row.destination} | ${cells.join(' | ')} |`);
    }

    return {
      content: [
        { type: 'text', text: lines.join('\n') },
        { type: 'text', text: JSON.stringify({ dates, rows }, null, 2) },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
