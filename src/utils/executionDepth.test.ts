import { depthProfile, aggressorOf, type ExecutionDepth } from './executionDepth';
import type { StockFill } from './tickerPnl';

const T = Date.parse('2026-10-14T20:16:54.540Z');
const iso = (ms: number) => new Date(T + ms).toISOString();

function fill(side: 'BUY' | 'SELL', quantity: number, price: number): StockFill {
  return {
    order_id: 'f1', time: T, date: '2026-10-14', side, kind: 'Limit', quantity, price, notional: quantity * price,
    shares_after: 0, avg_cost_after: 0, realized: null, cumulative_realized: 0, unmatched_quantity: 0,
    partial: false, limit_price: price, stop_price: null, submitted: null,
  };
}

const DEPTH: ExecutionDepth = {
  ok: true, symbol: 'NBIS', t: iso(0), session: 'post', feed: 'sip',
  window_ms: { quotes: 30000, trades: 30000 },
  quotes: [
    { t: iso(-4000), bid: 186.5, ask: 186.62, bid_size: 300, ask_size: 100, bid_exchange: 'Q', ask_exchange: 'P' },
    { t: iso(-500), bid: 186.58, ask: 186.6, bid_size: 400, ask_size: 200, bid_exchange: 'Q', ask_exchange: 'Q' },
    { t: iso(4000), bid: 186.4, ask: 186.5, bid_size: 200, ask_size: 300, bid_exchange: 'Q', ask_exchange: 'Z' },
  ],
  trades: [
    { t: iso(-20000), price: 186.62, size: 100, exchange: 'Q', conditions: [] }, // vs pre-window quote → mid
    { t: iso(-3000), price: 186.62, size: 50, exchange: 'P', conditions: [] },   // at ask 186.62 → buy
    { t: iso(-3000), price: 186.5, size: 25, exchange: 'Q', conditions: [] },    // at bid → sell
    { t: iso(0), price: 186.5965, size: 45, exchange: 'D', conditions: [] },     // our print, inside
    { t: iso(6000), price: 186.4, size: 80, exchange: 'Q', conditions: [] },     // at bid → sell
  ],
  truncated: { quotes: false, trades: false },
};

describe('aggressorOf', () => {
  it('classifies prints by the NBBO in force', () => {
    const q = DEPTH.quotes[1];
    expect(aggressorOf(186.6, q)).toBe('buy');
    expect(aggressorOf(186.58, q)).toBe('sell');
    expect(aggressorOf(186.59, q)).toBe('mid');
    expect(aggressorOf(186.59, null)).toBe('mid');
  });
});

describe('depthProfile', () => {
  const p = depthProfile(DEPTH, fill('BUY', 45, 186.5965));

  it('uses the NBBO in force at the fill', () => {
    expect(p.nbbo?.bid).toBe(186.58);
    expect(p.nbbo?.ask_size).toBe(200);
    expect(p.share_of_displayed).toBeCloseTo(45 / 200, 10);
  });

  it('builds a price ladder of the tape with aggressor sides', () => {
    expect(p.volume).toBe(300);
    expect(p.trades).toBe(5);
    expect(p.volume_before).toBe(175);
    expect(p.volume_after).toBe(125); // our print at t=0 counts as after
    const top = p.ladder[0];
    expect(top.price).toBeCloseTo(186.62, 10);
    expect(top).toMatchObject({ mid: 100, buy: 50, total: 150, trades: 2 });
    const ours = p.ladder.find(l => l.ours)!;
    expect(ours.price).toBeCloseTo(186.6, 10); // 186.5965 rounds to the 186.60 level
    expect(p.ladder.find(l => Math.abs(l.price - 186.4) < 1e-9)!.sell).toBe(80);
    expect(p.share_of_volume).toBeCloseTo(45 / 300, 10);
  });

  it('finds our own print and the markout after the fill', () => {
    expect(p.matching_prints).toHaveLength(1);
    expect(p.likely_print?.exchange).toBe('D');
    // mid 5s later 186.45 vs our 186.5965 buy → market fell after we bought (cost)
    expect(p.markout_bps).toBeCloseTo((186.5965 - 186.45) / 186.5965 * 1e4, 6);
  });

  it('ranges the touch within ±5s of the fill', () => {
    expect(p.bid_range).toEqual([186.4, 186.58]);
    expect(p.ask_range).toEqual([186.5, 186.62]);
    expect(p.quote_updates).toBe(3);
    const wide = depthProfile({ ...DEPTH, quotes: [{ ...DEPTH.quotes[0], t: iso(-20000), bid: 180 }, ...DEPTH.quotes] }, fill('BUY', 45, 186.5965));
    expect(wide.quote_updates).toBe(3);         // the −20s quote is outside ±5s
    expect(wide.bid_range).toEqual([186.4, 186.58]);
  });

  it('marks out against the NBBO in force 5s after the fill', () => {
    const noUpdate = depthProfile({ ...DEPTH, quotes: DEPTH.quotes.slice(0, 2) }, fill('BUY', 45, 186.5965));
    // No quote after the fill: the mid is still 186.59 → (186.5965 − 186.59) / 186.5965
    expect(noUpdate.markout_bps).toBeCloseTo((186.5965 - 186.59) / 186.5965 * 1e4, 6);
  });

  it('ranks identical prints by time and keeps the closest', () => {
    const crowded = depthProfile({
      ...DEPTH,
      trades: [
        { t: iso(-1500), price: 186.5965, size: 45, exchange: 'Q', conditions: [] },
        { t: iso(200), price: 186.5965, size: 45, exchange: 'D', conditions: [] },
        { t: iso(900), price: 186.5965, size: 45, exchange: 'P', conditions: [] },
        { t: iso(2500), price: 186.5965, size: 45, exchange: 'K', conditions: [] }, // outside ±2s
      ],
    }, fill('BUY', 45, 186.5965));
    expect(crowded.matching_prints.map(tr => tr.exchange)).toEqual(['D', 'P', 'Q']);
    expect(crowded.likely_print?.exchange).toBe('D');
  });

  it('marks our level even with no prints there', () => {
    const quiet = depthProfile({ ...DEPTH, trades: [] }, fill('SELL', 10, 190));
    expect(quiet.ladder).toHaveLength(1);
    expect(quiet.ladder[0]).toMatchObject({ ours: true, total: 0 });
    expect(quiet.share_of_volume).toBeNull();
  });
});
