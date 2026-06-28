// Deploy preflight for the CDP terminal — run it ON the machine you deploy to
// (this box / the VM) right after `npm ci && npx playwright install chromium`:
//
//   npm run cdp:preflight
//
// It proves the deploy TARGET environment is sound: Playwright + a Chromium
// build are present, the terminal boots headless, exposes a CDP port, and a
// client can attach over it. It is NOT about the Netlify alpha/gamma/prod
// envs — those host the React app; this validates the host running Chromium.
//
// Port is overridable so it never collides with a live terminal on :9222:
//   CDP_TEST_PORT=9931 npm run cdp:preflight

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TERMINAL = resolve(HERE, 'cdp-terminal.mjs');
const PORT = Number(process.env.CDP_TEST_PORT || 9931);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return null;
}

test('playwright + a Chromium build are installed on this host', async () => {
  const { chromium } = await import('playwright');
  assert.ok(chromium, 'playwright chromium API should import');
  const exe = chromium.executablePath();
  assert.ok(existsSync(exe), `Chromium binary missing at ${exe} — run: npx playwright install chromium`);
});

test('CDP terminal boots headless, exposes its port, and accepts a client', { timeout: 90_000 }, async (t) => {
  const child = spawn('node', [TERMINAL, '--headless', '--no-trace', '--port', String(PORT)], {
    cwd: resolve(HERE, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CDP_USER_DATA_DIR: '.secrets/cdp-preflight-profile' },
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  t.after(async () => {
    child.kill('SIGINT');
    await sleep(500);
    if (!child.killed) child.kill('SIGKILL');
  });

  const version = await waitForCdp(PORT);
  assert.ok(version, `CDP endpoint never came up on :${PORT}. stderr:\n${stderr}`);
  assert.match(version.webSocketDebuggerUrl, /^ws:\/\//, 'should advertise a ws debugger URL');

  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = await ctx.newPage();
    await page.goto('about:blank');
    assert.equal(page.url(), 'about:blank', 'attached client should drive a page');
    await page.close();
  } finally {
    await browser.close();
  }
});
