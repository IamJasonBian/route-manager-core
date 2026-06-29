// Attach to a running CDP terminal (cdp-terminal.mjs) and run a fare scrape
// inside its persistent, possibly-logged-in browser — instead of launching a
// fresh Chromium. This is how you drive the VM's browser from anywhere:
//
//   (on the VM)      npm run cdp:headless          # terminal up on :9222
//   (tunnel)         ssh -N -L 9222:127.0.0.1:9222 user@vm
//   (here)           npm run scrape:cdp -- --airline delta --from SEA --to JFK --depart 2026-07-10
//
// Because it reuses the terminal's profile, a session seeded with
// `npm run cdp -- --login delta` makes this an authenticated (member-fare)
// scrape with no extra login. Results land in .scrapes/ exactly like scrape.mjs.

import '../load-env.mjs';
import { CONFIGS, runSearch, extractFares, writeResults } from './scrape.mjs';

function parseArgs(argv) {
  const args = { pax: '1', max: '20' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function requireArgs(args) {
  const missing = ['airline', 'from', 'to', 'depart'].filter((k) => !args[k]);
  if (missing.length || !CONFIGS[args.airline]) {
    console.error(`❌ Missing/invalid args: ${missing.map((m) => '--' + m).join(', ') || '--airline'}`);
    console.error('   e.g. --airline delta --from SEA --to JFK --depart 2026-07-10 [--return 2026-07-17]');
    console.error(`   --airline must be one of: ${Object.keys(CONFIGS).join(', ')}`);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  requireArgs(args);
  const cfg = CONFIGS[args.airline];
  const max = Number(args.max) || 20;
  const port = args.port || process.env.CDP_PORT || '9222';
  const endpoint = args.cdp || process.env.CDP_ENDPOINT || `http://127.0.0.1:${port}`;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error("❌ Missing 'playwright'. Run: npm install playwright");
    process.exit(1);
  }

  console.log(`🔌 Attaching to CDP terminal at ${endpoint} ...`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (err) {
    console.error(`❌ Could not attach: ${err.message}`);
    console.error('   Is the terminal up? On the VM: npm run cdp:headless');
    console.error('   Tunneling? ssh -N -L ' + port + ':127.0.0.1:' + port + ' user@vm');
    process.exit(1);
  }

  // Reuse the terminal's existing (persistent) context so cookies/login apply.
  const context = browser.contexts()[0] || (await browser.newContext());
  const authed = context.pages().length > 0; // best-effort: a seeded session has pages
  const page = await context.newPage();
  try {
    let result = { total: 0, fares: [] };
    try {
      await runSearch(page, cfg, args);
      result = await extractFares(page, cfg, max);
    } catch (err) {
      console.log(`   ⚠️  Search/extract issue: ${err.message}`);
    }
    const base = writeResults(cfg, args, authed, /* headless */ true, result);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});

    console.log(`\n──────────── ${cfg.label.toUpperCase()} ${args.from}→${args.to} (over CDP) ────────────`);
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
    // Close only our page — leave the terminal's browser running.
    await page.close().catch(() => {});
    await browser.close().catch(() => {}); // detaches the CDP client, not the browser
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
