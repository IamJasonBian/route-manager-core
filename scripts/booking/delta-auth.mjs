// Delta.com authentication loop (Playwright).
//
// Responsibilities:
//   1. Reuse a persisted browser session (storageState) when it is still valid,
//      so we don't log in on every run.
//   2. When there is no valid session, run a resilient login LOOP: fill the
//      form, handle an MFA/OTP challenge interactively, retry on transient
//      failure with backoff, and persist the session on success.
//
// NOTE: Delta's site markup and bot defenses change over time. Selectors are
// kept in DELTA_SELECTORS and can be overridden via env without editing code.
// This is best-effort automation of YOUR OWN account — expect to tune selectors.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import '../load-env.mjs';
import { getDeltaCredentials } from '../gcloud/get-delta-credentials.mjs';

// Session cache lives under a gitignored dir alongside the repo root.
export const STORAGE_STATE =
  process.env.DELTA_STORAGE_STATE || resolve(process.cwd(), '.secrets/delta-storage-state.json');

const LOGIN_URL = process.env.DELTA_LOGIN_URL || 'https://www.delta.com/login';
// A page that only renders when authenticated — used to test the session.
const ACCOUNT_URL = process.env.DELTA_ACCOUNT_URL || 'https://www.delta.com/myprofile/dashboard';

// Override any selector via env (e.g. DELTA_SEL_USERNAME='#user') if Delta moves.
const DELTA_SELECTORS = {
  username: process.env.DELTA_SEL_USERNAME || '#login-form-userName, input[name="userId"], #userId',
  password: process.env.DELTA_SEL_PASSWORD || '#password-input, input[name="password"], #password',
  submit: process.env.DELTA_SEL_SUBMIT || 'button[type="submit"], #btn-login, button:has-text("Log In")',
  // Markers that the login screen wants a one-time passcode.
  mfaPrompt: process.env.DELTA_SEL_MFA || 'input[name*="otp"], input[name*="code"], #verification-code',
  mfaSubmit: process.env.DELTA_SEL_MFA_SUBMIT || 'button:has-text("Verify"), button:has-text("Submit")',
  // Markers that we are logged in.
  loggedIn: process.env.DELTA_SEL_LOGGEDIN || '[data-testid="account-menu"], .skymiles-number, a[href*="logout"]',
  // Markers of a rejected login.
  error: process.env.DELTA_SEL_ERROR || '.error-message, [role="alert"], .alert-danger',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve headless mode: explicit arg wins, else the persisted HEADLESS env. */
export function envHeadless() {
  const v = (process.env.HEADLESS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

async function prompt(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** True if any selector in `loggedIn` is visible within `timeout`. */
async function isLoggedIn(page, timeout = 8000) {
  try {
    await page.waitForSelector(DELTA_SELECTORS.loggedIn, { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * One login attempt. Returns 'ok' | 'mfa' | 'error' | 'unknown'.
 */
async function attemptLogin(page, creds) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  await page.fill(DELTA_SELECTORS.username, creds.username);
  await page.fill(DELTA_SELECTORS.password, creds.password);
  await page.click(DELTA_SELECTORS.submit);

  // Race the possible outcomes.
  const outcome = await Promise.race([
    page.waitForSelector(DELTA_SELECTORS.loggedIn, { timeout: 20000 }).then(() => 'ok').catch(() => null),
    page.waitForSelector(DELTA_SELECTORS.mfaPrompt, { timeout: 20000 }).then(() => 'mfa').catch(() => null),
    page.waitForSelector(DELTA_SELECTORS.error, { timeout: 20000 }).then(() => 'error').catch(() => null),
  ]);

  return outcome || 'unknown';
}

/** Handle an interactive OTP / MFA challenge. */
async function handleMfa(page) {
  console.log('🔢 Delta is asking for a one-time passcode (check your email/SMS/app).');
  const code = await prompt('   Enter the code: ');
  await page.fill(DELTA_SELECTORS.mfaPrompt, code);
  await page.click(DELTA_SELECTORS.mfaSubmit).catch(() => {});
  return isLoggedIn(page, 20000);
}

/**
 * The auth loop. Retries with backoff, handling MFA inline.
 * @returns {Promise<boolean>} true once logged in.
 */
export async function loginLoop(page, creds, { maxAttempts = 3 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`🔐 Login attempt ${attempt}/${maxAttempts}...`);
    try {
      const outcome = await attemptLogin(page, creds);

      if (outcome === 'ok') return true;

      if (outcome === 'mfa') {
        if (await handleMfa(page)) return true;
        console.log('   MFA did not complete; retrying full login.');
      } else if (outcome === 'error') {
        const msg = await page.textContent(DELTA_SELECTORS.error).catch(() => '');
        console.log(`   Login rejected: ${(msg || '').trim().slice(0, 200)}`);
        // Bad credentials won't fix themselves on retry — bail early.
        throw new Error('Delta rejected the credentials. Re-seed with put-delta-credentials.sh.');
      } else {
        console.log('   Unrecognized post-submit state (selectors may be stale).');
      }
    } catch (err) {
      if (/rejected the credentials/.test(err.message)) throw err;
      console.log(`   Attempt errored: ${err.message}`);
    }

    if (attempt < maxAttempts) {
      const backoff = 2000 * attempt;
      console.log(`   Backing off ${backoff}ms before retry...`);
      await sleep(backoff);
    }
  }
  return false;
}

/**
 * Launch a browser and return an authenticated context+page.
 * Reuses a persisted session when valid; otherwise runs the login loop and
 * persists the new session.
 *
 * @param {{ headless?: boolean }} opts
 */
export async function getAuthenticatedPage({ headless } = {}) {
  const isHeadless = headless ?? envHeadless();
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      "Missing dependency 'playwright'. Install it with:\n" +
        '  npm install playwright && npx playwright install chromium'
    );
  }

  const browser = await chromium.launch({ headless: isHeadless });
  const haveSession = existsSync(STORAGE_STATE);
  const context = await browser.newContext(
    haveSession ? { storageState: STORAGE_STATE } : {}
  );
  const page = await context.newPage();

  // Probe an auth-only page to see if the cached session still works.
  let authed = false;
  if (haveSession) {
    console.log('♻️  Found cached Delta session — validating...');
    await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    authed = await isLoggedIn(page, 8000);
    console.log(authed ? '✅ Cached session is valid.' : '⌛ Cached session expired — re-authenticating.');
  }

  if (!authed) {
    const creds = await getDeltaCredentials();
    authed = await loginLoop(page, creds, { maxAttempts: Number(process.env.DELTA_LOGIN_ATTEMPTS) || 3 });
    if (!authed) {
      await browser.close();
      throw new Error('Could not authenticate to delta.com after retries.');
    }
    // Persist the fresh session for next time.
    mkdirSync(dirname(STORAGE_STATE), { recursive: true });
    await context.storageState({ path: STORAGE_STATE });
    console.log(`💾 Saved session to ${STORAGE_STATE}`);
  }

  return { browser, context, page };
}

// --- CLI: just prove the auth loop works -----------------------------------
const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  // --headless / --headed override the persisted HEADLESS env for this run.
  const headless = process.argv.includes('--headless')
    ? true
    : process.argv.includes('--headed')
      ? false
      : undefined;
  try {
    const { browser } = await getAuthenticatedPage({ headless });
    console.log('🎉 Authenticated to delta.com.');
    await browser.close();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
