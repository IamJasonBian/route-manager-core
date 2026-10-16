import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Shield,
  TrendingUp,
  Link,
  Unlink,
  Loader2,
  Lock,
  Bot,
} from 'lucide-react';
import { usePlaidLink } from 'react-plaid-link';
import {
  createLinkToken,
  exchangePublicToken,
  getPlaidStatus,
  disconnectPlaid,
  PlaidAuthStatus,
} from '../services/plaidService';
import {
  getAuthStatus,
  connectRobinhood,
  checkVerification,
  submitMFA,
  disconnectRobinhood,
  AuthResult,
  AuthStatus,
  VerificationIds,
} from '../services/robinhoodService';

function PlaidOnboarding({
  plaidStatus,
  onPlaidChange,
}: {
  plaidStatus: PlaidAuthStatus | null;
  onPlaidChange: () => void;
}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [plaidLoading, setPlaidLoading] = useState(false);
  const [plaidError, setPlaidError] = useState<string | null>(null);

  const handleConnect = async () => {
    setPlaidLoading(true);
    setPlaidError(null);
    try {
      const resp = await createLinkToken();
      setLinkToken(resp.linkToken);
    } catch (err) {
      setPlaidError(err instanceof Error ? err.message : 'Failed to initialize Plaid');
    } finally {
      setPlaidLoading(false);
    }
  };

  const onSuccess = useCallback(async (publicToken: string) => {
    setPlaidLoading(true);
    setPlaidError(null);
    try {
      await exchangePublicToken(publicToken);
      setLinkToken(null);
      onPlaidChange();
    } catch (err) {
      setPlaidError(err instanceof Error ? err.message : 'Failed to connect account');
    } finally {
      setPlaidLoading(false);
    }
  }, [onPlaidChange]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => setLinkToken(null),
  });

  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  const handleDisconnect = async () => {
    setPlaidLoading(true);
    setPlaidError(null);
    try {
      await disconnectPlaid();
      onPlaidChange();
    } catch (err) {
      setPlaidError(err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setPlaidLoading(false);
    }
  };

  const isConnected = plaidStatus?.connected;

  return (
    <div className="bg-white dark:bg-zinc-950 rounded-lg border border-gray-200 dark:border-zinc-800 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${isConnected ? 'bg-green-100 dark:bg-green-900/30' : 'bg-gray-100 dark:bg-zinc-800'}`}>
            <Shield className={`w-5 h-5 ${isConnected ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'}`} />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">Portfolio Onboarding</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {isConnected
                ? `Connected${plaidStatus?.institutionName ? ` — ${plaidStatus.institutionName}` : ''}`
                : 'Start portfolio onboarding'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isConnected ? (
            <button
              onClick={handleDisconnect}
              disabled={plaidLoading}
              className="flex items-center gap-2 px-4 py-2 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
            >
              <Unlink className="w-4 h-4" />
              Disconnect
            </button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={plaidLoading}
              className="flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 text-sm whitespace-nowrap"
            >
              {plaidLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Link className="w-4 h-4" />
              )}
              Start
            </button>
          )}
        </div>
      </div>

      {plaidError && (
        <div className="mt-3 p-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-400">
          {plaidError}
        </div>
      )}
    </div>
  );
}

/** While waiting on the app approval, check this often: Robinhood closes it minutes after sending. */
const APPROVAL_POLL_MS = 4_000;
/** Then stop and leave Check to the user. */
const APPROVAL_POLL_MAX_MS = 10 * 60_000;

function AgentOnboarding({
  authStatus,
  onAuthChange,
}: {
  authStatus: AuthStatus | null;
  onAuthChange: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [authState, setAuthState] = useState<'idle' | 'device' | 'mfa'>('idle');
  // Robinhood's approval ids — the server keeps no login state between calls
  const [verification, setVerification] = useState<VerificationIds | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One verify call at a time, whether from Check or the poll below
  const checking = useRef(false);
  const verificationRef = useRef(verification);

  const resetLogin = () => {
    setAuthState('idle');
    setVerification(undefined);
    setMfaCode('');
  };

  /** Move to whatever step Robinhood asks for next. */
  const applyResult = (result: AuthResult, fallbackError: string) => {
    if (result.authenticated) {
      resetLogin();
      setMessage(result.message || 'Connected!');
      onAuthChange();
    } else if (result.requiresMFA) {
      setVerification(result.verification);
      setAuthState('mfa');
      setMessage(result.message || 'Enter the code');
    } else if (result.requiresVerification) {
      setVerification(result.verification);
      setAuthState('device');
      setMessage(result.message || 'Approve in the Robinhood app');
    } else {
      resetLogin();
      setMessage(null);
      setError(result.error || result.message || fallbackError);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    setMessage(null);

    try {
      applyResult(await connectRobinhood(), 'Connection failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const handleVerify = async () => {
    if (checking.current) return;
    checking.current = true;
    setVerifying(true);
    setError(null);

    try {
      applyResult(await checkVerification(verification), 'Verification failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      checking.current = false;
      setVerifying(false);
    }
  };

  // The poll reads the latest ids and handler without restarting
  const applyRef = useRef(applyResult);
  useEffect(() => {
    verificationRef.current = verification;
    applyRef.current = applyResult;
  });

  // Waiting on the app approval: check every few seconds so the login
  // completes as soon as it's approved
  useEffect(() => {
    if (authState !== 'device') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + APPROVAL_POLL_MAX_MS;

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        setMessage('Still waiting. After approving in the Robinhood app press Check, or Cancel and Start to send a new request.');
        return;
      }
      if (!checking.current) {
        checking.current = true;
        try {
          const result = await checkVerification(verificationRef.current);
          if (cancelled) return;
          setError(null);
          applyRef.current(result, 'Verification failed');
          if (!result.requiresVerification) return; // connected, a code, or lapsed
        } catch (err) {
          // Keep polling through a failed check (timeout, Robinhood 5xx)
          if (!cancelled) setError(err instanceof Error ? err.message : 'Verification failed');
        } finally {
          checking.current = false;
        }
      }
      if (!cancelled) timer = setTimeout(poll, APPROVAL_POLL_MS);
    };

    timer = setTimeout(poll, APPROVAL_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authState]);

  const handleMFA = async () => {
    if (!mfaCode.trim()) return;

    setConnecting(true);
    setError(null);

    try {
      applyResult(await submitMFA(mfaCode.trim(), verification), 'MFA failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MFA failed');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setConnecting(true);
    try {
      await disconnectRobinhood();
      setAuthState('idle');
      setMessage(null);
      onAuthChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setConnecting(false);
    }
  };

  const isConnected = authStatus?.authenticated;

  return (
    <div className="bg-white dark:bg-zinc-950 rounded-lg border border-gray-200 dark:border-zinc-800 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${isConnected ? 'bg-green-100 dark:bg-green-900/30' : 'bg-orange-100 dark:bg-orange-900/30'}`}>
            <Bot className={`w-5 h-5 ${isConnected ? 'text-green-600 dark:text-green-400' : 'text-orange-600 dark:text-orange-400'}`} />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">Agent Onboarding</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {isConnected
                ? `Connected — Robinhood • Expires in ${Math.floor((authStatus?.expiresIn || 0) / 3600)}h`
                : 'Connect Robinhood to sync fills and positions'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {authState === 'idle' && (
            <>
              {isConnected ? (
                <button
                  onClick={handleDisconnect}
                  disabled={connecting}
                  className="flex items-center gap-2 px-4 py-2 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
                >
                  <Unlink className="w-4 h-4" />
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={handleConnect}
                  disabled={connecting}
                  className="flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 text-sm whitespace-nowrap"
                >
                  {connecting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <TrendingUp className="w-4 h-4" />
                  )}
                  Start
                </button>
              )}
            </>
          )}

          {authState === 'device' && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-yellow-600 dark:text-yellow-400">Waiting for approval…</span>
              <button
                onClick={handleVerify}
                disabled={verifying}
                className="flex items-center gap-2 px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50"
              >
                {verifying ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <TrendingUp className="w-4 h-4" />
                )}
                Check
              </button>
              <button
                onClick={resetLogin}
                className="px-3 py-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                Cancel
              </button>
            </div>
          )}

          {authState === 'mfa' && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="Code"
                aria-label="Robinhood verification code"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="w-32 px-3 py-2 border border-gray-300 dark:border-zinc-700 rounded-lg text-center bg-white dark:bg-zinc-900 text-gray-900 dark:text-white"
                maxLength={8}
              />
              <button
                onClick={handleMFA}
                disabled={connecting || !mfaCode.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
              >
                {connecting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <TrendingUp className="w-4 h-4" />
                )}
                Submit
              </button>
              <button
                onClick={resetLogin}
                className="px-3 py-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {message && (
        <div className="mt-3 p-2 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded text-sm text-green-700 dark:text-green-400">
          {message}
        </div>
      )}
      {error && (
        <div className="mt-3 p-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}

export default function ConfigurePage() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [plaidStatus, setPlaidStatus] = useState<PlaidAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAuthStatus = useCallback(async () => {
    try {
      const status = await getAuthStatus();
      setAuthStatus(status);
    } catch (err) {
      console.error('Failed to fetch auth status:', err);
    }
  }, []);

  const fetchPlaidStatus = useCallback(async () => {
    try {
      const status = await getPlaidStatus();
      setPlaidStatus(status);
    } catch (err) {
      console.error('Failed to fetch Plaid status:', err);
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchAuthStatus(), fetchPlaidStatus()]).then(() => {
      setLoading(false);
    });
  }, [fetchAuthStatus, fetchPlaidStatus]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 dark:bg-zinc-800 rounded w-64 mb-4"></div>
          <div className="h-4 bg-gray-200 dark:bg-zinc-800 rounded w-96 mb-8"></div>
          <div className="h-24 bg-gray-200 dark:bg-zinc-800 rounded-lg mb-6"></div>
          <div className="h-48 bg-gray-200 dark:bg-zinc-800 rounded-lg"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Configure</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">
          Set up your brokerage connections and trading agents
        </p>
      </div>

      <div className="flex items-start gap-2 p-3 bg-gray-50 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-lg mb-6">
        <Lock className="w-4 h-4 text-gray-400 dark:text-gray-500 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Credentials and trading engine will be managed locally. Hosted agents are coming soon.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <PlaidOnboarding plaidStatus={plaidStatus} onPlaidChange={fetchPlaidStatus} />
        <AgentOnboarding authStatus={authStatus} onAuthChange={fetchAuthStatus} />
      </div>
    </div>
  );
}
