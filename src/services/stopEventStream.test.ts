import { applySseFrame, EMPTY_SNAPSHOT, parseSseFrames } from './stopEventStream';

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
  'event: risk',
  'id: coverage_gap-NBIS',
  'data: {"type":"risk","code":"coverage_gap","symbol":"NBIS","severity":"critical"}',
  '',
].join('\n');

describe('parseSseFrames', () => {
  it('parses snapshot, coverage, and risk frames', () => {
    const frames = parseSseFrames(SSE);
    expect(frames.map((f) => f.event)).toEqual(['snapshot', 'coverage', 'risk']);
    expect(frames[0].retry).toBe(8000);
    expect((frames[1].data as { uncovered_qty: number }).uncovered_qty).toBe(85);
  });
});

describe('applySseFrame', () => {
  it('replaces the snapshot then upserts coverage and risk', () => {
    const frames = parseSseFrames(SSE);
    let state = EMPTY_SNAPSHOT;
    for (const frame of frames) state = applySseFrame(state, frame);
    expect(state.as_of).toBe('t0');
    expect(state.names).toHaveLength(1);
    expect(state.names[0].uncovered_qty).toBe(85);
    expect(state.events[0].code).toBe('coverage_gap');
  });
});
