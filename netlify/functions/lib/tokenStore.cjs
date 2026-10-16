// Token Storage using Netlify Blobs (production) or file system (local dev)
// Provides persistent token storage across function invocations

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fetchWithTimeout } = require('./http.cjs');

const ROBINHOOD_API_BASE = 'https://api.robinhood.com';
const STORE_NAME = 'robinhood-auth';
const TOKEN_KEY = 'session';

// Local file fallback path
const LOCAL_TOKEN_FILE = path.join(os.homedir(), '.tokens', 'robinhood-blobs.json');

// In-memory cache (resets on cold start, but Blobs persist)
let cachedToken = null;
let cacheExpiry = null;

// Check if we're running in Netlify PRODUCTION environment (not local dev)
// DEPLOY_ID is only set in actual Netlify deployments, not in `netlify dev`
function isNetlifyProduction() {
  return !!(process.env.DEPLOY_ID && process.env.SITE_ID);
}

/**
 * Get the Netlify Blobs store.
 * Falls back to local file storage when not in Netlify environment.
 */
async function getStore() {
  if (!isNetlifyProduction()) {
    // Return a file-based store for local development
    return {
      async get(key, options) {
        try {
          if (!fs.existsSync(LOCAL_TOKEN_FILE)) return null;
          const data = JSON.parse(fs.readFileSync(LOCAL_TOKEN_FILE, 'utf8'));
          const value = data[key];
          if (!value) return null;
          return options?.type === 'json' ? value : JSON.stringify(value);
        } catch (e) {
          console.error('[LOCAL_STORE] Error reading:', e.message);
          return null;
        }
      },
      async setJSON(key, value) {
        try {
          const dir = path.dirname(LOCAL_TOKEN_FILE);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          let data = {};
          if (fs.existsSync(LOCAL_TOKEN_FILE)) {
            data = JSON.parse(fs.readFileSync(LOCAL_TOKEN_FILE, 'utf8'));
          }
          data[key] = value;
          fs.writeFileSync(LOCAL_TOKEN_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
          console.error('[LOCAL_STORE] Error writing:', e.message);
        }
      },
      async delete(key) {
        try {
          if (!fs.existsSync(LOCAL_TOKEN_FILE)) return;
          const data = JSON.parse(fs.readFileSync(LOCAL_TOKEN_FILE, 'utf8'));
          delete data[key];
          fs.writeFileSync(LOCAL_TOKEN_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
          console.error('[LOCAL_STORE] Error deleting:', e.message);
        }
      },
    };
  }

  // Production: use Netlify Blobs
  const { getStore } = await import('@netlify/blobs');
  return getStore(STORE_NAME);
}

/**
 * Get the stored auth token from Blobs.
 * Returns null if no token or token is expired.
 */
async function getToken() {
  // Check in-memory cache first
  if (cachedToken && cacheExpiry && Date.now() < cacheExpiry) {
    console.log('[TOKEN] Using cached token');
    return cachedToken;
  }

  try {
    const store = await getStore();
    const data = await store.get(TOKEN_KEY, { type: 'json' });

    if (!data) {
      console.log('[TOKEN] No token in store');
      return null;
    }

    // Check if token is expired
    if (data.expiresAt && Date.now() > data.expiresAt) {
      console.log('[TOKEN] Token expired, need to refresh');
      // Try to refresh if we have a refresh token
      if (data.refreshToken) {
        return await refreshToken(data.refreshToken);
      }
      return null;
    }

    // Update cache
    cachedToken = data.accessToken;
    cacheExpiry = data.expiresAt || (Date.now() + 3600000); // Default 1 hour

    console.log('[TOKEN] Loaded token from Blob store');
    return data.accessToken;
  } catch (error) {
    console.error('[TOKEN] Error getting token:', error.message);
    return null;
  }
}

/**
 * Store auth token to Blobs.
 */
async function setToken(accessToken, refreshToken = null, expiresIn = 86400) {
  try {
    const store = await getStore();
    const data = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + (expiresIn * 1000),
      updatedAt: new Date().toISOString(),
    };

    await store.setJSON(TOKEN_KEY, data);

    // Update cache
    cachedToken = accessToken;
    cacheExpiry = data.expiresAt;

    console.log('[TOKEN] Saved token to Blob store');
    return true;
  } catch (error) {
    console.error('[TOKEN] Error saving token:', error.message);
    return false;
  }
}

/**
 * Clear the stored token.
 */
async function clearToken() {
  try {
    const store = await getStore();
    await store.delete(TOKEN_KEY);
    cachedToken = null;
    cacheExpiry = null;
    console.log('[TOKEN] Cleared token from Blob store');
    return true;
  } catch (error) {
    console.error('[TOKEN] Error clearing token:', error.message);
    return false;
  }
}

/**
 * Refresh the access token using the refresh token.
 */
async function refreshToken(refreshTokenValue) {
  console.log('[TOKEN] Attempting to refresh token');

  try {
    const response = await fetchWithTimeout(`${ROBINHOOD_API_BASE}/oauth2/token/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
        scope: 'internal',
        expires_in: '86400',
        client_id: 'c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS',
      }),
    });

    const data = await response.json();

    if (data.access_token) {
      await setToken(data.access_token, data.refresh_token, data.expires_in || 86400);
      console.log('[TOKEN] Token refreshed successfully');
      return data.access_token;
    }

    console.log('[TOKEN] Refresh failed:', JSON.stringify(data));
    return null;
  } catch (error) {
    console.error('[TOKEN] Refresh error:', error.message);
    return null;
  }
}

/**
 * Get auth status for API responses.
 */
async function getAuthStatus() {
  try {
    const store = await getStore();
    const data = await store.get(TOKEN_KEY, { type: 'json' });

    if (!data) {
      return {
        authenticated: false,
        message: 'Not connected to Robinhood',
      };
    }

    const isExpired = data.expiresAt && Date.now() > data.expiresAt;

    return {
      authenticated: !isExpired,
      expiresAt: data.expiresAt ? new Date(data.expiresAt).toISOString() : null,
      expiresIn: data.expiresAt ? Math.max(0, Math.floor((data.expiresAt - Date.now()) / 1000)) : null,
      hasRefreshToken: !!data.refreshToken,
      updatedAt: data.updatedAt,
      message: isExpired ? 'Token expired, reconnect required' : 'Connected to Robinhood',
    };
  } catch (error) {
    return {
      authenticated: false,
      error: error.message,
      message: 'Error checking auth status',
    };
  }
}

/**
 * Validate token by making a test API call.
 */
async function validateToken(token) {
  try {
    // Short budget: callers follow up with another RH request
    const response = await fetchWithTimeout(`${ROBINHOOD_API_BASE}/user/`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    }, 4000);
    return response.ok;
  } catch (error) {
    return false;
  }
}

module.exports = {
  getToken,
  setToken,
  clearToken,
  refreshToken,
  getAuthStatus,
  validateToken,
};
