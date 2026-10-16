// Robinhood Authentication Netlify Function
// Logs the site into Robinhood and stores the session in Netlify Blobs
// (lib/tokenStore) for snapshot-refresh and the other Robinhood functions.
//
// Device approval ("pathfinder"): when the password grant answers with a
// verification_workflow, POST /pathfinder/user_machine/ starts the approval
// and its inquiry's sheriff_challenge says how to pass it — `prompt` (tap
// Approve in the Robinhood app; /push/{id}/get_prompts_status/ turns
// `validated`) or `sms` / `email` (POST the code to /challenge/{id}/respond/).
// Posting `continue` to the inquiry then approves the workflow, and the
// password grant returns a token for this device.
//
// Function instances don't share memory, so every step is stateless: connect
// returns the ids in `verification` and the client passes them back.
//
//   ?action=status
//   ?action=connect
//   ?action=verify&workflowId=&machineId=
//   ?action=mfa&code=[&workflowId=&machineId=&challengeId=]
//   ?action=disconnect

const tokenStore = require('./lib/tokenStore.cjs');
const { CORS, fetchWithTimeout } = require('./lib/http.cjs');

const ROBINHOOD_API_BASE = 'https://api.robinhood.com';
const CLIENT_ID = 'c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS';
// Version header robin-stocks sends with the same login / pathfinder calls
const RH_API_VERSION = '1.431.4';
// Netlify kills sync functions at 10s; all Robinhood calls share this budget
const BUDGET_MS = 9000;
// Ids go into Robinhood URL paths
const ID_RE = /^[\w-]{6,80}$/;
const CODE_RE = /^\d{4,10}$/;
const CODE_CHANNEL = { sms: 'text message', email: 'email' };
const CHALLENGE_FAILED = new Set(['expired', 'failed', 'denied', 'declined', 'canceled', 'cancelled']);

const corsHeaders = { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

/** Error carrying an HTTP status for the handler's catch block. */
function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function generateDeviceToken() {
  if (process.env.RH_DEVICE_TOKEN) {
    return process.env.RH_DEVICE_TOKEN;
  }
  const username = process.env.RH_USER || '';
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    const char = username.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `${Math.abs(hash).toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
}

/** Remaining time for the next Robinhood call in this invocation. */
function deadline(ms = BUDGET_MS) {
  const end = Date.now() + ms;
  return () => Math.max(1000, end - Date.now());
}

/** Robinhood request → { status, ok, data }; HTTP errors don't throw. */
async function rh(path, { method = 'GET', json, form, headers = {} } = {}, timeoutMs) {
  const response = await fetchWithTimeout(`${ROBINHOOD_API_BASE}${path}`, {
    method,
    headers: {
      'Accept': 'application/json',
      'X-Robinhood-API-Version': RH_API_VERSION,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : form ? new URLSearchParams(form) : undefined,
  }, timeoutMs);
  const text = await response.text();
  let data = {};
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch {
    data = { detail: text.slice(0, 200) };
  }
  return { status: response.status, ok: response.ok, data };
}

/** Short reason from a Robinhood error body. */
function reason(data) {
  const r = data.detail || data.error_description || data.error || data.message;
  return typeof r === 'string' ? r : JSON.stringify(data).slice(0, 200);
}

function passwordGrant(left, extra = {}, headers = {}) {
  const username = process.env.RH_USER;
  const password = process.env.RH_PASS;
  if (!username || !password) {
    throw httpError(503, 'RH_USER and RH_PASS environment variables are required');
  }
  return rh('/oauth2/token/', {
    method: 'POST',
    form: {
      grant_type: 'password',
      scope: 'internal',
      client_id: CLIENT_ID,
      expires_in: '86400',
      username,
      password,
      device_token: generateDeviceToken(),
      ...extra,
    },
    headers,
  }, left());
}

async function saveSession(data) {
  const saved = await tokenStore.setToken(data.access_token, data.refresh_token, data.expires_in || 86400);
  if (!saved) throw new Error('Robinhood login succeeded but the session could not be saved');
  return { authenticated: true, status: 'verified', message: 'Connected to Robinhood.' };
}

/** Next step for a login that still needs the device approval or a code. */
function pendingResult(verification, challenge) {
  const ids = { ...verification, ...(challenge ? { challengeId: challenge.id } : {}) };
  if (challenge && CODE_CHANNEL[challenge.type]) {
    return {
      authenticated: false,
      status: 'code_required',
      requiresMFA: true,
      verificationType: 'mfa',
      challengeType: challenge.type,
      verification: ids,
      message: `Enter the code Robinhood sent by ${CODE_CHANNEL[challenge.type]}.`,
    };
  }
  return {
    authenticated: false,
    status: 'pending',
    requiresVerification: true,
    verificationType: 'device',
    challengeType: challenge ? challenge.type : null,
    verification: ids,
    message: challenge
      ? 'Approve the login in the Robinhood app, then press Check.'
      : 'Waiting for Robinhood to send the approval request. Press Check in a few seconds.',
  };
}

/** The approval's current challenge: { id, type: prompt | sms | email, status }, or null. */
async function readChallenge(machineId, left) {
  const { ok, status, data } = await rh(`/pathfinder/inquiries/${encodeURIComponent(machineId)}/user_view/`, {}, left());
  if (!ok) throw httpError(502, `Robinhood approval lookup failed (${status}): ${reason(data)}`);
  const c = data.context?.sheriff_challenge || data.type_context?.context?.sheriff_challenge;
  return c && c.id ? { id: c.id, type: c.type, status: c.status } : null;
}

async function startApproval(workflowId, left) {
  const machine = await rh('/pathfinder/user_machine/', {
    method: 'POST',
    json: { device_id: generateDeviceToken(), flow: 'suv', input: { workflow_id: workflowId } },
  }, left());
  if (!machine.ok || !machine.data.id) {
    throw httpError(502, `Robinhood didn't start the device approval (${machine.status}): ${reason(machine.data)}`);
  }
  const verification = { workflowId, machineId: machine.data.id };
  // Usually issued at once; if not, verify picks it up
  let challenge = null;
  try {
    challenge = await readChallenge(verification.machineId, left);
  } catch (e) {
    console.warn('[AUTH] Challenge lookup after start:', e.message);
  }
  return pendingResult(verification, challenge);
}

/** Approve the workflow, then log in again for this device's token. */
async function finishApproval(verification, left) {
  const cont = await rh(`/pathfinder/inquiries/${encodeURIComponent(verification.machineId)}/user_view/`, {
    method: 'POST',
    json: { sequence: 0, user_input: { status: 'continue' } },
  }, left());
  const result = cont.data.type_context?.result || cont.data.verification_workflow?.workflow_status || null;
  if (result !== 'workflow_status_approved') {
    return {
      ...pendingResult(verification, null),
      workflowStatus: result,
      message: `Approved; Robinhood is still finalizing the login (${result || `HTTP ${cont.status}`}). Press Check again.`,
    };
  }
  const grant = await passwordGrant(left);
  if (grant.data.access_token) return saveSession(grant.data);
  throw httpError(502, `Robinhood approved the device but the login returned no session (${grant.status}): ${reason(grant.data)}`);
}

/**
 * Start a login. Returns the verification step Robinhood asks for, if any.
 */
async function initiateAuth() {
  const left = deadline();

  // Check if we already have a valid token
  const existingToken = await tokenStore.getToken();
  if (existingToken && await tokenStore.validateToken(existingToken)) {
    return { authenticated: true, message: 'Already authenticated' };
  }

  console.log('[AUTH] Initiating authentication');
  const { status, data } = await passwordGrant(left);

  if (data.access_token) return saveSession(data);

  if (data.verification_workflow?.id) {
    return startApproval(data.verification_workflow.id, left);
  }

  // Account MFA (authenticator app, or a texted code)
  if (data.mfa_required) {
    const type = data.mfa_type || 'app';
    return {
      authenticated: false,
      status: 'code_required',
      requiresMFA: true,
      verificationType: 'mfa',
      challengeType: type,
      verification: {},
      message: CODE_CHANNEL[type]
        ? `Enter the code Robinhood sent by ${CODE_CHANNEL[type]}.`
        : 'Enter the code from your authenticator app.',
    };
  }

  // Older SMS / email challenge on the login itself
  if (data.challenge?.id) {
    const type = data.challenge.type || 'sms';
    return {
      authenticated: false,
      status: 'code_required',
      requiresMFA: true,
      verificationType: 'mfa',
      challengeType: type,
      verification: { challengeId: data.challenge.id },
      message: `Enter the code Robinhood sent by ${CODE_CHANNEL[type] || type}.`,
    };
  }

  console.error('[AUTH] Unexpected response:', status, reason(data));
  throw httpError(status >= 400 && status < 500 ? 400 : 502, `Robinhood login failed (${status}): ${reason(data)}`);
}

/**
 * Poll the device approval; completes the login once it's approved.
 */
async function checkVerification(verification) {
  const left = deadline();
  const { workflowId, machineId } = verification;
  if (!machineId) {
    if (!workflowId) {
      return { authenticated: false, status: 'no_pending', message: 'No login in progress. Press Start to begin.' };
    }
    return startApproval(workflowId, left);
  }

  const challenge = await readChallenge(machineId, left);
  if (!challenge) return pendingResult(verification, null);

  let state = challenge.status;
  if (state !== 'validated' && challenge.type === 'prompt') {
    const prompt = await rh(`/push/${encodeURIComponent(challenge.id)}/get_prompts_status/`, {}, left());
    if (!prompt.ok) throw httpError(502, `Robinhood prompt status failed (${prompt.status}): ${reason(prompt.data)}`);
    state = prompt.data.challenge_status || state;
  }
  if (CHALLENGE_FAILED.has(state)) {
    return {
      authenticated: false,
      status: 'error',
      message: `Robinhood reports the approval as ${state}. Press Start to send a new one.`,
    };
  }
  if (state !== 'validated') return pendingResult(verification, challenge);
  return finishApproval({ ...verification, challengeId: challenge.id }, left);
}

/**
 * Submit a code: the approval's SMS / email challenge, an older login
 * challenge, or an authenticator-app MFA code.
 */
async function submitMFA(code, verification) {
  const left = deadline();
  const { machineId, challengeId } = verification;

  if (challengeId) {
    const answer = await rh(`/challenge/${encodeURIComponent(challengeId)}/respond/`, {
      method: 'POST',
      form: { response: code },
    }, left());
    if (answer.data.status !== 'validated') {
      const remaining = answer.data.challenge?.remaining_attempts;
      const detail = typeof answer.data.detail === 'string' ? `: ${answer.data.detail}` : '';
      throw httpError(400, `Robinhood rejected the code${remaining != null ? ` (${remaining} attempts left)` : ''}${detail}`);
    }
    if (machineId) return finishApproval(verification, left);

    // Older login challenge: log in again carrying the answered challenge
    const grant = await passwordGrant(left, {}, { 'X-ROBINHOOD-CHALLENGE-RESPONSE-ID': challengeId });
    if (grant.data.access_token) return saveSession(grant.data);
    throw httpError(502, `Robinhood accepted the code but the login returned no session (${grant.status}): ${reason(grant.data)}`);
  }

  console.log('[MFA] Submitting MFA code');
  const grant = await passwordGrant(left, { mfa_code: code });
  if (grant.data.access_token) return saveSession(grant.data);
  throw httpError(400, `MFA verification failed: ${reason(grant.data)}`);
}

/**
 * Disconnect - clear stored token.
 */
async function disconnect() {
  await tokenStore.clearToken();
  return {
    authenticated: false,
    message: 'Disconnected from Robinhood',
  };
}

/** workflowId / machineId / challengeId from the query, validated. */
function verificationParams(params) {
  const out = {};
  for (const key of ['workflowId', 'machineId', 'challengeId']) {
    const value = params[key];
    if (value == null || value === '') continue;
    if (!ID_RE.test(value)) throw httpError(400, `Invalid ${key}`);
    out[key] = value;
  }
  return out;
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  try {
    const params = event.queryStringParameters || {};
    const action = params.action || 'status';

    let result;
    switch (action) {
      case 'status':
        result = await tokenStore.getAuthStatus();
        break;

      case 'connect':
      case 'login':
        result = await initiateAuth();
        break;

      case 'verify':
        result = await checkVerification(verificationParams(params));
        break;

      case 'mfa': {
        const code = (params.code || '').trim();
        if (!code) {
          throw httpError(400, 'MFA code required. Use ?action=mfa&code=YOUR_CODE');
        }
        if (!CODE_RE.test(code)) throw httpError(400, 'The code should be digits only');
        result = await submitMFA(code, verificationParams(params));
        break;
      }

      case 'disconnect':
      case 'logout':
        result = await disconnect();
        break;

      default:
        throw httpError(400, `Unknown action: ${action}. Available: status, connect, verify, mfa, disconnect`);
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error('Auth error:', error);

    return {
      statusCode: error.statusCode || 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        authenticated: false,
        error: error.message || 'An error occurred',
      }),
    };
  }
};
