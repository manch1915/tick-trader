import { describe, expect, it } from 'vitest';
import { SignalEngine, type Fired } from '../src/engine/engine';
import { DEFAULT_ENGINE_SETTINGS, type EngineSettings, type Side } from '../src/engine/types';

const settings = (patch: Partial<EngineSettings> = {}): EngineSettings => ({
  ...structuredClone(DEFAULT_ENGINE_SETTINGS),
  ...patch,
});

// Tick size 1 in all tests, so prices read directly as ticks.
const TICK = 1;

/** Feeds the engine every 100 ms from `from` to `to` with a fixed tick value and price. */
function run(e: SignalEngine, from: number, to: number, ticks: number | null, side: Side = 'flat', price = 100) {
  const fired = [];
  for (let t = from; t <= to; t += 100) {
    const r = e.update({ now: t, ticks, price, tickSize: TICK, side });
    if (r.fired) fired.push({ t, ...r.fired });
  }
  return fired;
}

/** Feeds a price path, one price every `step` ms starting at `from`; 1-second ticks are not used by Close. */
function path(e: SignalEngine, from: number, prices: number[], side: Side = 'flat', step = 100) {
  const fired: ({ t: number; price: number } & Fired)[] = [];
  prices.forEach((price, i) => {
    const t = from + i * step;
    const r = e.update({ now: t, ticks: 0, price, tickSize: TICK, side });
    if (r.fired) fired.push({ t, price, ...r.fired });
  });
  return fired;
}

describe('SignalEngine entries', () => {
  it('fires Buy after the condition holds for the full duration', () => {
    const e = new SignalEngine(settings({ buy: { seconds: 3, ticks: 4, auto: true } }));
    e.start();
    const fired = run(e, 0, 3000, 4);
    expect(fired).toMatchObject([
      { t: 3000, kind: 'buy', auto: true, ticks: 4, threshold: 4, heldMs: 3000, minTicks: 4, maxTicks: 4 },
    ]);
  });

  it('resets the timer when the condition breaks', () => {
    const e = new SignalEngine(settings({ buy: { seconds: 3, ticks: 4, auto: false } }));
    e.start();
    expect(run(e, 0, 2500, 5)).toEqual([]);
    expect(run(e, 2600, 2600, 3)).toEqual([]);
    expect(run(e, 2700, 5600, 5)).toEqual([]);
    expect(run(e, 5700, 5700, 5)).toHaveLength(1);
  });

  it('fires Sell on downward movement', () => {
    const e = new SignalEngine(settings({ sell: { seconds: 1, ticks: 2, auto: false } }));
    e.start();
    expect(run(e, 0, 1000, -2).map((f) => f.kind)).toEqual(['sell']);
  });

  it('fires once per move: no repeat until the condition breaks', () => {
    // Auto entry with no position on the site yet (order rejected): the latch still prevents repeats.
    const e = new SignalEngine(settings({ buy: { seconds: 1, ticks: 2, auto: true } }));
    e.start();
    expect(run(e, 0, 5000, 3)).toHaveLength(1);
    run(e, 5100, 5100, 0);
    expect(run(e, 5200, 6200, 3)).toHaveLength(1);
  });

  it('does nothing while stopped or warming up', () => {
    const e = new SignalEngine(settings());
    expect(run(e, 0, 5000, 10)).toEqual([]);
    e.start();
    expect(run(e, 0, 5000, null)).toEqual([]);
  });

  it('supports zero duration', () => {
    const e = new SignalEngine(settings({ buy: { seconds: 0, ticks: 1, auto: false } }));
    e.start();
    expect(run(e, 0, 0, 1)).toHaveLength(1);
  });

  it('reports the lowest and highest ticks seen while the condition held', () => {
    const e = new SignalEngine(settings({ buy: { seconds: 2, ticks: 5, auto: false } }));
    e.start();
    const ticks = [5, 7, 9, 6, 5, 8];
    const fired = ticks.flatMap((t, i) => run(e, i * 400, i * 400, t));
    expect(fired).toMatchObject([{ kind: 'buy', heldMs: 2000, minTicks: 5, maxTicks: 9 }]);
  });
});

describe('SignalEngine close', () => {
  /** Signal-only Buy at price 100 (t = 0), then the given Close rule and delay. */
  const afterBuy = (seconds: number, ticks: number, closeDelay = 0) => {
    const e = new SignalEngine(
      settings({
        reentry: true,
        buy: { seconds: 0, ticks: 1, auto: false },
        close: { seconds, ticks, auto: false },
        closeDelay,
      }),
    );
    e.start();
    expect(run(e, 0, 0, 3, 'flat', 100).map((f) => f.kind)).toEqual(['buy']);
    return e;
  };

  it('0 s: any rebound, even 1 tick, resets the reference', () => {
    // Customer's example above the entry price: down 4, up 1, down 5 → the decline counts as 5, not 8.
    const e = afterBuy(0, 6);
    path(e, 100, [120]);
    expect(path(e, 200, [119, 118, 117, 116, 117, 116, 115, 114, 113, 112])).toEqual([]);
    expect(path(e, 1200, [111])).toMatchObject([
      { kind: 'close', reason: 'move', refPrice: 117, moveTicks: 6, entryPrice: 100 },
    ]);
  });

  it('0 s: a rebound between two loop samples still resets the reference', () => {
    const e = afterBuy(0, 5);
    path(e, 100, [120, 117]);
    // 118 shows up on the page and is gone before the next loop sample.
    e.notePrice(250, 118);
    e.notePrice(270, 117);
    expect(path(e, 300, [114])).toEqual([]);
    expect(path(e, 400, [113])).toMatchObject([{ kind: 'close', refPrice: 118, moveTicks: 5 }]);
  });

  it('0 s: a new high moves the reference', () => {
    const e = afterBuy(0, 8);
    expect(path(e, 100, [110, 111, 112, 113, 110, 106])).toEqual([]);
    expect(path(e, 700, [105])).toMatchObject([{ kind: 'close', refPrice: 113, moveTicks: 8 }]);
  });

  it('0 s: no time limit, a slow decline still closes', () => {
    const e = afterBuy(0, 10);
    path(e, 100, [120]);
    const slow = Array.from({ length: 9 }, (_, i) => 119 - i);
    expect(path(e, 1000, slow, 'flat', 30_000)).toEqual([]);
    expect(path(e, 400_000, [110])).toMatchObject([{ kind: 'close', refPrice: 120, moveTicks: 10 }]);
  });

  it('closes immediately, with no extra waiting', () => {
    const e = afterBuy(1, 10);
    path(e, 100, [115]);
    expect(path(e, 200, [105])).toMatchObject([{ t: 200, kind: 'close' }]);
  });

  it('N s: measures from the highest price within the latest N seconds', () => {
    const e = afterBuy(3, 10);
    // Up to 130, then a slow decline of 1 tick per second: never 10 ticks within 3 s.
    expect(path(e, 100, [125, 130])).toEqual([]);
    const slow = Array.from({ length: 15 }, (_, i) => 129 - i);
    expect(path(e, 1000, slow, 'flat', 1000)).toEqual([]);
    // Now at 115 (t = 15 s). At 15.7 s the window starts at 12.7 s, when the price was 118:
    // falling to 106 is 12 ticks within the window and closes.
    expect(path(e, 15_500, [113, 110])).toEqual([]);
    expect(path(e, 15_700, [106])).toMatchObject([{ kind: 'close', refPrice: 118, moveTicks: 12 }]);
  });

  it('N s: the window never reaches back before entry', () => {
    // Price was 120 before the Buy at 100: that high must not count.
    const e = new SignalEngine(
      settings({ buy: { seconds: 0, ticks: 1, auto: false }, close: { seconds: 5, ticks: 10, auto: false } }),
    );
    e.start();
    path(e, 0, [120]);
    run(e, 100, 100, 3, 'flat', 100);
    expect(path(e, 200, [110, 101])).toEqual([]);
    expect(path(e, 400, [100])).toMatchObject([{ kind: 'close', reason: 'move', refPrice: 110 }]);
  });

  it('after Sell, mirrored: measures the rise from the lowest price', () => {
    const e = new SignalEngine(
      settings({ sell: { seconds: 0, ticks: 1, auto: false }, close: { seconds: 0, ticks: 8, auto: false } }),
    );
    e.start();
    expect(run(e, 0, 0, -3, 'flat', 100).map((f) => f.kind)).toEqual(['sell']);
    expect(path(e, 100, [90, 89, 88, 91, 95])).toEqual([]);
    expect(path(e, 600, [96])).toMatchObject([{ kind: 'close', refPrice: 88, moveTicks: 8, side: 'short' }]);
  });

  it('works for a position opened by hand on the site, measured from when it was seen', () => {
    const e = new SignalEngine(settings({ close: { seconds: 0, ticks: 5, auto: true } }));
    e.start();
    expect(path(e, 0, [200, 206], 'long')).toEqual([]);
    expect(path(e, 200, [201], 'long')).toMatchObject([
      { kind: 'close', auto: true, reason: 'move', refPrice: 206, entryPrice: 200 },
    ]);
  });

  it('auto entry: measures from the entry signal price, also while the site catches up', () => {
    const e = new SignalEngine(
      settings({ buy: { seconds: 0, ticks: 1, auto: true }, close: { seconds: 0, ticks: 5, auto: true } }),
      5000,
    );
    e.start();
    expect(run(e, 0, 0, 3, 'flat', 100)).toHaveLength(1);
    e.markOrderSent(0);
    // The site shows the position a moment later at a higher price; the high so far is 113.
    path(e, 100, [110, 113]);
    expect(path(e, 300, [111], 'long')).toEqual([]);
    expect(path(e, 400, [108], 'long')).toMatchObject([{ kind: 'close', refPrice: 113, entryPrice: 100 }]);
  });

  it('gives one close signal per move for a real position that stays open', () => {
    const e = new SignalEngine(settings({ close: { seconds: 0, ticks: 2, auto: false } }));
    e.start();
    path(e, 0, [100, 110], 'long');
    expect(path(e, 200, [108, 107, 106], 'long')).toHaveLength(1);
  });

  it('reports the move back while a position is held', () => {
    const e = afterBuy(0, 10);
    path(e, 100, [104]);
    const r = e.update({ now: 200, ticks: 0, price: 101, tickSize: TICK, side: 'flat' });
    expect(r.close).toEqual({ refPrice: 104, moveTicks: 3, entryPrice: 100, delayMs: null });
    expect(r.progress.close).toBeCloseTo(0.3);
  });

  it('ignores entry rules while a position is open', () => {
    const e = new SignalEngine(settings({ buy: { seconds: 0, ticks: 1, auto: true } }));
    e.start();
    expect(run(e, 0, 1000, 5, 'long')).toEqual([]);
  });
});

describe('SignalEngine close delay and entry price', () => {
  const afterBuy = (closeDelay: number, ticks = 5) => {
    const e = new SignalEngine(
      settings({
        reentry: true,
        buy: { seconds: 0, ticks: 1, auto: false },
        close: { seconds: 0, ticks, auto: false },
        closeDelay,
      }),
    );
    e.start();
    run(e, 0, 0, 3, 'flat', 100);
    path(e, 100, [120]);
    return e;
  };

  it('closes when the condition holds for the whole delay', () => {
    const e = afterBuy(2);
    // 5 ticks down from 120 at t = 1 s, and it stays there.
    expect(path(e, 1000, Array(20).fill(115))).toEqual([]);
    expect(path(e, 3000, [115])).toMatchObject([{ kind: 'close', reason: 'move', delayMs: 2000, moveTicks: 5 }]);
  });

  it('resets the delay when the condition clears, and starts again when it returns', () => {
    const e = afterBuy(2);
    path(e, 1000, [115]);
    // At 2 s the price ticks up: new reference 117, move back 0, the condition clears.
    expect(path(e, 2000, [117])).toEqual([]);
    // Down 5 from 117 at 2.5 s: a new delay starts there.
    expect(path(e, 2500, Array(20).fill(112))).toEqual([]);
    expect(path(e, 4500, [112])).toMatchObject([{ t: 4500, kind: 'close', delayMs: 2000 }]);
  });

  it('shows the running delay in the close watch and progress', () => {
    const e = afterBuy(2);
    path(e, 1000, [115]);
    const r = e.update({ now: 1500, ticks: 0, price: 115, tickSize: TICK, side: 'flat' });
    expect(r.close?.delayMs).toBe(500);
    expect(r.progress.close).toBeCloseTo(0.25);
  });

  it('closes at once when the price crosses the entry price, whatever the delay', () => {
    const e = afterBuy(30, 50);
    // 20 ticks down from the high is below the 50-tick setting, and the delay is long; still not below entry.
    expect(path(e, 1000, [101, 100])).toEqual([]);
    expect(path(e, 1200, [99])).toMatchObject([{ kind: 'close', reason: 'entry', entryPrice: 100 }]);
  });

  it('the entry level stays fixed and does not follow the market', () => {
    const e = afterBuy(30, 50);
    // The price ran far up; the forced level is still the entry price 100, not the high.
    path(e, 1000, [150, 140, 120, 101]);
    expect(path(e, 1400, [100])).toEqual([]);
    expect(path(e, 1500, [99])).toMatchObject([{ reason: 'entry' }]);
  });

  it('a short is closed at once when the price rises above its entry price', () => {
    const e = new SignalEngine(
      settings({
        sell: { seconds: 0, ticks: 1, auto: false },
        close: { seconds: 0, ticks: 50, auto: false },
        closeDelay: 30,
      }),
    );
    e.start();
    run(e, 0, 0, -3, 'flat', 100);
    expect(path(e, 100, [90, 100])).toEqual([]);
    expect(path(e, 300, [101])).toMatchObject([{ kind: 'close', reason: 'entry', side: 'short' }]);
  });

  it('Close ON/OFF applies to the forced close too', () => {
    const on = new SignalEngine(settings({ close: { seconds: 0, ticks: 50, auto: true }, closeDelay: 30 }));
    on.start();
    path(on, 0, [100], 'long');
    expect(path(on, 100, [99], 'long')).toMatchObject([{ reason: 'entry', auto: true }]);
    const off = new SignalEngine(settings({ close: { seconds: 0, ticks: 50, auto: false }, closeDelay: 30 }));
    off.start();
    path(off, 0, [100], 'long');
    expect(path(off, 100, [99], 'long')).toMatchObject([{ reason: 'entry', auto: false }]);
  });
});

describe('SignalEngine order flow', () => {
  it('blocks duplicate orders until the position changes', () => {
    const e = new SignalEngine(settings({ buy: { seconds: 0, ticks: 1, auto: true } }), 5000);
    e.start();
    expect(run(e, 0, 0, 2)).toHaveLength(1);
    e.markOrderSent(0);
    run(e, 100, 100, 0);
    expect(run(e, 200, 4900, 2)).toEqual([]);
    // Position appeared: pending clears, close rules take over.
    run(e, 5000, 5000, 2, 'long');
    expect(e.isRunning).toBe(true);
  });

  it('stops after a close when re-entry is OFF', () => {
    const e = new SignalEngine(settings({ reentry: false }));
    e.start();
    run(e, 0, 0, 0, 'long');
    const r = e.update({ now: 100, ticks: 0, price: 100, tickSize: TICK, side: 'flat' });
    expect(r.stopped).toBe(true);
    expect(e.isRunning).toBe(false);
  });

  it('keeps watching after a close when re-entry is ON, including closes made by the site', () => {
    const e = new SignalEngine(settings({ reentry: true, buy: { seconds: 0, ticks: 1, auto: false } }));
    e.start();
    run(e, 0, 0, 0, 'short');
    const r = e.update({ now: 100, ticks: 0, price: 100, tickSize: TICK, side: 'flat' });
    expect(r.stopped).toBe(false);
    expect(run(e, 200, 200, 1)).toHaveLength(1);
  });
});

describe('SignalEngine signal-only position', () => {
  const signalOnly = (patch: Partial<EngineSettings> = {}) =>
    settings({
      buy: { seconds: 0, ticks: 2, auto: false },
      sell: { seconds: 0, ticks: 2, auto: false },
      close: { seconds: 0, ticks: 5, auto: false },
      ...patch,
    });

  it('blocks new entries after a signal until the close signal', () => {
    const e = new SignalEngine(signalOnly({ reentry: true }));
    e.start();
    expect(run(e, 0, 0, 3).map((f) => f.kind)).toEqual(['buy']);
    expect(e.signalPosition).toBe('long');
    // Strong moves either way give no new entries while the signal position is open.
    expect(run(e, 100, 500, 5, 'flat', 110)).toEqual([]);
    expect(run(e, 600, 600, -5, 'flat', 108)).toEqual([]);
    // Down 5 from the high (still above entry): close, then entries are allowed again.
    expect(run(e, 700, 700, -2, 'flat', 105)).toMatchObject([
      { kind: 'close', reason: 'move', side: 'long', virtual: true, auto: false },
    ]);
    expect(e.signalPosition).toBe('flat');
    expect(run(e, 800, 800, -3, 'flat', 104).map((f) => f.kind)).toEqual(['sell']);
    expect(e.signalPosition).toBe('short');
  });

  it('never clicks the close button for a signal position', () => {
    const e = new SignalEngine(signalOnly({ reentry: true, close: { seconds: 0, ticks: 1, auto: true } }));
    e.start();
    run(e, 0, 0, 3);
    expect(run(e, 100, 100, 0, 'flat', 99)).toMatchObject([{ kind: 'close', auto: false, virtual: true }]);
  });

  it('stops after the close signal when re-entry is OFF, like a real close', () => {
    const e = new SignalEngine(signalOnly({ reentry: false }));
    e.start();
    run(e, 0, 0, 3);
    const r = e.update({ now: 100, ticks: 0, price: 95, tickSize: TICK, side: 'flat' });
    expect(r.fired?.kind).toBe('close');
    expect(r.stopped).toBe(true);
    expect(e.isRunning).toBe(false);
    expect(e.isPaused).toBe(false);
    expect(run(e, 200, 2000, 5)).toEqual([]);
  });

  it('pause keeps the signal position and resume continues from it', () => {
    const e = new SignalEngine(signalOnly({ reentry: true }));
    e.start();
    run(e, 0, 0, 3);
    e.pause();
    expect(e.isRunning).toBe(false);
    expect(e.isPaused).toBe(true);
    // The pause comes from a frozen price, so the price does not move meanwhile.
    expect(run(e, 100, 2000, 0, 'flat', 100)).toEqual([]);
    e.resume();
    expect(e.signalPosition).toBe('long');
    // Still in the signal position: entries stay blocked, only close can fire.
    expect(run(e, 2100, 2100, -5, 'flat', 100)).toEqual([]);
    expect(run(e, 2200, 2200, 0, 'flat', 95).map((f) => f.kind)).toEqual(['close']);
  });

  it('lets a real position on the site replace the signal one', () => {
    const e = new SignalEngine(signalOnly({ reentry: true }));
    e.start();
    run(e, 0, 0, 3);
    run(e, 100, 100, 0, 'short');
    expect(e.signalPosition).toBe('flat');
  });

  it('does not open a signal position for an auto entry', () => {
    const e = new SignalEngine(signalOnly({ buy: { seconds: 0, ticks: 2, auto: true } }));
    e.start();
    run(e, 0, 0, 3);
    expect(e.signalPosition).toBe('flat');
  });

  it('stop clears the signal position and the pause', () => {
    const e = new SignalEngine(signalOnly());
    e.start();
    run(e, 0, 0, 3);
    e.stop();
    expect(e.signalPosition).toBe('flat');
    expect(e.isPaused).toBe(false);
  });
});
