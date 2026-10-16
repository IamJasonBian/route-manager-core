// Client for the market-context function (NBBO + minute bars at execution
// times, option snapshots, per-symbol vol surface) and snapshot-refresh.

import { apiJson } from './http';
import type { FillMarketContext } from '../utils/fillQuality';
import type { VolSurfaceGrid } from '../utils/volCalibration';

const MAX_TIMES_PER_REQUEST = 30;

interface FillsResponse {
  ok: boolean;
  symbol: string;
  results: FillMarketContext[];
  error?: string;
}

/** Market context at each execution time, batched to the function's per-request cap. */
export async function getFillContext(symbol: string, times: string[]): Promise<FillMarketContext[]> {
  const out: FillMarketContext[] = [];
  for (let i = 0; i < times.length; i += MAX_TIMES_PER_REQUEST) {
    const batch = times.slice(i, i + MAX_TIMES_PER_REQUEST);
    const body = await apiJson<FillsResponse>(
      `/market-context?action=fills&symbol=${encodeURIComponent(symbol)}&t=${encodeURIComponent(batch.join(','))}`
    );
    if (!body.ok) throw new Error(body.error || 'market-context failed');
    out.push(...body.results);
  }
  return out;
}

export interface OptionSnapshot {
  occ: string;
  found: boolean;
  bid?: number | null;
  ask?: number | null;
  bid_size?: number | null;
  ask_size?: number | null;
  quote_time?: string | null;
  last?: number | null;
  last_size?: number | null;
  last_time?: string | null;
  iv?: number | null;
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number } | null;
}

export async function getOptionSnapshots(occ: string[]): Promise<OptionSnapshot[]> {
  if (!occ.length) return [];
  const body = await apiJson<{ ok: boolean; contracts: OptionSnapshot[]; error?: string }>(
    `/market-context?action=options&occ=${encodeURIComponent(occ.join(','))}`
  );
  if (!body.ok) throw new Error(body.error || 'option snapshots failed');
  return body.contracts;
}

export interface SurfaceResponse {
  ok: boolean;
  symbol: string;
  surface: VolSurfaceGrid | null;
  meta: { source: string; timestamp?: string; quoteCount?: number; fallback?: boolean } | null;
  error?: string;
}

export async function getVolSurface(symbol: string): Promise<SurfaceResponse> {
  return apiJson<SurfaceResponse>(`/market-context?action=surface&symbol=${encodeURIComponent(symbol)}`);
}

export interface RefreshResult {
  ok: boolean;
  error?: string;
  errors?: string[];
  elapsed_ms?: number;
  /** Set when the 60s floor skipped the pull, e.g. "last refresh 12s ago (floor 60s)" */
  skipped?: string;
  [key: string]: unknown;
}

/** Pull fresh orders/positions from Robinhood into the trading DB (server floors it to once per 60s). */
export async function triggerSnapshotRefresh(): Promise<RefreshResult> {
  return apiJson<RefreshResult>('/snapshot-refresh', { timeoutMs: 30_000 });
}
