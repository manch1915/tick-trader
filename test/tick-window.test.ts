import { describe, expect, it } from 'vitest';
import { TickWindow, toTicks } from '../src/engine/tick-window';

describe('TickWindow', () => {
  it('returns null until a full second of history exists', () => {
    const w = new TickWindow();
    w.push(1000, 100);
    expect(w.change(1500)).toBeNull();
    expect(w.change(2000)).toBe(0);
  });

  it('compares the current price with the price exactly one second ago', () => {
    const w = new TickWindow();
    w.push(0, 100);
    w.push(400, 100.1);
    w.push(1200, 100.25);
    // At 1300: price 100.25, at 300: price 100 (last update at or before 300).
    expect(w.change(1300)).toBeCloseTo(0.25);
    // At 1500: one second ago is 500, where the price was 100.1.
    expect(w.change(1500)).toBeCloseTo(0.15);
  });

  it('ignores repeated prices and out-of-order updates', () => {
    const w = new TickWindow();
    w.push(0, 100);
    w.push(500, 100);
    w.push(300, 99);
    expect(w.priceAt(600)).toBe(100);
  });

  it('keeps the price at the cutoff after pruning old points', () => {
    const w = new TickWindow(1000, 2000);
    w.push(0, 100);
    w.push(10_000, 101);
    expect(w.change(10_500)).toBeCloseTo(1);
  });
});

describe('toTicks', () => {
  it('rounds float noise to whole ticks', () => {
    expect(toTicks(0.2 - 0.05, 0.05)).toBe(3);
    expect(toTicks(-0.25, 0.25)).toBe(-1);
  });
});
