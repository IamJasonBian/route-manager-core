// aa.com (American Airlines) authentication loop (Playwright).
//
// Mirrors delta-auth.mjs — same login LOOP + session-reuse strategy, pointed at
// aa.com with AA_SEL_* selector overrides and the aa.com credential seam.
//
// Responsibilities:
//   1. Reuse a persisted browser session (storageState) when it is still valid,
//      so we don't log in on every run.
//   2. When there is no valid session, run a resilient login LOOP: fill the
//      form, handle an MFA/OTP challenge interactively, retry on transient
//      failure with backoff, and persist the session on success.
//
// NOTE: AA's site markup and bot defenses (Akamai) change over time. Selectors
// are kept in AA_SELECTORS and can be overridden via env without editing code.
// Defaults below are BEST-EFFORT guesses — expect to tune them against the live
// site. This automates YOUR OWN AAdvantage account.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import '../load-env.mjs';
import { getAaCredentials } from '../gcloud/get-aa-credentials.mjs';

// Session cache lives under a gitignored dir alongside the repo root.
export const STORAGE_STATE =
  process.env.AA_STORAGE_STATE || resolve(process.cwd(), '.secrets/aa-storage-state.json');

const LOGIN_URL = process.env.AA_LOGIN_URL || 'https://www.aa.com/login';
// A page that only renders when authenticated — used to test the session.
const ACCOUNT_URL =
  process.env.AA_ACCOUNT_URL || 'https://www.aa.com/aadvantage-program/profile/account-summary';

// Override any selector via env (e.g. AA_SEL_USERNAME='#user') if AA moves.
const AA_SELECTORS = {
  username: process.env.AA_SEL_USERNAME || '#loginId, input[name="loginId"], #login-id, input[name="username"]',
  password: process.env.AA_SEL_PASSWORD || '#password, input[name="password"], #login-password',
  submit: process.env.AA_SEL_SUBMIT || 'button[type="submit"], #buttonLogin, button:has-text("Log in")',
  // Markers that the login screen wants a one-time passcode.
  mfaPrompt: process.env.AA_SEL_MFA || 'input[name*="otp"], input[name*="code"], input[name*="securityCode"], #verificationCode',
  mfaSubmit: process.env.AA_SEL_MFA_SUBMIT || 'button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")',
  // Markers that we are logged in.
  loggedIn: process.env.AA_SEL_LOGGEDIN || '[data-testid="account-menu"], .aadvantage-number, a[href*="logout"], a[href*="account-summary"]',
  // Markers of a rejected login.
  error: process.env.AA_SEL_ERROR || '.error-message, [role="alert"], .alert-danger, .aaErrorMessage',
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
    await page.waitForSelector(AA_SELECTORS.loggedIn, { timeout });
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

  await page.fill(AA_SELECTORS.username, creds.username);
  await page.fill(AA_SELECTORS.password, creds.password);
  await page.click(AA_SELECTORS.submit);

  // Race the possible outcomes.
  const outcome = await Promise.race([
    page.waitForSelector(AA_SELECTORS.loggedIn, { timeout: 20000 }).then(() => 'ok').catch(() => null),
    page.waitForSelector(AA_SELECTORS.mfaPrompt, { timeout: 20000 }).then(() => 'mfa').catch(() => null),
    page.waitForSelector(AA_SELECTORS.error, { timeout: 20000 }).then(() => 'error').catch(() => null),
  ]);

  return outcome || 'unknown';
}

/** Handle an interactive OTP / MFA challenge. */
async function handleMfa(page) {
  console.log('🔢 AA is asking for a one-time passcode (check your email/SMS/app).');
  const code = await prompt('   Enter the code: ');
  await page.fill(AA_SELECTORS.mfaPrompt, code);
  await page.click(AA_SELECTORS.mfaSubmit).catch(() => {});
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
        const msg = await page.textContent(AA_SELECTORS.error).catch(() => '');
        console.log(`   Login rejected: ${(msg || '').trim().slice(0, 200)}`);
        // Bad credentials won't fix themselves on retry — bail early.
        throw new Error('AA rejected the credentials. Re-seed with put-aa-credentials.sh.');
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
    console.log('♻️  Found cached AA session — validating...');
    await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    authed = await isLoggedIn(page, 8000);
    console.log(authed ? '✅ Cached session is valid.' : '⌛ Cached session expired — re-authenticating.');
  }

  if (!authed) {
    const creds = await getAaCredentials();
    authed = await loginLoop(page, creds, { maxAttempts: Number(process.env.AA_LOGIN_ATTEMPTS) || 3 });
    if (!authed) {
      await browser.close();
      throw new Error('Could not authenticate to aa.com after retries.');
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
    console.log('🎉 Authenticated to aa.com.');
    await browser.close();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
