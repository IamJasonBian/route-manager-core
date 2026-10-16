import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import ConfigurePage from './ConfigurePage';

const mockAuthStatus = jest.fn();
const mockConnect = jest.fn();
const mockVerify = jest.fn();
const mockMfa = jest.fn();

jest.mock('../services/robinhoodService', () => ({
  getAuthStatus: (...args: unknown[]) => mockAuthStatus(...args),
  connectRobinhood: (...args: unknown[]) => mockConnect(...args),
  checkVerification: (...args: unknown[]) => mockVerify(...args),
  submitMFA: (...args: unknown[]) => mockMfa(...args),
  disconnectRobinhood: jest.fn(),
}));

jest.mock('../services/plaidService', () => ({
  createLinkToken: jest.fn(),
  exchangePublicToken: jest.fn(),
  getPlaidStatus: () => Promise.resolve({ connected: false, message: 'Not connected' }),
  disconnectPlaid: jest.fn(),
}));

jest.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: jest.fn(), ready: false }),
}));

const IDS = { workflowId: 'wf-0000001', machineId: 'machine-0001', challengeId: 'challenge-01' };

/** The Robinhood card — Plaid's card has its own Start button. */
async function robinhoodCard() {
  const heading = await screen.findByText('Agent Onboarding');
  return within(heading.closest('.p-6') as HTMLElement);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthStatus.mockResolvedValue({ authenticated: false, message: 'Not connected to Robinhood' });
});

test('Robinhood login works without Plaid and carries the approval ids through each step', async () => {
  mockConnect.mockResolvedValue({
    authenticated: false, status: 'pending', requiresVerification: true, verificationType: 'device',
    challengeType: 'prompt', verification: IDS, message: 'Approve the login in the Robinhood app, then press Check.',
  });
  render(<ConfigurePage />);
  const card = await robinhoodCard();

  const start = card.getByRole('button', { name: /start/i }) as HTMLButtonElement;
  expect(start.disabled).toBe(false);
  fireEvent.click(start);
  await card.findByText(/Approve the login in the Robinhood app/);

  // Still waiting → stays on Check with the same ids
  mockVerify.mockResolvedValueOnce({
    authenticated: false, status: 'pending', requiresVerification: true, verification: IDS, message: 'Waiting for approval',
  });
  fireEvent.click(card.getByRole('button', { name: /check/i }));
  await card.findByText('Waiting for approval');
  expect(mockVerify).toHaveBeenLastCalledWith(IDS);

  // Robinhood switches to a texted code
  mockVerify.mockResolvedValueOnce({
    authenticated: false, status: 'code_required', requiresMFA: true, challengeType: 'sms',
    verification: IDS, message: 'Enter the code Robinhood sent by text message.',
  });
  fireEvent.click(card.getByRole('button', { name: /check/i }));
  const input = await card.findByLabelText('Robinhood verification code');

  mockMfa.mockResolvedValue({ authenticated: true, status: 'verified', message: 'Connected to Robinhood.' });
  mockAuthStatus.mockResolvedValue({ authenticated: true, message: 'Connected to Robinhood', expiresIn: 86400 });
  fireEvent.change(input, { target: { value: '123456' } });
  fireEvent.click(card.getByRole('button', { name: /submit/i }));

  await card.findByText('Connected to Robinhood.');
  expect(mockMfa).toHaveBeenCalledWith('123456', IDS);
  await waitFor(() => card.getByRole('button', { name: /disconnect/i }));
});

test('an approval that ends shows the error and returns to Start', async () => {
  mockConnect.mockResolvedValue({ authenticated: false, requiresVerification: true, verification: IDS, message: 'Approve' });
  mockVerify.mockResolvedValue({ authenticated: false, status: 'error', message: 'Robinhood reports the approval as expired. Press Start to send a new one.' });
  render(<ConfigurePage />);
  const card = await robinhoodCard();

  fireEvent.click(card.getByRole('button', { name: /start/i }));
  fireEvent.click(await card.findByRole('button', { name: /check/i }));

  await card.findByText(/approval as expired/);
  expect((card.getByRole('button', { name: /start/i }) as HTMLButtonElement).disabled).toBe(false);
});

test('waiting on the app approval checks on its own and connects once approved', async () => {
  jest.useFakeTimers();
  try {
    const waiting = { authenticated: false, status: 'pending', requiresVerification: true, verification: IDS, message: 'Approve the login in the Robinhood app.' };
    mockConnect.mockResolvedValue(waiting);
    mockVerify
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce({ authenticated: true, status: 'verified', message: 'Connected to Robinhood.' });
    render(<ConfigurePage />);
    const card = await robinhoodCard();

    fireEvent.click(card.getByRole('button', { name: /start/i }));
    await card.findByText('Approve the login in the Robinhood app.');
    expect(mockVerify).not.toHaveBeenCalled();

    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenLastCalledWith(IDS);

    await act(async () => { jest.advanceTimersByTime(4000); });
    await card.findByText('Connected to Robinhood.');
    expect(mockVerify).toHaveBeenCalledTimes(2);

    // Connected — no more checks
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(mockVerify).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

test('the automatic checks stop after ten minutes and leave Check to the user', async () => {
  jest.useFakeTimers();
  try {
    const waiting = { authenticated: false, status: 'pending', requiresVerification: true, verification: IDS, message: 'Approve the login in the Robinhood app.' };
    mockConnect.mockResolvedValue(waiting);
    mockVerify.mockResolvedValue(waiting);
    render(<ConfigurePage />);
    const card = await robinhoodCard();

    fireEvent.click(card.getByRole('button', { name: /start/i }));
    await card.findByText('Approve the login in the Robinhood app.');
    for (let i = 0; i < 160; i++) {
      await act(async () => { jest.advanceTimersByTime(4000); });
    }
    const calls = mockVerify.mock.calls.length;
    expect(calls).toBeGreaterThan(140);
    expect(calls).toBeLessThanOrEqual(150);
    await card.findByText(/Still waiting/);
    expect(card.getByRole('button', { name: /check/i })).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});
