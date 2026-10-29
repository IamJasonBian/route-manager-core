#!/usr/bin/env node
/**
 * Integration: search JFK → LAX via search-flights Netlify function.
 *
 * Workflow (local):
 *   1. Start stack: `make dev` (or `npx netlify dev`) — use http://localhost:3000
 *   2. Ensure `.env` has Amadeus test keys (netlify.toml uses AMADEUS_HOSTNAME=test for dev)
 *   3. Run: `npm run test:integration:search`
 *      or: `BASE_URL=http://localhost:3000 node scripts/integration-search-flight.mjs`
 *
 * Remote (deployed functions):
 *   BASE_URL=https://your-site.netlify.app node scripts/integration-search-flight.mjs
 *
 * Exit codes: 0 = offers returned, 1 = HTTP/network/parse failure, 2 = 200 but empty data
 */

const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

function departureDate() {
  if (process.env.DEPARTURE_DATE) return process.env.DEPARTURE_DATE;
  const d = new Date();
  d.setDate(d.getDate() + 21);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const url = `${base}/.netlify/functions/search-flights`;
  const payload = {
    origin: 'JFK',
    destination: 'LAX',
    departureDate: departureDate(),
    maxResults: 5,
    nonStop: false,
  };

  console.log(`POST ${url}`);
  console.log('Body:', JSON.stringify(payload));

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('Request failed (is the dev server up? try `make dev` on port 3000):', e.message);
    process.exit(1);
  }

  const ms = Math.round(performance.now() - t0);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`Non-JSON response (${res.status} ${ms}ms):`, text.slice(0, 800));
    process.exit(1);
  }

  console.log(`HTTP ${res.status} ${ms}ms`);

  if (!res.ok) {
    console.error('Error body:', JSON.stringify(json, null, 2).slice(0, 2000));
    process.exit(1);
  }

  const data = json.data;
  if (!Array.isArray(data)) {
    console.error('Expected response.data to be an array, got:', typeof data);
    process.exit(1);
  }

  if (data.length === 0) {
    console.warn(
      'API returned 200 but zero offers. Try a different DEPARTURE_DATE, check Amadeus quota, or USE_MOCK_DATA if applicable.'
    );
    process.exit(2);
  }

  const first = data[0];
  const price = first?.price?.total ?? first?.price;
  console.log(`OK: ${data.length} offer(s). First offer id=${first?.id ?? 'n/a'} price=${JSON.stringify(price)}`);
  process.exit(0);
}

main();
