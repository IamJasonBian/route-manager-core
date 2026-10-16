// robinhood-auth: password grant + Robinhood's device approval (pathfinder),
// stateless across invocations — the client carries the ids between steps.

jest.mock('../../netlify/functions/lib/tokenStore.cjs', () => ({
  getToken: jest.fn(),
  validateToken: jest.fn(),
  setToken: jest.fn(),
  clearToken: jest.fn(),
  getAuthStatus: jest.fn(),
}));

const tokenStore = require('../../netlify/functions/lib/tokenStore.cjs');
const auth = require('../../netlify/functions/robinhood-auth.cjs');

const WORKFLOW = '829cd0f1-ac7f-4d9a-8d49-9545b8d3bf1d';
const MACHINE = '5e0c3c4a-1d7e-4a51-9f0b-3c2d1e0f9a8b';
const CHALLENGE = 'b7f1e2d3-4c5b-4a69-8e7f-0a1b2c3d4e5f';
const LEGACY_CHALLENGE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SESSION = { access_token: 'rh-access', refresh_token: 'rh-refresh', expires_in: 86400, token_type: 'Bearer' };

const event = (params) => ({ httpMethod: 'GET', queryStringParameters: params, headers: {} });
const call = async (params) => {
  const res = await auth.handler(event(params));
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

function response(status, body) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

/**
 * Fake api.robinhood.com. `login` is what the password grant answers until the
 * device is approved; the approval's challenge is `challenge` ({ type, status }).
 */
function fakeRobinhood({
  login = { verification_workflow: { id: WORKFLOW, workflow_status: 'workflow_status_internal_pending' } },
  challenge = { type: 'prompt', status: 'issued' },
  promptStatus = 'issued',
  continueResult = 'workflow_status_approved',
  code = '123456',
} = {}) {
  const state = { approved: false, challenge: challenge && { ...challenge }, promptStatus, legacyAnswered: false, calls: [] };
  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || 'GET';
    let body = null;
    if (typeof opts.body === 'string') body = JSON.parse(opts.body);
    else if (opts.body) body = Object.fromEntries(opts.body);
    state.calls.push({ route: `${method} ${u.pathname}`, body, headers: opts.headers || {} });

    switch (`${method} ${u.pathname}`) {
      case 'POST /oauth2/token/':
        if (state.approved) return response(200, SESSION);
        if (login.mfa_required && body.mfa_code) {
          return body.mfa_code === code ? response(200, SESSION) : response(400, { detail: 'Please enter a valid code.' });
        }
        if (login.challenge && state.legacyAnswered && opts.headers['X-ROBINHOOD-CHALLENGE-RESPONSE-ID'] === login.challenge.id) {
          return response(200, SESSION);
        }
        return response(login.detail ? 400 : 403, login);
      case 'POST /pathfinder/user_machine/':
        return response(200, { id: MACHINE });
      case `GET /pathfinder/inquiries/${MACHINE}/user_view/`:
        return response(200, state.challenge
          ? { sequence: 0, context: { sheriff_challenge: { id: CHALLENGE, ...state.challenge } } }
          : { sequence: 0, context: {} });
      case `GET /push/${CHALLENGE}/get_prompts_status/`:
        return response(200, { challenge_status: state.promptStatus });
      case `POST /challenge/${CHALLENGE}/respond/`:
      case `POST /challenge/${LEGACY_CHALLENGE}/respond/`:
        if (body.response !== code) {
          return response(400, { detail: 'Incorrect code', challenge: { remaining_attempts: 2, status: 'issued' } });
        }
        if (u.pathname.includes(CHALLENGE)) state.challenge.status = 'validated';
        else state.legacyAnswered = true;
        return response(200, { status: 'validated' });
      case `POST /pathfinder/inquiries/${MACHINE}/user_view/`: {
        const passed = state.challenge.status === 'validated' || state.promptStatus === 'validated';
        const result = passed ? continueResult : 'workflow_status_internal_pending';
        state.approved = result === 'workflow_status_approved';
        return response(200, { type_context: { result } });
      }
      default:
        return response(404, { detail: `not mocked: ${method} ${u.pathname}` });
    }
  });
  state.routes = () => state.calls.map(c => c.route);
  state.fetchMock = fetchMock;
  return state;
}

const ENV = { RH_USER: process.env.RH_USER, RH_PASS: process.env.RH_PASS, RH_DEVICE_TOKEN: process.env.RH_DEVICE_TOKEN };

beforeEach(() => {
  process.env.RH_USER = 'trader@example.com';
  process.env.RH_PASS = 'pw';
  delete process.env.RH_DEVICE_TOKEN;
  tokenStore.getToken.mockResolvedValue(null);
  tokenStore.validateToken.mockResolvedValue(false);
  tokenStore.setToken.mockResolvedValue(true);
  tokenStore.clearToken.mockResolvedValue(true);
  tokenStore.getAuthStatus.mockResolvedValue({ authenticated: false, message: 'Not connected to Robinhood' });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('connect → app approval → verify', () => {
  test('connect starts the device approval and returns its ids', async () => {
    const rh = fakeRobinhood();
    const { status, body } = await call({ action: 'connect' });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      authenticated: false,
      status: 'pending',
      requiresVerification: true,
      verificationType: 'device',
      challengeType: 'prompt',
      verification: { workflowId: WORKFLOW, machineId: MACHINE, challengeId: CHALLENGE },
    });
    expect(rh.routes()).toEqual([
      'POST /oauth2/token/',
      'POST /pathfinder/user_machine/',
      `GET /pathfinder/inquiries/${MACHINE}/user_view/`,
    ]);
    // The approval is for the same device the login used
    const [grant, machine] = rh.calls;
    expect(grant.body).toMatchObject({ grant_type: 'password', scope: 'internal', username: 'trader@example.com' });
    expect(machine.body).toEqual({ device_id: grant.body.device_token, flow: 'suv', input: { workflow_id: WORKFLOW } });
    expect(machine.headers['Content-Type']).toBe('application/json');
    expect(tokenStore.setToken).not.toHaveBeenCalled();
  });

  test('verify reports pending until the prompt is approved, without logging in again', async () => {
    const rh = fakeRobinhood();
    const { body } = await call({ action: 'verify', workflowId: WORKFLOW, machineId: MACHINE, challengeId: CHALLENGE });
    expect(body).toMatchObject({ status: 'pending', requiresVerification: true, verification: { machineId: MACHINE, challengeId: CHALLENGE } });
    expect(rh.routes()).toEqual([`GET /pathfinder/inquiries/${MACHINE}/user_view/`, `GET /push/${CHALLENGE}/get_prompts_status/`]);
  });

  test('verify finishes the login once the prompt is approved and stores the session', async () => {
    const rh = fakeRobinhood({ promptStatus: 'validated' });
    const { status, body } = await call({ action: 'verify', workflowId: WORKFLOW, machineId: MACHINE });
    expect(status).toBe(200);
    expect(body).toMatchObject({ authenticated: true, status: 'verified' });
    expect(rh.routes()).toEqual([
      `GET /pathfinder/inquiries/${MACHINE}/user_view/`,
      `GET /push/${CHALLENGE}/get_prompts_status/`,
      `POST /pathfinder/inquiries/${MACHINE}/user_view/`,
      'POST /oauth2/token/',
    ]);
    expect(rh.calls[2].body).toEqual({ sequence: 0, user_input: { status: 'continue' } });
    expect(tokenStore.setToken).toHaveBeenCalledWith('rh-access', 'rh-refresh', 86400);
  });

  test('an approval Robinhood has not finalized stays pending and keeps the ids', async () => {
    const rh = fakeRobinhood({ promptStatus: 'validated', continueResult: 'workflow_status_internal_pending' });
    const { body } = await call({ action: 'verify', workflowId: WORKFLOW, machineId: MACHINE });
    expect(body).toMatchObject({
      status: 'pending',
      requiresVerification: true,
      workflowStatus: 'workflow_status_internal_pending',
      verification: { workflowId: WORKFLOW, machineId: MACHINE, challengeId: CHALLENGE },
    });
    expect(rh.routes()).not.toContain('POST /oauth2/token/');
    expect(tokenStore.setToken).not.toHaveBeenCalled();
  });

  test('a declined or expired approval asks for a fresh start', async () => {
    fakeRobinhood({ promptStatus: 'expired' });
    const { body } = await call({ action: 'verify', machineId: MACHINE });
    expect(body).toMatchObject({ authenticated: false, status: 'error' });
    expect(body.message).toMatch(/expired.*Start/);
  });

  test('a challenge not issued yet is picked up by the next verify', async () => {
    const rh = fakeRobinhood({ challenge: null });
    const connect = await call({ action: 'connect' });
    expect(connect.body).toMatchObject({ status: 'pending', challengeType: null, verification: { workflowId: WORKFLOW, machineId: MACHINE } });
    expect(connect.body.verification.challengeId).toBeUndefined();

    rh.challenge = { type: 'prompt', status: 'issued' };
    const verify = await call({ action: 'verify', ...connect.body.verification });
    expect(verify.body).toMatchObject({ status: 'pending', challengeType: 'prompt', verification: { challengeId: CHALLENGE } });
  });

  test('verify with only the workflow id starts the approval', async () => {
    const rh = fakeRobinhood();
    const { body } = await call({ action: 'verify', workflowId: WORKFLOW });
    expect(body).toMatchObject({ status: 'pending', verification: { workflowId: WORKFLOW, machineId: MACHINE } });
    expect(rh.routes()[0]).toBe('POST /pathfinder/user_machine/');
  });

  test('verify with nothing in progress', async () => {
    const rh = fakeRobinhood();
    const { body } = await call({ action: 'verify' });
    expect(body).toMatchObject({ authenticated: false, status: 'no_pending' });
    expect(rh.calls).toHaveLength(0);
  });
});

describe('codes', () => {
  test('SMS approval: connect asks for the code, mfa answers it and completes the login', async () => {
    const rh = fakeRobinhood({ challenge: { type: 'sms', status: 'issued' } });
    const connect = await call({ action: 'connect' });
    expect(connect.body).toMatchObject({
      status: 'code_required',
      requiresMFA: true,
      challengeType: 'sms',
      verification: { workflowId: WORKFLOW, machineId: MACHINE, challengeId: CHALLENGE },
    });
    expect(connect.body.message).toMatch(/text message/);

    const { body } = await call({ action: 'mfa', code: '123456', ...connect.body.verification });
    expect(body).toMatchObject({ authenticated: true, status: 'verified' });
    const respond = rh.calls.find(c => c.route === `POST /challenge/${CHALLENGE}/respond/`);
    expect(respond.body).toEqual({ response: '123456' });
    expect(respond.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(tokenStore.setToken).toHaveBeenCalledWith('rh-access', 'rh-refresh', 86400);
  });

  test('a wrong code is a 400 naming the attempts left', async () => {
    fakeRobinhood({ challenge: { type: 'email', status: 'issued' } });
    const { status, body } = await call({ action: 'mfa', code: '000000', workflowId: WORKFLOW, machineId: MACHINE, challengeId: CHALLENGE });
    expect(status).toBe(400);
    expect(body.error).toMatch(/rejected the code \(2 attempts left\)/);
    expect(tokenStore.setToken).not.toHaveBeenCalled();
  });

  test('older login challenge: answer it, then log in carrying the challenge id', async () => {
    const rh = fakeRobinhood({ login: { challenge: { id: LEGACY_CHALLENGE, type: 'sms', remaining_attempts: 3 } } });
    const connect = await call({ action: 'connect' });
    expect(connect.body).toMatchObject({ status: 'code_required', challengeType: 'sms', verification: { challengeId: LEGACY_CHALLENGE } });

    const { body } = await call({ action: 'mfa', code: '123456', challengeId: LEGACY_CHALLENGE });
    expect(body).toMatchObject({ authenticated: true });
    const relogin = rh.calls[rh.calls.length - 1];
    expect(relogin.route).toBe('POST /oauth2/token/');
    expect(relogin.headers['X-ROBINHOOD-CHALLENGE-RESPONSE-ID']).toBe(LEGACY_CHALLENGE);
  });

  test('authenticator-app MFA logs in with mfa_code', async () => {
    const rh = fakeRobinhood({ login: { mfa_required: true, mfa_type: 'app' } });
    const connect = await call({ action: 'connect' });
    expect(connect.body).toMatchObject({ status: 'code_required', requiresMFA: true, challengeType: 'app' });

    const { body } = await call({ action: 'mfa', code: '123456' });
    expect(body).toMatchObject({ authenticated: true });
    expect(rh.calls[rh.calls.length - 1].body).toMatchObject({ grant_type: 'password', mfa_code: '123456' });
  });
});

describe('guards and failures', () => {
  test('ids and codes are validated before anything reaches Robinhood', async () => {
    const rh = fakeRobinhood();
    expect((await call({ action: 'verify', machineId: '../../user' })).status).toBe(400);
    expect((await call({ action: 'mfa', code: '123456', challengeId: 'x/../../orders' })).status).toBe(400);
    expect((await call({ action: 'mfa', code: '12ab' })).status).toBe(400);
    expect((await call({ action: 'mfa' })).status).toBe(400);
    expect(rh.calls).toHaveLength(0);
  });

  test('an existing valid session short-circuits connect', async () => {
    const rh = fakeRobinhood();
    tokenStore.getToken.mockResolvedValue('stored');
    tokenStore.validateToken.mockResolvedValue(true);
    const { body } = await call({ action: 'connect' });
    expect(body).toMatchObject({ authenticated: true, message: 'Already authenticated' });
    expect(rh.calls).toHaveLength(0);
  });

  test('bad credentials surface Robinhood\'s reason as a 400', async () => {
    fakeRobinhood({ login: { detail: 'Unable to log in with provided credentials.' } });
    const { status, body } = await call({ action: 'connect' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Unable to log in with provided credentials/);
  });

  test('missing credentials are a 503', async () => {
    delete process.env.RH_PASS;
    fakeRobinhood();
    expect((await call({ action: 'connect' })).status).toBe(503);
  });

  test('a session that cannot be saved is an error, not a silent success', async () => {
    fakeRobinhood({ promptStatus: 'validated' });
    tokenStore.setToken.mockResolvedValue(false);
    const { status, body } = await call({ action: 'verify', machineId: MACHINE });
    expect(status).toBe(500);
    expect(body.error).toMatch(/could not be saved/);
  });

  test('status and disconnect go to the token store', async () => {
    expect((await call({ action: 'status' })).body).toEqual({ authenticated: false, message: 'Not connected to Robinhood' });
    expect((await call({ action: 'disconnect' })).body).toMatchObject({ authenticated: false });
    expect(tokenStore.clearToken).toHaveBeenCalled();
  });
});
