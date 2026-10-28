#!/usr/bin/env node
// plan-nyc-mich MCP server
//
// Curated for planning weekend trips between NYC-area airports (JFK / LGA /
// NYC city code) and Michigan (GRR, DTW). Tools are intentionally
// route-specific rather than generic — they take no origin/destination
// arguments. Add a new MCP per route family rather than parameterizing this
// one.
//
// AUTH: this server holds no credentials. It proxies to the deployed Netlify
// function `search-flights`, which holds the Amadeus API key/secret in its
// site environment (AMADEUS_API_KEY / AMADEUS_API_SECRET — set per Netlify
// site; see netlify/functions/search-flights.js). Override the upstream with
// the ROUTE_MANAGER_ENDPOINT env var.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const ENDPOINT =
  process.env.ROUTE_MANAGER_ENDPOINT ||
  'https://route-manager-prod.netlify.app/.netlify/functions/search-flights';

const ORIGINS = ['JFK', 'LGA', 'NYC'];
const DESTINATIONS = ['GRR', 'DTW'];

const addDays = (date, n) => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};
const iso = (d) => d.toISOString().slice(0, 10);
const dayLabel = (s) =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(s + 'T00:00:00Z').getUTCDay()
  ];

const googleFlightsUrl = (o, d, date) =>
  `https://www.google.com/travel/flights?q=One-way%20flights%20from%20${o}%20to%20${d}%20on%20${date}`;

function weekendDates(weeks) {
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

async function fetchCheapest(origin, destination, departureDate) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin,
      destination,
      departureDate,
      adults: 1,
      nonStop: false,
      maxResults: 5,
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

async function buildMatrix(weeks) {
  const dates = weekendDates(weeks);
  const rows = [];
  for (const o of ORIGINS) {
    for (const d of DESTINATIONS) {
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
  return { dates, rows };
}

function matrixToMarkdown({ dates, rows }) {
  const header = dates.map((d) => `${dayLabel(d)} ${d.slice(5)}`);
  const lines = [
    '| Route | ' + header.join(' | ') + ' |',
    '|---|' + dates.map(() => '---').join('|') + '|',
  ];
  for (const row of rows) {
    const cells = dates.map((date) => {
      const c = row.cells[date];
      const v = c.error ? 'ERR' : c.price == null ? '—' : `$${c.price.toFixed(2)}`;
      return `[${v}](${googleFlightsUrl(row.origin, row.destination, date)})`;
    });
    lines.push(`| ${row.origin}→${row.destination} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

const server = new Server(
  { name: 'plan_nyc_mich', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'weekend_price_matrix',
      description:
        'Cheapest one-way price for each weekend day (Sat + Sun) over the next N weekends, across the curated NYC-area → Michigan routes (JFK/LGA/NYC × GRR/DTW). Returns a markdown table; each cell links to Google Flights.',
      inputSchema: {
        type: 'object',
        properties: {
          weeks: { type: 'number', default: 4, description: 'Number of upcoming weekends (default 4).' },
        },
      },
    },
    {
      name: 'cheapest_weekend_trip',
      description:
        'Among the curated NYC-area → Michigan routes, return the single cheapest (route, weekend date) pair found in the next N weekends.',
      inputSchema: {
        type: 'object',
        properties: {
          weeks: { type: 'number', default: 4 },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const weeks = args.weeks ?? 4;

  if (name === 'weekend_price_matrix') {
    const matrix = await buildMatrix(weeks);
    return {
      content: [
        { type: 'text', text: matrixToMarkdown(matrix) },
        { type: 'text', text: JSON.stringify(matrix, null, 2) },
      ],
    };
  }

  if (name === 'cheapest_weekend_trip') {
    const matrix = await buildMatrix(weeks);
    let best = null;
    for (const row of matrix.rows) {
      for (const date of matrix.dates) {
        const c = row.cells[date];
        if (c.error || c.price == null) continue;
        if (!best || c.price < best.price) {
          best = {
            origin: row.origin,
            destination: row.destination,
            date,
            day: dayLabel(date),
            price: c.price,
            googleFlights: googleFlightsUrl(row.origin, row.destination, date),
          };
        }
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: best
            ? JSON.stringify(best, null, 2)
            : 'No bookable weekend offers found in the next ' + weeks + ' weekends.',
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
