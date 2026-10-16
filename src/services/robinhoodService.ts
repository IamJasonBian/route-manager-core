// Robinhood API Service
// Connects to Netlify functions for Robinhood data

import { apiJson } from './http';

// Auth types
export interface AuthStatus {
  authenticated: boolean;
  message: string;
  expiresAt?: string;
  expiresIn?: number;
  hasRefreshToken?: boolean;
  updatedAt?: string;
  error?: string;
}

/** Ids of a login waiting on Robinhood's device approval or a code — pass back to verify / mfa. */
export interface VerificationIds {
  workflowId?: string;
  machineId?: string;
  challengeId?: string;
}

export interface AuthResult {
  authenticated: boolean;
  message: string;
  status?: 'verified' | 'pending' | 'code_required' | 'no_pending' | 'error';
  /** Approve the login in the Robinhood app, then check again */
  requiresVerification?: boolean;
  /** Enter a code (SMS / email / authenticator) */
  requiresMFA?: boolean;
  verificationType?: 'device' | 'mfa';
  challengeType?: string | null;
  verification?: VerificationIds;
  error?: string;
}

export interface Position {
  symbol: string;
  name: string;
  quantity: number;
  averageCost: number;
  currentPrice: number;
  totalCost: number;
  currentValue: number;
  gain: number;
  gainPercent: number;
}

export interface Portfolio {
  accountNumber: string;
  buyingPower: number;
  cash: number;
  portfolioValue: number;
  extendedHoursValue: number;
  totalGain: number;
  positions: Position[];
}

// Order Book Snapshot types (from 5thstreetcapital blob store)
export interface OptionPosition {
  chain_symbol?: string;
  symbol?: string;
  option_type: string;
  // RH API / blob may use either short or long field names
  strike?: number | string;
  strike_price?: string;
  expiration?: string;
  expiration_date?: string;
  dte?: number;
  quantity: number;
  position_type?: string;
  avg_price?: number;
  mark_price?: number;
  multiplier?: number;
  cost_basis: number;
  current_value: number;
  unrealized_pl: number;
  unrealized_pl_pct?: number;
  underlying_price?: number;
  break_even?: number;
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho?: number;
    iv?: number;
    [key: string]: number | undefined;
  };
  expected_pl?: {
    theta_daily: number;
    [scenario: string]: number;
  };
  chance_of_profit?: number;
  recommended_action?: {
    action: string;
    reasons?: string[];
  };
  btc_correlation?: number;
}

export interface SnapshotPosition {
  symbol: string;
  name?: string;
  type?: string;
  quantity: number;
  avg_buy_price: number;
  current_price: number;
  equity: number;
  profit_loss: number;
  profit_loss_pct: number;
  percent_change?: number | null;
  equity_change?: number | null;
  pe_ratio?: number | null;
  percentage?: number | null;
  /** 'equity' | 'crypto' — crypto rows use pair symbols like BTC-USD */
  asset_type?: string;
  /** Engine `.SHADOW` bookkeeping mirror — excluded from all aggregates */
  shadow?: boolean;
}

export interface SnapshotOrder {
  order_id: string;
  symbol: string;
  side: string;
  order_type: string;
  // Nullable in practice: placement stubs written by external tools omit
  // trigger/state/timestamps entirely
  trigger: string | null;
  state: string | null;
  quantity: number;
  limit_price: number;
  stop_price: number | null;
  created_at: string | null;
  updated_at: string | null;
  filled_quantity?: number | null;
  average_price?: number | null;
}

export interface SymbolMarketData {
  metrics: {
    intraday_volatility: number;
    intraday_high: number;
    intraday_low: number;
    current_price: number;
    '30d_high': number;
    '30d_low': number;
  };
  orders?: {
    active_buy: unknown;
    active_sell: unknown;
    order_history: unknown[];
  };
  last_signal?: {
    signal: string;
    timestamp: string;
  };
  last_updated: string;
}

export interface MarketData {
  timestamp: string;
  symbols: Record<string, SymbolMarketData>;
}

export interface SnapshotOptionOrderLeg {
  side: string;
  position_effect?: string;
  quantity?: number;
  // RH API uses strike_price/expiration_date; engine blob may shorten to strike/expiration
  strike?: number | string;
  strike_price?: string;
  expiration?: string;
  expiration_date?: string;
  option_type: string;
  chain_symbol?: string;
}

export interface SnapshotOptionOrder {
  order_id: string;
  chain_symbol?: string;
  state: string;
  quantity: number;
  price?: number;
  premium?: number;
  processed_premium?: number;
  direction: string;
  order_type?: string;
  trigger?: string;
  time_in_force?: string;
  opening_strategy?: string;
  created_at: string;
  updated_at: string;
  legs?: SnapshotOptionOrderLeg[];
}

export interface BotAction {
  id: string;
  timestamp: string;
  type: string;
  status: string;
  symbol?: string;
  quantity?: number;
  price?: number;
  total?: number;
  message?: string;
  details?: string;
  dryRun?: boolean;
}

const fetchApi = apiJson;

// ── Trading DB endpoints (Postgres via db-* functions) ─────────────────────────────────────
// db-orders / db-bot-activity / db-pnl all return this envelope. The same
// endpoints are the write path for the Robinhood MCP service.

export interface DbEnvelope<T> {
  ok: boolean;
  resource: string;
  action: string;
  source: string;
  as_of: string;
  count: number | null;
  data: T;
  error: { code: string; message: string } | null;
}

export interface DbPage {
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface DbOrders {
  open_orders: SnapshotOrder[];
  open_option_orders: SnapshotOptionOrder[];
  historical_orders: SnapshotOrder[];
  historical_option_orders: SnapshotOptionOrder[];
  /** Placement stubs with no lifecycle state — written by external tools, never confirmed by RH */
  untracked_orders?: SnapshotOrder[];
  untracked_option_orders?: SnapshotOptionOrder[];
  counts?: Record<string, number>;
  page?: DbPage;
}

export interface DbBotEvent {
  id: number;
  event_id: string | null;
  order_id: string | null;
  event_type: string;
  status: string;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  total: number | null;
  message: string | null;
  details: string | null;
  dry_run: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

async function fetchDb<T>(endpoint: string): Promise<DbEnvelope<T>> {
  const body = await apiJson<DbEnvelope<T> | null>(endpoint);
  if (!body || body.ok === false) {
    throw new Error(body?.error?.message || 'Request failed: empty trading DB response');
  }
  return body;
}

export async function getDbOrders(scope: 'open' | 'historical' | 'all' = 'all'): Promise<DbOrders> {
  const env = await fetchDb<DbOrders>(`/db-orders?scope=${scope}`);
  return env.data;
}

/**
 * Every DB order (all buckets) for one ticker. db-orders pages over the whole
 * table before filtering by symbol, so walk pages until the table is exhausted
 * (capped at `maxPages` × 1000 rows per table).
 */
export async function getDbOrdersForSymbol(symbol: string, maxPages: number = 10): Promise<DbOrders & { truncated: boolean }> {
  const limit = 1000;
  const merged: DbOrders = {
    open_orders: [], open_option_orders: [],
    historical_orders: [], historical_option_orders: [],
    untracked_orders: [], untracked_option_orders: [],
  };
  let page = 0;
  let hasMore = true;
  while (hasMore && page < maxPages) {
    const env = await fetchDb<DbOrders>(
      `/db-orders?scope=all&type=all&symbol=${encodeURIComponent(symbol)}&limit=${limit}&offset=${page * limit}`
    );
    const d = env.data;
    merged.open_orders.push(...(d.open_orders ?? []));
    merged.open_option_orders.push(...(d.open_option_orders ?? []));
    merged.historical_orders.push(...(d.historical_orders ?? []));
    merged.historical_option_orders.push(...(d.historical_option_orders ?? []));
    merged.untracked_orders!.push(...(d.untracked_orders ?? []));
    merged.untracked_option_orders!.push(...(d.untracked_option_orders ?? []));
    hasMore = Boolean(d.page?.has_more);
    page++;
  }
  return { ...merged, truncated: hasMore };
}

/** Bot activity from the trading DB, mapped onto the existing BotAction shape. */
export async function getDbBotActivity(limit: number = 50): Promise<{ actions: BotAction[]; total: number }> {
  const env = await fetchDb<{ events: DbBotEvent[] }>(`/db-bot-activity?limit=${limit}`);
  const actions: BotAction[] = env.data.events.map(e => ({
    id: String(e.id ?? e.event_id),
    timestamp: e.created_at,
    type: e.event_type,
    status: e.status,
    symbol: e.symbol ?? undefined,
    quantity: e.quantity ?? undefined,
    price: e.price ?? undefined,
    total: e.total ?? undefined,
    message: e.message ?? undefined,
    details: e.details ?? undefined,
    dryRun: e.dry_run,
  }));
  return { actions, total: actions.length };
}

// Bot functions
export async function getBotActions(limit: number = 50): Promise<{ actions: BotAction[]; total: number }> {
  return fetchApi<{ actions: BotAction[]; total: number }>(`/robinhood-bot?action=actions&limit=${limit}`);
}

// Format currency
export function formatCurrency(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// Format percentage
export function formatPercent(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '+0.00%';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

// Get color class based on value
export function getGainColor(value: number | null | undefined): string {
  if (value == null) return 'text-gray-600 dark:text-gray-400';
  if (value > 0) return 'text-green-600 dark:text-green-400';
  if (value < 0) return 'text-red-600 dark:text-red-400';
  return 'text-gray-600 dark:text-gray-400';
}

// ── Enriched snapshot types ───────────────────────────────────────────────────

export type PnLPeriod = '1W' | '1M' | '3M' | '6M' | '1Y' | '5Y';

export interface StockSymbolPnL {
  symbol: string;
  realized_pnl: number;
  total_bought: number;
  total_sold: number;
  buy_count: number;
  sell_count: number;
  shares_held: number;
  cost_basis: number;
}

export interface OptionSymbolPnL {
  symbol: string;
  realized_pnl: number;
  total_bought: number;
  total_sold: number;
  buy_count: number;
  sell_count: number;
}

export interface StockPnLResult {
  total_realized_pnl: number;
  total_buy_volume: number;
  total_sell_volume: number;
  filled_count: number;
  symbols: StockSymbolPnL[];
}

export interface OptionPnLResult {
  total_realized_pnl: number;
  total_buy_volume: number;
  total_sell_volume: number;
  filled_count: number;
  symbols: OptionSymbolPnL[];
}

export interface OptionsSummary {
  count: number;
  total_cost_basis: number;
  total_current_value: number;
  total_unrealized_pl: number;
  total_theta_daily: number;
}


export interface EnrichedPortfolio {
  cash: {
    cash: number;
    cash_available_for_withdrawal: number;
    buying_power: number;
    tradeable_cash: number;
  };
  equity: number;
  rh_market_value: number | null;
  market_value: number;
  stock_market_value: number;
  options_market_value: number;
  /** Account-level crypto holdings (RH reports a single total, no coin book) */
  crypto_market_value?: number;
  /** Engine `.SHADOW` mirror rows — excluded from computed equity */
  shadow_market_value?: number;
  margin_used: number;
  reconciliation: {
    rh_equity: number;
    computed_equity: number;
    stock_market_value?: number;
    options_market_value?: number;
    crypto_market_value?: number;
    cash?: number;
    shadow_excluded?: number;
  };
  positions: SnapshotPosition[];
  open_orders: SnapshotOrder[];
  open_option_orders: SnapshotOptionOrder[];
  options: OptionPosition[];
  options_summary: OptionsSummary | null;
  total_pl: number;
  total_pl_pct: number;
}

export interface EnrichedSnapshot {
  timestamp: string;
  /** Where the order book came from: 'db' (trading DB overlay) or 'blob' */
  orders_source?: 'db' | 'blob';
  /** Freshness of the order data (DB overlays are as-of request time) */
  orders_as_of?: string;
  market_data: MarketData | null;
  order_book: SnapshotOrder[];
  recent_orders: SnapshotOrder[];
  recent_option_orders: SnapshotOptionOrder[];
  recent_pnl: StockPnLResult;
  option_pnl: OptionPnLResult;
  combined_7d_pnl: number;
  pnl_by_period: Record<PnLPeriod, { stock: StockPnLResult; option: OptionPnLResult }>;
  portfolio: EnrichedPortfolio;
}

export async function getEnrichedSnapshot(): Promise<EnrichedSnapshot> {
  return fetchApi<EnrichedSnapshot>('/enriched-snapshot');
}

// ── Trading DB P&L (db-pnl) ───────────────────────────────────────────────────

export interface DbPnlPeriod {
  stock: StockPnLResult;
  option: OptionPnLResult;
  combined_realized_pnl: number;
}

export interface DbPnlData {
  periods: Record<PnLPeriod, DbPnlPeriod>;
  open_orders: SnapshotOrder[];
  open_option_orders: SnapshotOptionOrder[];
  counts: {
    stock_orders: number;
    option_orders: number;
    open_orders: number;
    open_option_orders: number;
  };
  truncated?: boolean;
}

export async function getDbPnl(): Promise<DbPnlData> {
  const env = await fetchDb<DbPnlData>('/db-pnl');
  return env.data;
}

// Auth functions
export async function getAuthStatus(): Promise<AuthStatus> {
  return fetchApi<AuthStatus>('/robinhood-auth?action=status');
}

export async function connectRobinhood(): Promise<AuthResult> {
  return fetchApi<AuthResult>('/robinhood-auth?action=connect');
}

function verificationQuery(ids?: VerificationIds): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(ids ?? {})) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `&${qs}` : '';
}

export async function checkVerification(ids?: VerificationIds): Promise<AuthResult> {
  return fetchApi<AuthResult>(`/robinhood-auth?action=verify${verificationQuery(ids)}`);
}

export async function submitMFA(code: string, ids?: VerificationIds): Promise<AuthResult> {
  return fetchApi<AuthResult>(`/robinhood-auth?action=mfa&code=${encodeURIComponent(code)}${verificationQuery(ids)}`);
}

export async function disconnectRobinhood(): Promise<AuthResult> {
  return fetchApi<AuthResult>('/robinhood-auth?action=disconnect');
}
