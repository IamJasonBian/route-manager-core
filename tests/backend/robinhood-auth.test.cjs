// robinhood-auth: password grant + Robinhood's device approval (pathfinder),
// stateless across invocations — the client carries the ids between steps.

jest.mock('../../netlify/functions/lib/tokenStore.cjs', () => ({
  getToken: jest.fn(),
  validateToken: jest.fn(),
  setToken: jest.fn(),
  clearToken: jest.fn(),
  getAuthStatus: jest.fn(),
  getDeviceToken: jest.fn(),
  setDeviceToken: jest.fn(),
}));

const tokenStore = require('../../netlify/functions/lib/tokenStore.cjs');
const auth = require('../../netlify/functions/robinhood-auth.cjs');

const WORKFLOW = '829cd0f1-ac7f-4d9a-8d49-9545b8d3bf1d';
const MACHINE = '5e0c3c4a-1d7e-4a51-9f0b-3c2d1e0f9a8b';
const CHALLENGE = 'b7f1e2d3-4c5b-4a69-8e7f-0a1b2c3d4e5f';
// What Robinhood issues a second device
const WORKFLOW2 = '0d6f1c2b-3a4e-4f5d-8c7b-6a5f4e3d2c1b';
const MACHINE2 = '7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d';
const CHALLENGE2 = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const LEGACY_CHALLENGE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SESSION = { access_token: 'rh-access', refresh_token: 'rh-refresh', expires_in: 86400, token_type: 'Bearer' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const event = (params) => ({ httpMethod: 'GET', queryStringParameters: params, headers: {} });
const call = async (params) => {
  const res = await auth.handler(event(params));
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

function response(status, body) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

/**
 * Fake api.robinhood.com. Each device token gets its own pending workflow:
 * the first device seen gets WORKFLOW with `challenge` / `promptStatus`, any
 * later one WORKFLOW2 with an app prompt in `nextDevicePromptStatus`. `login`
 * is what the password grant answers until that device is approved. For the
 * first device, `closed` makes its inquiry 410 Gone and `machineStatus` fails
 * starting the approval.
 */
function fakeRobinhood({
  login = { verification_workflow: { workflow_status: 'workflow_status_internal_pending' } },
  challenge = { type: 'prompt', status: 'issued' },
  promptStatus = 'issued',
  nextDevicePromptStatus = 'issued',
  continueResult = 'workflow_status_approved',
  code = '123456',
  closed = false,
  machineStatus = 200,
} = {}) {
  const templates = [
    { workflowId: WORKFLOW, machineId: MACHINE, challengeId: CHALLENGE, challenge, promptStatus, closed, machineStatus },
    { workflowId: WORKFLOW2, machineId: MACHINE2, challengeId: CHALLENGE2, challenge: { type: 'prompt', status: 'issued' }, promptStatus: nextDevicePromptStatus, closed: false, machineStatus: 200 },
  ];
  const state = { devices: new Map(), legacyAnswered: false, calls: [] };
  const recordFor = (device) => {
    if (!state.devices.has(device)) {
      const t = templates[Math.min(state.devices.size, 1)];
      state.devices.set(device, {
        device, ...t, challenge: t.challenge && { id: t.challengeId, ...t.challenge }, approved: false,
      });
    }
    return state.devices.get(device);
  };
  const records = () => [...state.devices.values()];

  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || 'GET';
    let body = null;
    if (typeof opts.body === 'string') body = JSON.parse(opts.body);
    else if (opts.body) body = Object.fromEntries(opts.body);
    const route = `${method} ${u.pathname}`;
    state.calls.push({ route, body, headers: opts.headers || {} });

    if (route === 'POST /oauth2/token/') {
      const rec = recordFor(body.device_token);
      if (rec.approved) return response(200, SESSION);
      if (login.mfa_required && body.mfa_code) {
        return body.mfa_code === code ? response(200, SESSION) : response(400, { detail: 'Please enter a valid code.' });
      }
      if (login.challenge && state.legacyAnswered && opts.headers['X-ROBINHOOD-CHALLENGE-RESPONSE-ID'] === login.challenge.id) {
        return response(200, SESSION);
      }
      if (login.verification_workflow) {
        return response(403, { verification_workflow: { ...login.verification_workflow, id: rec.workflowId } });
      }
      return response(login.detail ? 400 : 403, login);
    }
    if (route === 'POST /pathfinder/user_machine/') {
      const rec = records().find(r => r.workflowId === body.input?.workflow_id);
      // The approval belongs to the device that logged in
      if (!rec || rec.device !== body.device_id || body.flow !== 'suv') return response(400, { detail: 'bad user_machine' });
      if (rec.machineStatus !== 200) return response(rec.machineStatus, { detail: 'Workflow is no longer active.' });
      return response(200, { id: rec.machineId });
    }
    const byMachine = records().find(r => u.pathname === `/pathfinder/inquiries/${r.machineId}/user_view/`);
    if (byMachine && byMachine.closed) {
      return response(410, { page: null, context: null, type: 'result', type_context: { result: null }, sequence: -1, state_name: 'Closed' });
    }
    if (byMachine && method === 'GET') {
      return response(200, byMachine.challenge
        ? { sequence: 0, context: { sheriff_challenge: { ...byMachine.challenge } } }
        : { sequence: 0, context: {} });
    }
    if (byMachine && method === 'POST') {
      const passed = byMachine.challenge?.status === 'validated' || byMachine.promptStatus === 'validated';
      const result = passed ? continueResult : 'workflow_status_internal_pending';
      byMachine.approved = result === 'workflow_status_approved';
      return response(200, { type_context: { result } });
    }
    const byPrompt = records().find(r => u.pathname === `/push/${r.challengeId}/get_prompts_status/`);
    if (byPrompt) return response(200, { challenge_status: byPrompt.promptStatus });

    const respond = u.pathname.match(/^\/challenge\/([\w-]+)\/respond\/$/);
    if (respond && method === 'POST') {
      if (body.response !== code) {
        return response(400, { detail: 'Incorrect code', challenge: { remaining_attempts: 2, status: 'issued' } });
      }
      const rec = records().find(r => r.challengeId === respond[1]);
      if (rec) rec.challenge.status = 'validated';
      else if (respond[1] === LEGACY_CHALLENGE) state.legacyAnswered = true;
      return response(200, { status: 'validated' });
    }
    return response(404, { detail: `not mocked: ${route}` });
  });
  state.routes = () => state.calls.map(c => c.route);
  state.fetchMock = fetchMock;
  // The first device's workflow, which the tests advance by hand
  state.primary = () => records()[0];
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
  tokenStore.getDeviceToken.mockResolvedValue(null);
  tokenStore.setDeviceToken.mockResolvedValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Log in once so the fake has a device + workflow, then forget the calls. */
async function started(rh) {
  const res = await call({ action: 'connect' });
  rh.calls.length = 0;
  return res.body;
}

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
      `GET /push/${CHALLENGE}/get_prompts_status/`,
    ]);
    // The approval is for the same device the login used
    const [grant, machine] = rh.calls;
    expect(grant.body).toMatchObject({ grant_type: 'password', scope: 'internal', username: 'trader@example.com' });
    expect(machine.body).toEqual({ device_id: grant.body.device_token, flow: 'suv', input: { workflow_id: WORKFLOW } });
    expect(machine.headers['Content-Type']).toBe('application/json');
    expect(tokenStore.setToken).not.toHaveBeenCalled();
    expect(tokenStore.setDeviceToken).not.toHaveBeenCalled();
  });

  test('verify reports pending until the prompt is approved, without logging in again', async () => {
    const rh = fakeRobinhood();
    const { verification } = await started(rh);
    const { body } = await call({ action: 'verify', ...verification });
    expect(body).toMatchObject({ status: 'pending', requiresVerification: true, verification: { machineId: MACHINE, challengeId: CHALLENGE } });
    expect(rh.routes()).toEqual([`GET /pathfinder/inquiries/${MACHINE}/user_view/`, `GET /push/${CHALLENGE}/get_prompts_status/`]);
  });

  test('verify finishes the login once the prompt is approved and stores the session', async () => {
    const rh = fakeRobinhood();
    const { verification } = await started(rh);
    rh.primary().promptStatus = 'validated'; // tapped Approve in the app

    const { status, body } = await call({ action: 'verify', ...verification });
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
    const rh = fakeRobinhood({ continueResult: 'workflow_status_internal_pending' });
    const { verification } = await started(rh);
    rh.primary().promptStatus = 'validated';

    const { body } = await call({ action: 'verify', ...verification });
    expect(body).toMatchObject({
      status: 'pending',
      requiresVerification: true,
      workflowStatus: 'workflow_status_internal_pending',
      verification: { workflowId: WORKFLOW, machineId: MACHINE, challengeId: CHALLENGE },
    });
    expect(rh.routes()).not.toContain('POST /oauth2/token/');
    expect(tokenStore.setToken).not.toHaveBeenCalled();
  });

  test('an approval that expires while waiting asks for a fresh start', async () => {
    const rh = fakeRobinhood();
    const { verification } = await started(rh);
    rh.primary().promptStatus = 'expired';

    const { body } = await call({ action: 'verify', ...verification });
    expect(body).toMatchObject({ authenticated: false, status: 'error' });
    expect(body.message).toMatch(/expired.*Start/);
  });

  test('an approval Robinhood has closed (410) ends the wait instead of failing', async () => {
    const rh = fakeRobinhood();
    const { verification } = await started(rh);
    rh.primary().closed = true;

    const { status, body } = await call({ action: 'verify', ...verification });
    expect(status).toBe(200);
    expect(body).toMatchObject({ authenticated: false, status: 'error' });
    expect(body.message).toMatch(/closed.*Start/);
    expect(rh.routes()).toEqual([`GET /pathfinder/inquiries/${MACHINE}/user_view/`]);
  });

  test('a challenge not issued yet is picked up by the next verify', async () => {
    const rh = fakeRobinhood({ challenge: null });
    const connect = await call({ action: 'connect' });
    expect(connect.body).toMatchObject({ status: 'pending', challengeType: null, verification: { workflowId: WORKFLOW, machineId: MACHINE } });
    expect(connect.body.verification.challengeId).toBeUndefined();

    rh.primary().challenge = { id: CHALLENGE, type: 'prompt', status: 'issued' };
    const verify = await call({ action: 'verify', ...connect.body.verification });
    expect(verify.body).toMatchObject({ status: 'pending', challengeType: 'prompt', verification: { challengeId: CHALLENGE } });
  });

  test('verify with only the workflow id starts the approval', async () => {
    const rh = fakeRobinhood();
    await started(rh);
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

describe('device id', () => {
  test('an approval that already lapsed moves the login to a new, stored device', async () => {
    // Robinhood keeps handing this device its old workflow, whose prompt expired
    const rh = fakeRobinhood({ promptStatus: 'expired' });
    const { body } = await call({ action: 'connect' });

    expect(tokenStore.setDeviceToken).toHaveBeenCalledTimes(1);
    const device = tokenStore.setDeviceToken.mock.calls[0][0];
    expect(device).toMatch(UUID_RE);
    expect(body).toMatchObject({
      status: 'pending',
      requiresVerification: true,
      challengeType: 'prompt',
      verification: { workflowId: WORKFLOW2, machineId: MACHINE2, challengeId: CHALLENGE2 },
    });
    const grants = rh.calls.filter(c => c.route === 'POST /oauth2/token/');
    expect(grants).toHaveLength(2);
    expect(grants[0].body.device_token).not.toBe(device);
    expect(grants[1].body.device_token).toBe(device);
    expect(rh.calls.filter(c => c.route === 'POST /pathfinder/user_machine/').map(c => c.body.device_id))
      .toEqual([grants[0].body.device_token, device]);
  });

  test.each([
    ['its approval is already closed', { closed: true }],
    ['its workflow can no longer start an approval', { machineStatus: 400 }],
  ])('connect moves to a new device when %s', async (_, opts) => {
    const rh = fakeRobinhood(opts);
    const { body } = await call({ action: 'connect' });
    expect(tokenStore.setDeviceToken).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      status: 'pending',
      verification: { workflowId: WORKFLOW2, machineId: MACHINE2, challengeId: CHALLENGE2 },
    });
    expect(rh.calls.filter(c => c.route === 'POST /oauth2/token/')).toHaveLength(2);
  });

  test('a failure starting the approval that a new device would not fix is reported', async () => {
    fakeRobinhood({ machineStatus: 503 });
    const { status, body } = await call({ action: 'connect' });
    expect(status).toBe(502);
    expect(body.error).toMatch(/didn't start the device approval \(503\)/);
    expect(tokenStore.setDeviceToken).not.toHaveBeenCalled();
  });

  test('later steps log in as the stored device', async () => {
    const rh = fakeRobinhood();
    tokenStore.getDeviceToken.mockResolvedValue('11111111-2222-4333-8444-555555555555');
    const { verification } = await started(rh);
    expect(rh.primary().device).toBe('11111111-2222-4333-8444-555555555555');
    rh.primary().promptStatus = 'validated';

    const { body } = await call({ action: 'verify', ...verification });
    expect(body).toMatchObject({ authenticated: true });
    expect(rh.calls.find(c => c.route === 'POST /oauth2/token/').body.device_token).toBe('11111111-2222-4333-8444-555555555555');
    expect(tokenStore.setDeviceToken).not.toHaveBeenCalled();
  });

  test('a lapsed approval moves device only once per connect', async () => {
    // The new device's prompt has lapsed as well
    fakeRobinhood({ promptStatus: 'expired', nextDevicePromptStatus: 'expired' });
    const { body } = await call({ action: 'connect' });
    expect(tokenStore.setDeviceToken).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ authenticated: false, status: 'error' });
    expect(body.message).toMatch(/expired/);
  });

  test('connect finishes at once when the prompt was already approved', async () => {
    const rh = fakeRobinhood({ promptStatus: 'validated' });
    const { body } = await call({ action: 'connect' });
    expect(body).toMatchObject({ authenticated: true, status: 'verified' });
    expect(rh.routes()).toEqual([
      'POST /oauth2/token/',
      'POST /pathfinder/user_machine/',
      `GET /pathfinder/inquiries/${MACHINE}/user_view/`,
      `GET /push/${CHALLENGE}/get_prompts_status/`,
      `POST /pathfinder/inquiries/${MACHINE}/user_view/`,
      'POST /oauth2/token/',
    ]);
    expect(tokenStore.setToken).toHaveBeenCalledWith('rh-access', 'rh-refresh', 86400);
  });

  test('a new device id that cannot be saved is an error', async () => {
    fakeRobinhood({ promptStatus: 'expired' });
    tokenStore.setDeviceToken.mockResolvedValue(false);
    const { status, body } = await call({ action: 'connect' });
    expect(status).toBe(500);
    expect(body.error).toMatch(/new device id could not be saved/);
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
    expect(rh.routes()).not.toContain(`GET /push/${CHALLENGE}/get_prompts_status/`);

    const { body } = await call({ action: 'mfa', code: '123456', ...connect.body.verification });
    expect(body).toMatchObject({ authenticated: true, status: 'verified' });
    const respond = rh.calls.find(c => c.route === `POST /challenge/${CHALLENGE}/respond/`);
    expect(respond.body).toEqual({ response: '123456' });
    expect(respond.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(tokenStore.setToken).toHaveBeenCalledWith('rh-access', 'rh-refresh', 86400);
  });

  test('a wrong code is a 400 naming the attempts left', async () => {
    const rh = fakeRobinhood({ challenge: { type: 'email', status: 'issued' } });
    const { verification } = await started(rh);
    const { status, body } = await call({ action: 'mfa', code: '000000', ...verification });
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
    const rh = fakeRobinhood();
    const { verification } = await started(rh);
    rh.primary().promptStatus = 'validated';
    tokenStore.setToken.mockResolvedValue(false);
    const { status, body } = await call({ action: 'verify', ...verification });
    expect(status).toBe(500);
    expect(body.error).toMatch(/could not be saved/);
  });

  test('status and disconnect go to the token store', async () => {
    expect((await call({ action: 'status' })).body).toEqual({ authenticated: false, message: 'Not connected to Robinhood' });
    expect((await call({ action: 'disconnect' })).body).toMatchObject({ authenticated: false });
    expect(tokenStore.clearToken).toHaveBeenCalled();
  });
});
