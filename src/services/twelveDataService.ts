// Twelve Data API Service
// Documentation: https://twelvedata.com/docs

import { API_BASE } from '../config/api';
import { cachedJson } from './twelveDataCache';
import { tdFetch } from './tdProxy';
import { fetchJson } from './http';

// Cache TTLs (ms). Daily/weekly bars change at most once per day; intraday
// series and quotes refresh faster. Historical point lookups are immutable.
const TTL_DAILY = 30 * 60_000;
const TTL_INTRADAY = 3 * 60_000;
const TTL_QUOTE = 60_000;
const TTL_HISTORICAL_POINT = 24 * 60 * 60_000;

export interface TimeSeriesData {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface TimeSeriesResponse {
  meta: {
    symbol: string;
    interval: string;
    currency: string;
    exchange: string;
    type: string;
  };
  values: TimeSeriesData[];
  status?: string;
  message?: string;
}

export interface NormalizedPriceData {
  date: string;
  timestamp: number;
  price: number;
}

export interface OHLCVPriceData {
  date: string;
  timestamp: number;
  price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PortfolioAsset {
  symbol: string;
  displayName: string;
  color: string;
  data: NormalizedPriceData[];
}

// SMA period in calendar days (converted to data-point windows per interval)
const SMA_DAYS = 150;

// Map time ranges to output sizes and intervals
// outputsize includes extra warm-up data so the SMA covers the entire visible chart
const RANGE_CONFIG: Record<string, { outputsize: number; interval: string; smaWindow: number; visibleSize: number }> = {
  '1D':  { outputsize: 78,                         interval: '5min',  smaWindow: 0,                           visibleSize: 78 },
  '1W':  { outputsize: 7 + SMA_DAYS,               interval: '1day',  smaWindow: SMA_DAYS,                    visibleSize: 7 },
  '1M':  { outputsize: 22 + SMA_DAYS,              interval: '1day',  smaWindow: SMA_DAYS,                    visibleSize: 22 },
  '3M':  { outputsize: 66 + SMA_DAYS,              interval: '1day',  smaWindow: SMA_DAYS,                    visibleSize: 66 },
  '6M':  { outputsize: 130 + SMA_DAYS,             interval: '1day',  smaWindow: SMA_DAYS,                    visibleSize: 130 },
  '1Y':  { outputsize: 252 + SMA_DAYS,             interval: '1day',  smaWindow: SMA_DAYS,                    visibleSize: 252 },
  '5Y':  { outputsize: 260 + Math.ceil(SMA_DAYS / 7), interval: '1week', smaWindow: Math.ceil(SMA_DAYS / 7), visibleSize: 260 },
};

export function getRangeConfig(range: string) {
  return RANGE_CONFIG[range] || RANGE_CONFIG['1Y'];
}

/** TwelveData series come newest-first; normalise to chronological OHLCV. */
function toBars(values: TimeSeriesData[] | undefined): OHLCVPriceData[] {
  return (values ?? [])
    .map((item) => {
      const close = parseFloat(item.close);
      return {
        date: item.datetime,
        timestamp: new Date(item.datetime).getTime(),
        price: close,
        open: parseFloat(item.open),
        high: parseFloat(item.high),
        low: parseFloat(item.low),
        close,
        volume: parseFloat(item.volume || '0'),
      };
    })
    .filter((bar) => Number.isFinite(bar.price))
    .reverse();
}

function fetchSeries(params: Record<string, string | number | undefined>): Promise<TimeSeriesResponse> {
  return tdFetch<TimeSeriesResponse>('time_series', params);
}

export async function getTimeSeries(
  symbol: string,
  range: string = '1Y',
  forceRefresh: boolean = false
): Promise<NormalizedPriceData[]> {
  const config = RANGE_CONFIG[range] || RANGE_CONFIG['1Y'];
  const ttl = config.interval === '1day' || config.interval === '1week' ? TTL_DAILY : TTL_INTRADAY;

  return cachedJson(`ts:${symbol}:${range}`, ttl, async () => {
    const data = await fetchSeries({
      symbol,
      interval: config.interval,
      outputsize: config.outputsize,
      // Propagate an explicit user refresh to the proxy so it re-pulls upstream
      // (subject to its own 15s floor) instead of serving its cached payload.
      refresh: forceRefresh ? '1' : undefined,
    });
    return toBars(data.values).map(({ date, timestamp, price }) => ({ date, timestamp, price }));
  });
}

/** Today's 1-minute closes in UTC, used to backfill the live event/price overlay. */
export async function getIntradaySeries(
  symbol: string,
  outputsize = 390
): Promise<NormalizedPriceData[]> {
  const url = new URL(`${TWELVE_DATA_API}/time_series`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', '1min');
  url.searchParams.set('outputsize', outputsize.toString());
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('apikey', getApiKey());

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Failed to fetch ${symbol}: ${response.status}`);
  const data: TimeSeriesResponse = await response.json();
  if (data.status === 'error') throw new Error(data.message || `API error for ${symbol}`);

  return data.values
    .map((item) => ({
      date: item.datetime,
      timestamp: new Date(`${item.datetime.replace(' ', 'T')}Z`).getTime(),
      price: parseFloat(item.close),
    }))
    .reverse();
}

// Portfolio assets configuration
export const PORTFOLIO_ASSETS = [
  { symbol: 'BTC/USD', displayName: 'Bitcoin', color: '#F7931A' },
  { symbol: 'MSTR', displayName: 'MicroStrategy', color: '#D9232E' },
  { symbol: 'GBTC', displayName: 'Grayscale BTC Trust', color: '#6B21A8' },
  { symbol: 'BTC', displayName: 'Grayscale BTC Mini ETF', color: '#9333EA' },
  { symbol: 'QQQ', displayName: 'QQQ (Nasdaq)', color: '#8B5CF6' },
  { symbol: 'SPY', displayName: 'S&P 500', color: '#3B82F6' },
  { symbol: 'VOO', displayName: 'Vanguard S&P 500', color: '#2563EB' },
  { symbol: 'NET', displayName: 'Cloudflare', color: '#F38020' },
  { symbol: 'AAPL', displayName: 'Apple', color: '#A2AAAD' },
  { symbol: 'MSFT', displayName: 'Microsoft', color: '#00A4EF' },
  { symbol: 'AMZN', displayName: 'Amazon', color: '#FF9900' },
  { symbol: 'GOOGL', displayName: 'Alphabet', color: '#4285F4' },
  { symbol: 'META', displayName: 'Meta', color: '#0668E1' },
  { symbol: 'NVDA', displayName: 'Nvidia', color: '#76B900' },
  { symbol: 'AVGO', displayName: 'Broadcom', color: '#EF4444' },
  { symbol: 'MU', displayName: 'Micron', color: '#0057A8' },
  { symbol: 'NBIS', displayName: 'Nebius', color: '#14B8A6' },
  { symbol: 'TSLA', displayName: 'Tesla', color: '#E31937' },
  { symbol: 'GLD', displayName: 'Gold (GLD)', color: '#FFD700' },
];

export async function getPortfolioData(
  range: string = '1Y',
  symbols?: string[],
  forceRefresh: boolean = false
): Promise<PortfolioAsset[]> {
  // Only fetch the requested symbols (defaults to all) to keep bursts small.
  const assets = symbols
    ? PORTFOLIO_ASSETS.filter((a) => symbols.includes(a.symbol))
    : PORTFOLIO_ASSETS;

  // Tolerate partial failures (e.g. a single rate-limited symbol) instead of
  // failing the whole page — cached/successful assets still render.
  const results = await Promise.allSettled(
    assets.map(async (asset) => ({
      ...asset,
      data: await getTimeSeries(asset.symbol, range, forceRefresh),
    }))
  );

  return results
    .filter((r): r is PromiseFulfilledResult<PortfolioAsset> => r.status === 'fulfilled')
    .map((r) => r.value);
}

export interface Quote {
  symbol: string;
  price: number;
  timestamp: number; // ms epoch
}

/** Raw TwelveData `quote` payload (numeric fields arrive as strings). */
interface RawQuote {
  symbol: string;
  name?: string;
  datetime: string;
  timestamp?: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
  previous_close: string;
  change: string;
  percent_change: string;
  is_market_open?: boolean;
}

/**
 * Every quote shape below is derived from one cached raw payload per symbol,
 * so the Dashboard, Compare and projection widgets share a single upstream
 * credit and can never read back each other's (differently shaped) entries.
 */
function getRawQuote(symbol: string): Promise<RawQuote> {
  return cachedJson(`quote:raw:${symbol}`, TTL_QUOTE, () => tdFetch<RawQuote>('quote', { symbol }));
}

/**
 * Fetch the latest quote for a symbol through the proxy (`quote` endpoint).
 * Works on plans without WebSocket streaming — the proxy caches quotes for
 * ~60s, so polling callers share one upstream credit per symbol per window.
 */
async function getQuote(symbol: string): Promise<Quote> {
  const data = await getRawQuote(symbol);
  return {
    symbol,
    price: parseFloat(data.close),
    // TwelveData quote `timestamp` is epoch seconds for the last trade.
    timestamp: typeof data.timestamp === 'number' ? data.timestamp * 1000 : Date.now(),
  };
}

/** Fetch quotes for several symbols, tolerating per-symbol failures. */
export async function getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const results = await Promise.allSettled(symbols.map((s) => getQuote(s)));
  const out: Record<string, Quote> = {};
  results.forEach((r) => {
    if (r.status === 'fulfilled' && Number.isFinite(r.value.price)) out[r.value.symbol] = r.value;
  });
  return out;
}

// --- CoinGecko supplemental data (market cap + volume) via Netlify proxy ---

export interface CoinGeckoMarketData {
  market_cap: number | null;
  total_volume: number | null;
  error?: string;
}

export async function getCoinGeckoMarketData(): Promise<CoinGeckoMarketData> {
  try {
    const data = await fetchJson<{ market_cap?: number; total_volume?: number }>(`${API_BASE}/coingecko-market`);
    return {
      market_cap: data.market_cap ?? null,
      total_volume: data.total_volume ?? null,
    };
  } catch (err) {
    return { market_cap: null, total_volume: null, error: err instanceof Error ? err.message : '503 Service Unavailable' };
  }
}

// --- Bitcoin Dashboard functions ---

export interface BitcoinQuote {
  symbol: string;
  name: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  previous_close: number;
  change: number;
  percent_change: number;
  datetime: string;
}

export async function getBitcoinQuote(): Promise<BitcoinQuote> {
  const data = await getRawQuote('BTC/USD');
  return {
    symbol: data.symbol,
    name: data.name || 'Bitcoin',
    open: parseFloat(data.open),
    high: parseFloat(data.high),
    low: parseFloat(data.low),
    close: parseFloat(data.close),
    volume: parseFloat(data.volume || '0'),
    previous_close: parseFloat(data.previous_close),
    change: parseFloat(data.change),
    percent_change: parseFloat(data.percent_change),
    datetime: data.datetime,
  };
}

// --- ETF Quote functions ---

export interface EtfQuote {
  symbol: string;
  name: string;
  close: number;
  previous_close: number;
  change: number;
  percent_change: number;
  datetime: string;
  is_market_open: boolean;
}

export async function getEtfQuote(symbol: string = 'BTC'): Promise<EtfQuote> {
  const data = await getRawQuote(symbol);
  return {
    symbol: data.symbol,
    name: data.name || 'Grayscale Bitcoin Mini Trust ETF',
    close: parseFloat(data.close),
    previous_close: parseFloat(data.previous_close),
    change: parseFloat(data.change),
    percent_change: parseFloat(data.percent_change),
    datetime: data.datetime,
    is_market_open: Boolean(data.is_market_open),
  };
}

export async function getBtcPriceAtTime(datetime: string): Promise<number> {
  return cachedJson(`btcAt:${datetime}`, TTL_HISTORICAL_POINT, async () => {
    const data = await fetchSeries({ symbol: 'BTC/USD', interval: '1h', outputsize: 1, end_date: datetime });
    const [bar] = toBars(data.values);
    if (!bar) throw new Error('No BTC price data available for the specified time');
    return bar.close;
  });
}

// Map days-based ranges to TwelveData config (including intraday for short ranges)
const BTC_RANGE_CONFIG: Record<number, { outputsize: number; interval: string }> = {
  1: { outputsize: 96, interval: '15min' },
  7: { outputsize: 168, interval: '1h' },
  30: { outputsize: 30, interval: '1day' },
  90: { outputsize: 90, interval: '1day' },
  365: { outputsize: 252, interval: '1day' },
  1095: { outputsize: 780, interval: '1day' },
};

export async function getBitcoinPriceHistory(
  days: number = 30
): Promise<OHLCVPriceData[]> {
  const config = BTC_RANGE_CONFIG[days] || BTC_RANGE_CONFIG[30];
  const ttl = config.interval === '1day' || config.interval === '1week' ? TTL_DAILY : TTL_INTRADAY;

  return cachedJson(`btcHist:${days}`, ttl, async () => {
    const data = await fetchSeries({ symbol: 'BTC/USD', interval: config.interval, outputsize: config.outputsize });
    return toBars(data.values);
  });
}
