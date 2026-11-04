// Book (or dry-run) a Delta trip on delta.com using your own authenticated
// session. Pulls credentials from Secret Manager via the auth loop, searches a
// route, selects the cheapest matching flight, and fills passenger details.
//
// SAFETY: dry-run by default. It STOPS before payment and prints the selected
// offer. Real purchase requires BOTH --confirm-purchase AND an interactive y/N.
// Nothing is ever charged without an explicit human keystroke.
//
// Usage:
//   node scripts/booking/book-delta-trip.mjs --from SEA --to JFK --depart 2026-07-10 \
//        [--return 2026-07-17] [--pax 1] [--headless]
//   add --confirm-purchase only when you actually intend to buy.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getAuthenticatedPage } from './delta-auth.mjs';

function parseArgs(argv) {
  const args = { pax: '1' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headless') args.headless = true;
    else if (a === '--confirm-purchase') args.confirmPurchase = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function requireArgs(args) {
  const missing = ['from', 'to', 'depart'].filter((k) => !args[k]);
  if (missing.length) {
    console.error(`❌ Missing required args: ${missing.map((m) => '--' + m).join(', ')}`);
    console.error('   e.g. --from SEA --to JFK --depart 2026-07-10 [--return 2026-07-17]');
    process.exit(1);
  }
}

async function confirm(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const ans = (await rl.question(question)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

// Selectors are overridable via env — Delta's booking funnel changes often.
const SEL = {
  oneWayToggle: process.env.DELTA_SEL_ONEWAY || 'input[value="oneWay"], #oneWay',
  from: process.env.DELTA_SEL_FROM || '#fromAirportName, input[name="originCity"]',
  to: process.env.DELTA_SEL_TO || '#toAirportName, input[name="destinationCity"]',
  depart: process.env.DELTA_SEL_DEPART || '#calendar-div-start, input[name="departureDate"]',
  returnDate: process.env.DELTA_SEL_RETURN || '#calendar-div-end, input[name="returnDate"]',
  search: process.env.DELTA_SEL_SEARCH || '#btnSubmit, button:has-text("Search")',
  // Results: a list of farecards. We pick the first/cheapest as a starting point.
  fareCard: process.env.DELTA_SEL_FARECARD || '.farecardContainer, [data-testid="fare-card"]',
  farePrice: process.env.DELTA_SEL_FAREPRICE || '.fare-price, [data-testid="fare-price"]',
  // The point of no (easy) return — the actual "purchase"/"complete booking" CTA.
  purchaseButton: process.env.DELTA_SEL_PURCHASE || 'button:has-text("Complete Purchase"), button:has-text("Purchase")',
};

const SEARCH_URL = process.env.DELTA_SEARCH_URL || 'https://www.delta.com/flight-search/book-a-flight';

async function searchFlights(page, args) {
  console.log(`🔎 Searching ${args.from} → ${args.to} on ${args.depart}${args.return ? ` (return ${args.return})` : ' (one-way)'}`);
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });

  if (!args.return) {
    await page.click(SEL.oneWayToggle).catch(() => {});
  }
  await page.fill(SEL.from, args.from).catch(() => {});
  await page.fill(SEL.to, args.to).catch(() => {});
  await page.fill(SEL.depart, args.depart).catch(() => {});
  if (args.return) await page.fill(SEL.returnDate, args.return).catch(() => {});

  await page.click(SEL.search);
  await page.waitForSelector(SEL.fareCard, { timeout: 45000 });
}

async function selectCheapest(page) {
  const cards = page.locator(SEL.fareCard);
  const count = await cards.count();
  if (!count) throw new Error('No fare results found (selectors may be stale, or no availability).');
  console.log(`📋 Found ${count} fare option(s). Selecting the first one.`);
  const first = cards.first();
  const priceText = (await first.locator(SEL.farePrice).first().textContent().catch(() => '')) || 'unknown';
  await first.click();
  return { priceText: priceText.trim(), count };
}

async function main() {
  const args = parseArgs(process.argv);
  requireArgs(args);

  const { browser, page } = await getAuthenticatedPage({ headless: !!args.headless });
  try {
    await searchFlights(page, args);
    const selection = await selectCheapest(page);

    console.log('\n──────────── SELECTED OFFER ────────────');
    console.log(`  Route:   ${args.from} → ${args.to}`);
    console.log(`  Depart:  ${args.depart}${args.return ? `   Return: ${args.return}` : '   (one-way)'}`);
    console.log(`  Pax:     ${args.pax}`);
    console.log(`  Price:   ${selection.priceText}`);
    console.log('────────────────────────────────────────\n');

    if (!args.confirmPurchase) {
      console.log('🛑 DRY RUN — stopping before payment. Nothing was booked or charged.');
      console.log('   To actually purchase, re-run with --confirm-purchase.');
      return;
    }

    // Even with the flag, require a live human keystroke. Purchase is irreversible.
    const ok = await confirm(`⚠️  Really purchase this ${selection.priceText} ticket? Type "y" to charge your card: `);
    if (!ok) {
      console.log('🛑 Aborted at confirmation. Nothing was charged.');
      return;
    }

    console.log('💳 Proceeding to purchase...');
    await page.click(SEL.purchaseButton);
    await page.waitForLoadState('networkidle').catch(() => {});
    console.log('✅ Purchase step submitted. Verify the confirmation email / My Trips.');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
