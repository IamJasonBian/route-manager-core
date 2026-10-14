import {
  appendTick,
  applySseFrame,
  EMPTY_SNAPSHOT,
  EVENT_TAIL,
  parseSseFrames,
  tailEvents,
} from './stopEventStream';

const SSE = [
  'event: snapshot',
  'id: t0',
  'retry: 8000',
  'data: {"as_of":"t0","names":[{"symbol":"NBIS","covered_qty":35}],"events":[]}',
  '',
  'event: coverage',
  'id: NBIS',
  'data: {"symbol":"NBIS","covered_qty":35,"uncovered_qty":85}',
  '',
  'event: price',
  'id: NBIS-t1',
  'data: {"symbol":"NBIS","price":211.01,"ts":"2026-10-14T22:00:00Z"}',
  '',
  'event: engine',
  'id: o-1',
  'data: {"type":"engine","id":"o-1","code":"order_filled","symbol":"NBIS","side":"BUY","price":178.5,"ts":"2026-10-14T22:39:30Z"}',
  '',
].join('\n');

describe('parseSseFrames', () => {
  it('parses snapshot, coverage, price, and engine frames', () => {
    const frames = parseSseFrames(SSE);
    expect(frames.map((f) => f.event)).toEqual(['snapshot', 'coverage', 'price', 'engine']);
    expect(frames[0].retry).toBe(8000);
    expect((frames[1].data as { uncovered_qty: number }).uncovered_qty).toBe(85);
  });
});

describe('applySseFrame', () => {
  it('replaces the snapshot then upserts coverage, price, and engine events', () => {
    const frames = parseSseFrames(SSE);
    let state = EMPTY_SNAPSHOT;
    for (const frame of frames) state = applySseFrame(state, frame);
    expect(state.as_of).toBe('t0');
    expect(state.names).toHaveLength(1);
    expect(state.names[0].uncovered_qty).toBe(85);
    expect(state.prices?.NBIS.price).toBe(211.01);
    expect(state.events[0].code).toBe('order_filled');
  });
});

describe('tailEvents', () => {
  it('keeps the newest EVENT_TAIL events, newest first', () => {
    const events = Array.from({ length: EVENT_TAIL + 5 }, (_, i) => ({
      type: 'engine',
      id: `o-${i}`,
      ts: new Date(Date.UTC(2026, 9, 14, 14, 0, i)).toISOString(),
    }));
    const tail = tailEvents(events);
    expect(tail).toHaveLength(EVENT_TAIL);
    expect(tail[0].id).toBe(`o-${EVENT_TAIL + 4}`);
  });
});

describe('appendTick', () => {
  it('skips duplicate timestamps and caps the series', () => {
    let series = appendTick([], { symbol: 'NBIS', price: 1, ts: 'a' }, 2);
    series = appendTick(series, { symbol: 'NBIS', price: 1, ts: 'a' }, 2);
    series = appendTick(series, { symbol: 'NBIS', price: 2, ts: 'b' }, 2);
    series = appendTick(series, { symbol: 'NBIS', price: 3, ts: 'c' }, 2);
    expect(series.map((t) => t.ts)).toEqual(['b', 'c']);
  });
});
