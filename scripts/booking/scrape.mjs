// Fare scraper for delta.com / aa.com. Loads the public flight-search funnel,
// runs a route, extracts the fare cards, and WRITES THE RESULT LOCALLY:
//   .scrapes/<airline>-<from>-<to>-<timestamp>.json   (structured fares)
//   .scrapes/<airline>-<from>-<to>-<timestamp>.png    (full-page screenshot)
//
// Public fares need NO login, so this runs unauthenticated by default — that's
// what lets you "watch the scrape" without an MFA prompt. Pass --authed to reuse
// the logged-in session (member fares) via the airline auth loop.
//
// Headless mode is persisted via the HEADLESS env var (see .env). --headed /
// --headless override it for a single run.
//
// Usage:
//   node scripts/booking/scrape.mjs --airline aa --from SEA --to JFK --depart 2026-07-10
//   node scripts/booking/scrape.mjs --airline delta --from SEA --to LAX --depart 2026-07-10 --return 2026-07-17
//   add --authed to use your logged-in session, --headed to force a visible window.

import '../load-env.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { envHeadless } from './aa-auth.mjs';

// Per-airline search funnel. Selectors mirror the book-*-trip.mjs scripts and
// share the same env override names, so a fix in one place fixes both.
// Exported so other entrypoints (e.g. cdp-attach-scrape.mjs) reuse one funnel.
export const CONFIGS = {
  delta: {
    label: 'delta',
    authModule: './delta-auth.mjs',
    searchUrl: process.env.DELTA_SEARCH_URL || 'https://www.delta.com/flight-search/book-a-flight',
    sel: {
      oneWay: process.env.DELTA_SEL_ONEWAY || 'input[value="oneWay"], #oneWay',
      from: process.env.DELTA_SEL_FROM || '#fromAirportName, input[name="originCity"]',
      to: process.env.DELTA_SEL_TO || '#toAirportName, input[name="destinationCity"]',
      depart: process.env.DELTA_SEL_DEPART || '#calendar-div-start, input[name="departureDate"]',
      returnDate: process.env.DELTA_SEL_RETURN || '#calendar-div-end, input[name="returnDate"]',
      search: process.env.DELTA_SEL_SEARCH || '#btnSubmit, button:has-text("Search")',
      fareCard: process.env.DELTA_SEL_FARECARD || '.farecardContainer, [data-testid="fare-card"]',
      farePrice: process.env.DELTA_SEL_FAREPRICE || '.fare-price, [data-testid="fare-price"]',
    },
  },
  aa: {
    label: 'aa',
    authModule: './aa-auth.mjs',
    searchUrl: process.env.AA_SEARCH_URL || 'https://www.aa.com/booking/find-flights',
    sel: {
      oneWay: process.env.AA_SEL_ONEWAY || 'input[value="oneWay"], #flightSearchForm\\.tripType\\.oneWay, label:has-text("One way")',
      from: process.env.AA_SEL_FROM || '#reservationFlightSearchForm\\.originAirport, input[name="originAirport"], #segments0\\.origin',
      to: process.env.AA_SEL_TO || '#reservationFlightSearchForm\\.destinationAirport, input[name="destinationAirport"], #segments0\\.destination',
      depart: process.env.AA_SEL_DEPART || 'input[name="departureDate"], #aa-leavingOn, #segments0\\.travelDate',
      returnDate: process.env.AA_SEL_RETURN || 'input[name="returnDate"], #aa-returningFrom, #segments1\\.travelDate',
      search: process.env.AA_SEL_SEARCH || '#flightSearchForm\\.button\\.reSubmit, #search-flights-button, button:has-text("Search")',
      fareCard: process.env.AA_SEL_FARECARD || '.fare-card, [data-testid="fare-card"], .grid-item-product',
      farePrice: process.env.AA_SEL_FAREPRICE || '.fare-price, [data-testid="price"], .typography-price',
    },
  },
};

function parseArgs(argv) {
  const args = { pax: '1', max: '20' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--authed') args.authed = true;
    else if (a === '--headless') args.headless = true;
    else if (a === '--headed') args.headed = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function requireArgs(args) {
  const missing = ['airline', 'from', 'to', 'depart'].filter((k) => !args[k]);
  if (missing.length || !CONFIGS[args.airline]) {
    console.error(`❌ Missing/invalid args: ${missing.map((m) => '--' + m).join(', ') || '--airline'}`);
    console.error('   e.g. --airline aa --from SEA --to JFK --depart 2026-07-10 [--return 2026-07-17]');
    console.error(`   --airline must be one of: ${Object.keys(CONFIGS).join(', ')}`);
    process.exit(1);
  }
}

function resolveHeadless(args) {
  if (args.headless) return true;
  if (args.headed) return false;
  return envHeadless();
}

async function openPage(cfg, args, headless) {
  if (args.authed) {
    const { getAuthenticatedPage } = await import(cfg.authModule);
    const { browser, context, page } = await getAuthenticatedPage({ headless });
    return { browser, context, page, authed: true };
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, context, page, authed: false };
}

export async function runSearch(page, cfg, args) {
  console.log(`🔎 ${cfg.label}: ${args.from} → ${args.to} on ${args.depart}${args.return ? ` (return ${args.return})` : ' (one-way)'}`);
  await page.goto(cfg.searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!args.return) await page.click(cfg.sel.oneWay).catch(() => {});
  await page.fill(cfg.sel.from, args.from).catch(() => {});
  await page.fill(cfg.sel.to, args.to).catch(() => {});
  await page.fill(cfg.sel.depart, args.depart).catch(() => {});
  if (args.return) await page.fill(cfg.sel.returnDate, args.return).catch(() => {});
  await page.click(cfg.sel.search).catch(() => {});
  // Wait for fare cards; on timeout we still capture the page for inspection.
  await page.waitForSelector(cfg.sel.fareCard, { timeout: 45000 }).catch(() => {});
}

export async function extractFares(page, cfg, max) {
  const cards = page.locator(cfg.sel.fareCard);
  const n = await cards.count().catch(() => 0);
  const fares = [];
  for (let i = 0; i < Math.min(n, max); i++) {
    const card = cards.nth(i);
    const price = ((await card.locator(cfg.sel.farePrice).first().textContent().catch(() => '')) || '').trim();
    const summary = ((await card.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    fares.push({ index: i, price, summary });
  }
  return { total: n, fares };
}

export function writeResults(cfg, args, authed, headless, result) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = resolve(process.cwd(), '.scrapes', `${cfg.label}-${args.from}-${args.to}-${ts}`);
  mkdirSync(dirname(base), { recursive: true });
  const payload = {
    airline: cfg.label,
    scrapedAt: new Date().toISOString(),
    authed,
    headless,
    route: { from: args.from, to: args.to, depart: args.depart, return: args.return || null, pax: args.pax },
    searchUrl: cfg.searchUrl,
    count: result.fares.length,
    totalCardsOnPage: result.total,
    fares: result.fares,
  };
  writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2));
  return base;
}

async function main() {
  const args = parseArgs(process.argv);
  requireArgs(args);
  const cfg = CONFIGS[args.airline];
  const headless = resolveHeadless(args);
  const max = Number(args.max) || 20;

  console.log(`🚀 Scraping ${cfg.label} | headless=${headless} | authed=${!!args.authed}`);
  const { browser, page } = await openPage(cfg, args, headless);
  let base;
  try {
    let result = { total: 0, fares: [] };
    try {
      await runSearch(page, cfg, args);
      result = await extractFares(page, cfg, max);
    } catch (err) {
      console.log(`   ⚠️  Search/extract issue: ${err.message}`);
    }
    base = writeResults(cfg, args, !!args.authed, headless, result);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});

    console.log(`\n──────────── ${cfg.label.toUpperCase()} ${args.from}→${args.to} ────────────`);
    if (result.fares.length === 0) {
      console.log('  (no fare cards captured — likely a bot challenge or stale selectors;');
      console.log('   check the screenshot + tune the *_SEL_* env vars.)');
    } else {
      for (const f of result.fares) console.log(`  • ${f.price || '?'}  ${f.summary.slice(0, 80)}`);
    }
    console.log('──────────────────────────────────────────');
    console.log(`💾 ${base}.json`);
    console.log(`🖼️  ${base}.png\n`);
  } finally {
    await browser.close();
  }
}

// Only run the scrape when invoked directly as a CLI, so importing the funnel
// (CONFIGS/runSearch/extractFares/writeResults) from this module is side-effect free.
const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
