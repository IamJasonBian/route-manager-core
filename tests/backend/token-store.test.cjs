// lib/tokenStore: the Robinhood session lives in the site's robinhood-auth
// blob store (explicit credentials, like the other stores), so every function
// instance sees it, and never in one instance's local file.

const fs = require('fs');
const os = require('os');
const path = require('path');

// One "blob store" shared by every simulated function instance
const mockBlobData = new Map();
jest.mock('@netlify/blobs', () => {
  const store = {
    get: jest.fn(async (key, opts) => {
      if (!mockBlobData.has(key)) return null;
      return opts?.type === 'json' ? mockBlobData.get(key) : JSON.stringify(mockBlobData.get(key));
    }),
    setJSON: jest.fn(async (key, value) => { mockBlobData.set(key, value); }),
    delete: jest.fn(async (key) => { mockBlobData.delete(key); }),
  };
  return { getStore: jest.fn(() => store) };
});

// tokenStore requires the SDK lazily, at call time, so it gets this instance
const blobs = require('@netlify/blobs');

/** A fresh function instance: its own module state, the shared blob store. */
function instance() {
  let tokenStore;
  jest.isolateModules(() => {
    tokenStore = require('../../netlify/functions/lib/tokenStore.cjs');
  });
  return { tokenStore };
}

const ENV_KEYS = ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID', 'NETLIFY_DEV', 'AWS_LAMBDA_FUNCTION_NAME', 'LAMBDA_TASK_ROOT', 'HOME'];
const savedEnv = {};
let tmp;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  mockBlobData.clear();
  blobs.getStore.mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
  process.env.HOME = tmp; // the local file store lives under ~/.tokens
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('deployed', () => {
  beforeEach(() => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'robinhood-auth';
    process.env.NETLIFY_AUTH_TOKEN = 'nf-token';
    process.env.NETLIFY_SITE_ID = 'site-1';
  });

  test('the session saved by one instance is visible to the next', async () => {
    const auth = instance();
    expect(await auth.tokenStore.setToken('rh-access', 'rh-refresh', 3600)).toBe(true);
    expect(blobs.getStore).toHaveBeenCalledWith({ name: 'robinhood-auth', siteID: 'site-1', token: 'nf-token' });
    expect(mockBlobData.get('session')).toMatchObject({ accessToken: 'rh-access', refreshToken: 'rh-refresh' });

    const sync = instance(); // e.g. snapshot-refresh, cold
    expect(await sync.tokenStore.getToken()).toBe('rh-access');
    expect(await sync.tokenStore.getAuthStatus()).toMatchObject({ authenticated: true, hasRefreshToken: true });
    // Nothing went to a local file
    expect(fs.existsSync(path.join(tmp, '.tokens'))).toBe(false);
  });

  test('the device id persists apart from the session', async () => {
    const a = instance();
    expect(await a.tokenStore.setDeviceToken('11111111-2222-4333-8444-555555555555')).toBe(true);
    await a.tokenStore.clearToken();
    expect(await instance().tokenStore.getDeviceToken()).toBe('11111111-2222-4333-8444-555555555555');
  });

  test('without NETLIFY_AUTH_TOKEN a save fails loudly instead of landing in one instance', async () => {
    delete process.env.NETLIFY_AUTH_TOKEN;
    const { tokenStore } = instance();
    expect(await tokenStore.setToken('rh-access', 'rh-refresh', 3600)).toBe(false);
    expect(await tokenStore.setDeviceToken('dev')).toBe(false);
    expect(await tokenStore.getAuthStatus()).toMatchObject({ authenticated: false, error: expect.stringMatching(/NETLIFY_AUTH_TOKEN/) });
    expect(fs.existsSync(path.join(tmp, '.tokens'))).toBe(false);
  });
});

describe('local development', () => {
  test('netlify dev keeps the file store', async () => {
    process.env.NETLIFY_DEV = 'true';
    process.env.NETLIFY_AUTH_TOKEN = 'nf-token'; // even with site credentials around
    const a = instance();
    expect(await a.tokenStore.setToken('local-access', null, 3600)).toBe(true);
    expect(blobs.getStore).not.toHaveBeenCalled();
    expect(await instance().tokenStore.getToken()).toBe('local-access');
  });

  test('a failed local write is reported, not swallowed', async () => {
    process.env.NETLIFY_DEV = 'true';
    const notADir = path.join(tmp, 'file');
    fs.writeFileSync(notADir, '');
    process.env.HOME = notADir; // ~/.tokens cannot be created under a file
    const { tokenStore } = instance();
    expect(await tokenStore.setToken('x', null, 60)).toBe(false);
  });
});
