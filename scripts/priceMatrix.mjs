#!/usr/bin/env node
// One-off: fetch cheapest one-way price per (route, weekend date) for the next 4 weekends.
// Hits the deployed Netlify function (no local Amadeus creds needed).

const ENDPOINT = process.env.ENDPOINT
  || 'https://route-manager-prod.netlify.app/.netlify/functions/search-flights';

const ORIGINS = ['JFK', 'LGA', 'NYC'];
const DESTINATIONS = ['GRR', 'DTW'];
const WEEKS = 4;

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchPrice(origin, destination, departureDate) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin,
      destination,
      departureDate,
      // one-way: returnDate intentionally omitted
      adults: 1,
      nonStop: false,
      maxResults: 5,
    }),
  });
  if (!res.ok) {
    return { error: `HTTP ${res.status}` };
  }
  const json = await res.json();
  const offers = json.data || [];
  if (offers.length === 0) return { price: null };
  const prices = offers
    .map((o) => parseFloat(o.price?.grandTotal ?? o.price?.total))
    .filter((n) => Number.isFinite(n));
  if (prices.length === 0) return { price: null };
  return { price: Math.min(...prices), offers: offers.length };
}

async function main() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dow = today.getUTCDay();
  const daysToSat = ((6 - dow + 7) % 7) || 7;
  const firstSat = addDays(today, daysToSat);
  const dates = [];
  for (let w = 0; w < WEEKS; w++) {
    const sat = addDays(firstSat, 7 * w);
    dates.push(iso(sat), iso(addDays(sat, 1)));
  }
  const dayLabel = (s) =>
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
      new Date(s + 'T00:00:00Z').getUTCDay()
    ];

  const routes = [];
  for (const o of ORIGINS) for (const d of DESTINATIONS) routes.push([o, d]);

  const rows = [];
  for (const [o, d] of routes) {
    const cells = {};
    for (const date of dates) {
      process.stderr.write(`fetching ${o}->${d} on ${date}... `);
      try {
        const r = await fetchPrice(o, d, date);
        cells[date] = r;
        process.stderr.write(
          r.error ? `ERR ${r.error}\n` : r.price == null ? 'no offers\n' : `$${r.price} (${r.offers})\n`
        );
      } catch (e) {
        cells[date] = { error: e.message };
        process.stderr.write(`THROW ${e.message}\n`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    rows.push({ route: `${o}->${d}`, cells });
  }

  const googleFlights = (o, d, date) =>
    `https://www.google.com/travel/flights?q=One-way%20flights%20from%20${o}%20to%20${d}%20on%20${date}`;
  const kayak = (o, d, date) => `https://www.kayak.com/flights/${o}-${d}/${date}?sort=price_a`;

  const pad = (s, n) => String(s).padEnd(n);
  const header = ['Route', ...dates.map((d) => `${dayLabel(d)} ${d.slice(5)}`)];
  const widths = header.map((h) => Math.max(h.length, 14));
  console.log('\n' + header.map((h, i) => pad(h, widths[i])).join(' | '));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const row of rows) {
    const cols = [
      pad(row.route, widths[0]),
      ...dates.map((d, i) => {
        const c = row.cells[d];
        const v = c.error ? `ERR` : c.price == null ? '—' : `$${c.price.toFixed(2)}`;
        return pad(v, widths[i + 1]);
      }),
    ];
    console.log(cols.join(' | '));
  }

  console.log('\nBooking links:');
  for (const row of rows) {
    const [o, d] = row.route.split('->');
    console.log(`\n${row.route}:`);
    for (const date of dates) {
      const c = row.cells[date];
      const price = c.error ? 'ERR' : c.price == null ? '—' : `$${c.price.toFixed(2)}`;
      console.log(`  ${date}  ${price.padEnd(10)}  Google: ${googleFlights(o, d, date)}`);
      console.log(`  ${' '.repeat(date.length)}  ${' '.repeat(10)}  Kayak:  ${kayak(o, d, date)}`);
    }
  }

  console.log('\nMarkdown:');
  console.log('| Route | ' + dates.map((d) => `${dayLabel(d)} ${d.slice(5)}`).join(' | ') + ' |');
  console.log('|' + Array(dates.length + 1).fill('---').join('|') + '|');
  for (const row of rows) {
    const [o, d] = row.route.split('->');
    const cells = dates.map((date) => {
      const c = row.cells[date];
      const v = c.error ? 'ERR' : c.price == null ? '—' : `$${c.price.toFixed(2)}`;
      return `[${v}](${googleFlights(o, d, date)})`;
    });
    console.log(`| ${row.route} | ${cells.join(' | ')} |`);
  }

  console.log('\nJSON:');
  console.log(JSON.stringify({ dates, rows }, null, 2));
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
