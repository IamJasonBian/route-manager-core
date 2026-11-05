#!/usr/bin/env node
/**
 * Smoke-test Netlify functions locally without deploying.
 * Start the stack first: npm run dev:clean   (netlify.toml uses port 3000 for the dev server)
 *
 * Usage:
 *   node scripts/test-local-functions.mjs
 *   BASE_URL=http://localhost:8888 node scripts/test-local-functions.mjs
 */

const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

const paths = [
  '/.netlify/functions/health',
  '/.netlify/functions/flight-prices?from=JFK&to=LAX',
];

async function main() {
  console.log(`Probing ${base} …\n`);
  for (const p of paths) {
    const url = `${base}${p}`;
    const t0 = performance.now();
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const ms = Math.round(performance.now() - t0);
      const text = await res.text();
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 0);
      } catch {
        /* not JSON */
      }
      console.log(`${res.status} ${ms}ms  ${p}`);
      if (!res.ok) console.log(body.slice(0, 500));
    } catch (e) {
      console.error(`FAIL ${p}`, e.message);
    }
  }
  console.log('\nTip: set USE_MOCK_DATA=true in .env for flight-prices without calling Kiwi.');
}

main();
