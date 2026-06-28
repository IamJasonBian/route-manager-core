// Persistent CDP "terminal" for delta.com / aa.com automation.
//
// Brings up a LONG-LIVED Chromium with three properties:
//   1. PERSISTENT profile  — a real user-data-dir, so a login (Delta SkyMiles,
//      cookies, MFA "trust this device") survives restarts. This is the
//      "persistent terminal": log in once, reuse forever.
//   2. CDP remote-debugging PORT exposed — external tools attach over the
//      Chrome DevTools Protocol: Playwright's connectOverCDP(), chrome://inspect,
//      or any CDP client. Pull this repo onto a VM, run it there, and drive the
//      same browser from your laptop.
//   3. TRACE capture — Playwright tracing runs for the whole session and a
//      trace.zip is written on shutdown (open with `npx playwright show-trace`).
//      Optional HAR capture of every request/response with --har.
//
// SECURITY: a remote-debugging port is full, unauthenticated control of the
// browser (and any logged-in session in it). It binds to 127.0.0.1 by default.
// To reach it from another machine, the SAFE path is an SSH tunnel:
//   ssh -N -L 9222:127.0.0.1:9222 user@vm        # then connect to localhost:9222
// Only pass --bind 0.0.0.0 on a trusted/firewalled network; doing so prints a
// loud warning and adds --remote-allow-origins so external CDP clients connect.
//
// Usage:
//   node scripts/booking/cdp-terminal.mjs                       # localhost:9222, headed
//   node scripts/booking/cdp-terminal.mjs --headless            # for a VM
//   node scripts/booking/cdp-terminal.mjs --port 9333 --bind 0.0.0.0
//   node scripts/booking/cdp-terminal.mjs --login delta         # seed a Delta login first
//   node scripts/booking/cdp-terminal.mjs --url https://www.delta.com/ --no-trace
//
// Connect from elsewhere (after tunneling or binding):
//   import { chromium } from 'playwright';
//   const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
//   const [ctx] = b.contexts(); const [page] = ctx.pages();

import '../load-env.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { envHeadless } from './aa-auth.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headless') args.headless = true;
    else if (a === '--headed') args.headed = true;
    else if (a === '--no-trace') args.trace = false;
    else if (a === '--har') args.har = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function resolveHeadless(args) {
  if (args.headless) return true;
  if (args.headed) return false;
  return envHeadless();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the DevTools JSON endpoint until Chromium has bound the port. */
async function readDevtoolsVersion(port, tries = 25) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const port = Number(args.port || process.env.CDP_PORT || 9222);
  const bind = args.bind || process.env.CDP_BIND || '127.0.0.1';
  const headless = resolveHeadless(args);
  const trace = args.trace !== false; // on unless --no-trace
  const userDataDir = resolve(
    process.cwd(),
    args.profile || process.env.CDP_USER_DATA_DIR || '.secrets/cdp-profile'
  );
  const startUrl = args.url || process.env.CDP_START_URL || 'about:blank';
  const isLoopback = bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';

  // A timestamp-free name keeps it overwrite-friendly per session; Date.now is
  // avoided so the file is predictable. Tracing always writes a fresh zip.
  const traceDir = resolve(process.cwd(), '.scrapes/traces');
  const tracePath = resolve(traceDir, `cdp-terminal.zip`);
  const harPath = resolve(traceDir, `cdp-terminal.har`);

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error(
      "❌ Missing dependency 'playwright'. Install it with:\n" +
        '   npm install playwright && npx playwright install chromium'
    );
    process.exit(1);
  }

  // Chromium flags: open the TCP CDP port. --remote-debugging-address only
  // takes effect in headless; for headed-on-a-VM use Xvfb or just --headless.
  const browserArgs = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${bind}`,
  ];
  if (!isLoopback) {
    // Modern Chromium rejects CDP attaches from a non-null Origin unless allowed.
    browserArgs.push('--remote-allow-origins=*');
  }

  mkdirSync(userDataDir, { recursive: true });
  if (trace || args.har) mkdirSync(traceDir, { recursive: true });

  console.log('🖥️  Bringing up persistent CDP terminal...');
  console.log(`   profile:   ${userDataDir}`);
  console.log(`   headless:  ${headless}`);
  console.log(`   bind:      ${bind}:${port}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    args: browserArgs,
    ...(args.har ? { recordHar: { path: harPath } } : {}),
  });

  if (trace) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    console.log(`   trace:     ${tracePath} (on exit)`);
  }
  if (args.har) console.log(`   har:       ${harPath} (on exit)`);

  // Optional: seed an airline login into this persistent profile up front.
  const page = context.pages()[0] || (await context.newPage());
  if (args.login === 'delta') {
    console.log('🔐 Seeding a Delta login into the profile...');
    const { loginLoop } = await import('./delta-auth.mjs');
    const { getDeltaCredentials } = await import('../gcloud/get-delta-credentials.mjs');
    const creds = await getDeltaCredentials();
    const ok = await loginLoop(page, creds, { maxAttempts: 3 });
    console.log(ok ? '✅ Delta session seeded into the profile.' : '⚠️  Could not log in; terminal still up.');
  }
  if (startUrl !== 'about:blank') {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  // Resolve the real webSocketDebuggerUrl so the connect instructions are exact.
  const ver = await readDevtoolsVersion(port);
  const ws = ver?.webSocketDebuggerUrl || `ws://127.0.0.1:${port}/devtools/browser/<id>`;

  console.log('\n✅ CDP terminal is UP. Connect over the Chrome DevTools Protocol:\n');
  console.log(`   HTTP endpoint:   http://${isLoopback ? '127.0.0.1' : bind}:${port}/json/version`);
  console.log(`   WebSocket (ws):  ${ws}`);
  console.log('\n   From a Playwright client:');
  console.log(`     const b = await chromium.connectOverCDP('http://127.0.0.1:${port}');`);
  console.log('\n   From Chrome:  chrome://inspect → Configure → add the host:port above.\n');

  if (isLoopback) {
    console.log('🔒 Bound to loopback. To reach it from another machine, SSH-tunnel:');
    console.log(`     ssh -N -L ${port}:127.0.0.1:${port} ${process.env.USER || 'user'}@${hostname()}`);
    console.log(`   then connect to http://127.0.0.1:${port} on the far side.\n`);
  } else {
    console.log('⚠️  SECURITY: the CDP port is exposed on a NON-loopback address.');
    console.log('   Anyone who can reach it has full, unauthenticated control of this');
    console.log('   browser and every session logged into it. Firewall it to trusted');
    console.log('   IPs, or prefer an SSH tunnel with --bind 127.0.0.1.\n');
  }

  console.log('   Press Ctrl-C to stop (flushes the trace and closes cleanly).');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down...`);
    try {
      if (trace) {
        await context.tracing.stop({ path: tracePath });
        console.log(`💾 Trace written to ${tracePath}`);
        console.log(`   View it:  npx playwright show-trace ${tracePath}`);
      }
      await context.close(); // flushes HAR if enabled
      if (args.har) console.log(`💾 HAR written to ${harPath}`);
    } catch (err) {
      console.error(`   Shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep the process alive until a signal; if the browser is closed externally
  // (e.g. window closed), exit so the trace still flushes.
  context.on('close', () => shutdown('browser-closed'));
  await new Promise(() => {}); // park forever
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
