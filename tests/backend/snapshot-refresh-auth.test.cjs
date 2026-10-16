// snapshot-refresh falls back to the site's Robinhood session when the auth
// box is down, so a dead auth box doesn't freeze the trading DB.

const { resolveRhToken } = require('../../netlify/functions/snapshot-refresh.cjs');

describe('resolveRhToken', () => {
  test('prefers the auth box', async () => {
    const errors = [];
    const r = await resolveRhToken(errors, {
      getRhToken: async () => 'box-token',
      getSiteToken: async () => 'site-token',
    });
    expect(r).toEqual({ token: 'box-token', source: 'auth-box' });
    expect(errors).toEqual([]);
  });

  test('falls back to the site session when the auth box is unreachable', async () => {
    const errors = [];
    const r = await resolveRhToken(errors, {
      getRhToken: async () => { throw new Error('auth box unreachable at https://box/token: timed out'); },
      getSiteToken: async () => 'site-token',
    });
    expect(r).toEqual({ token: 'site-token', source: 'site-session' });
    expect(errors[0]).toContain("used the site's Robinhood session instead");
  });

  test('explains both paths when neither has a token', async () => {
    await expect(resolveRhToken([], {
      getRhToken: async () => { throw new Error('auth box unreachable at https://box/token: timed out'); },
      getSiteToken: async () => null,
    })).rejects.toThrow(/auth box unreachable.*Configure page/);
  });

  test('a failing site token store counts as no session', async () => {
    await expect(resolveRhToken([], {
      getRhToken: async () => { throw new Error('RH_AUTH_SERVICE_URL / RH_EXEC_TOKEN not configured'); },
      getSiteToken: async () => { throw new Error('blobs unavailable'); },
    })).rejects.toThrow(/not configured.*No site Robinhood session/);
  });
});
