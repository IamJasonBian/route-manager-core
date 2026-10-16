import { assessFill, summarizeFillQuality, occSymbol, type FillMarketContext } from './fillQuality';
import type { StockFill } from './tickerPnl';

function fill(side: 'BUY' | 'SELL', quantity: number, price: number, extra: Partial<StockFill> = {}): StockFill {
  return {
    order_id: `${side}-${price}`, time: Date.parse('2026-10-14T14:00:00Z'), date: '2026-10-14', side, kind: 'Limit',
    quantity, price, notional: quantity * price, shares_after: 0, avg_cost_after: 0, realized: null,
    cumulative_realized: 0, unmatched_quantity: 0, partial: false, limit_price: null, stop_price: null, submitted: null,
    ...extra,
  };
}

function ctx(bid: number, ask: number, extra: Partial<FillMarketContext> = {}): FillMarketContext {
  return {
    t: '2026-10-14T14:00:00.000Z', session: 'regular', feed: 'sip',
    quote: { bid, ask, bid_size: 4, ask_size: 2, bid_exchange: 'Q', ask_exchange: 'P', time: '2026-10-14T13:59:59.500Z', age_ms: 500 },
    bar: { time: '2026-10-14T14:00:00Z', open: 100, high: 100.5, low: 99.5, close: 100.2, volume: 10000, vwap: 100, trades: 300 },
    error: null,
    ...extra,
  };
}

describe('assessFill', () => {
  it('measures a buy at the ask against mid, VWAP and the minute range', () => {
    const a = assessFill(fill('BUY', 10, 100.1), ctx(99.9, 100.1));
    expect(a.placement).toBe('touch');
    expect(a.mid).toBeCloseTo(100, 6);
    expect(a.spread_bps).toBeCloseTo(20, 6);
    expect(a.vs_mid_bps).toBeCloseTo(10, 6);   // paid half the spread
    expect(a.vs_mid_usd).toBeCloseTo(1, 6);    // 10 sh × $0.10
    expect(a.vs_vwap_bps).toBeCloseTo(10, 6);
    expect(a.bar_position).toBeCloseTo(0.6, 6); // 100.1 in [99.5, 100.5], 0 = best for a buy
    expect(a.size_vs_displayed).toBe(5);       // 10 sh vs 2 displayed at the ask
    expect(a.quote_stale).toBe(false);
  });

  it('credits a sell inside the spread as price improvement', () => {
    const a = assessFill(fill('SELL', 5, 100.05), ctx(99.9, 100.1));
    expect(a.placement).toBe('inside');
    expect(a.vs_mid_bps).toBeCloseTo(-5, 6);   // sold above mid → negative cost
    expect(a.bar_position).toBeCloseTo(0.45, 6); // 1 − 0.55
  });

  it('flags fills through the NBBO and better than it', () => {
    expect(assessFill(fill('BUY', 1, 100.3), ctx(99.9, 100.1)).placement).toBe('through');
    expect(assessFill(fill('SELL', 1, 99.7), ctx(99.9, 100.1)).placement).toBe('through');
    expect(assessFill(fill('BUY', 1, 99.8), ctx(99.9, 100.1)).placement).toBe('better');
    expect(assessFill(fill('SELL', 1, 100.2), ctx(99.9, 100.1)).placement).toBe('better');
  });

  it('measures limit improvement', () => {
    const limit = assessFill(fill('BUY', 45, 186.5965, { limit_price: 186.6 }), ctx(186.5, 186.7));
    expect(limit.limit_improvement_bps).toBeCloseTo((186.6 - 186.5965) / 186.6 * 1e4, 6);
  });

  it('handles a missing or stale quote', () => {
    const none = assessFill(fill('BUY', 1, 100), { ...ctx(0, 0), quote: null, bar: null, session: 'overnight' });
    expect(none.placement).toBe('no-quote');
    expect(none.vs_mid_bps).toBeNull();
    expect(none.session).toBe('overnight');
    const stale = assessFill(fill('BUY', 1, 100), ctx(99.9, 100.1, { quote: { ...ctx(99.9, 100.1).quote!, age_ms: 5 * 60_000 } }));
    expect(stale.quote_stale).toBe(true);
    // A 5-minute-old quote is not a reference: shown, but not scored
    expect(stale.placement).toBe('stale');
    expect(stale.mid).toBeNull();
    expect(stale.vs_mid_bps).toBeNull();
    expect(summarizeFillQuality([stale]).with_quote).toBe(0);
    expect(assessFill(fill('BUY', 1, 100), undefined).placement).toBe('no-quote');
  });
});

describe('summarizeFillQuality', () => {
  it('weights slippage by notional and groups by order kind and session', () => {
    const rows = [
      assessFill(fill('BUY', 10, 100.1, { kind: 'Market' }), ctx(99.9, 100.1)),               // +10 bps, $1001
      assessFill(fill('SELL', 30, 100.05, { kind: 'Limit' }), ctx(99.9, 100.1)),              // −5 bps, $3001.5
      assessFill(fill('BUY', 1, 100, { kind: 'Limit' }), { ...ctx(0, 0), quote: null, session: 'overnight' }),
    ];
    const s = summarizeFillQuality(rows);
    expect(s.fills).toBe(3);
    expect(s.with_quote).toBe(2);
    expect(s.vs_mid_bps).toBeCloseTo((10 * 1001 + -5 * 3001.5) / (1001 + 3001.5), 6);
    expect(s.vs_mid_usd).toBeCloseTo(1 - 1.5, 6);
    expect(s.placements).toMatchObject({ touch: 1, inside: 1, 'no-quote': 1 });
    expect(s.by_kind.map(g => g.key)).toEqual(['Limit', 'Market']);
    expect(s.by_session.find(g => g.key === 'overnight')!.with_quote).toBe(0);
    expect(s.stop_fills).toBe(0);
    expect(s.stops_vs_mid_bps).toBeNull();
  });

  it('rates stop fills against the NBBO mid', () => {
    // A trailing stop that sold 85¢ under a $196.00 / $196.50 market at the open
    const rows = [assessFill(fill('SELL', 35, 195.14, { kind: 'Stop', stop_price: 194.96 }), ctx(196, 196.5))];
    const s = summarizeFillQuality(rows);
    expect(rows[0].placement).toBe('through');
    expect(s.stop_fills).toBe(1);
    expect(s.stops_vs_mid_bps).toBeCloseTo((196.25 - 195.14) / 196.25 * 1e4, 6);
  });
});

describe('occSymbol', () => {
  it('builds OCC symbols', () => {
    expect(occSymbol('NBIS', '2026-11-27', 'call', 220)).toBe('NBIS261127C00220000');
    expect(occSymbol('nbis', '2026-11-27', 'put', 172.5)).toBe('NBIS261127P00172500');
    expect(occSymbol('NBIS', '11/27', 'call', 220)).toBeNull();
  });
});
