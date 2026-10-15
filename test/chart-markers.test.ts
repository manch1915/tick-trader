import { describe, expect, it, vi } from 'vitest';

// chart-markers imports Electron types only, but keep the module graph free of the real package.
vi.mock('electron', () => ({}));
const { drawScript } = await import('../src/main/chart-markers');

interface Shape {
  point: { time: number; price: number };
  opts: { zOrder: string; overrides: { color: string; size: number } };
}

/** A stand-in for TradingView's chart API. */
function fakeChart() {
  const shapes = new Map<string, Shape>();
  let next = 1;
  const chart = {
    symbol: () => 'KRX:A01612',
    createShape: async (point: Shape['point'], opts: Shape['opts']) => {
      const id = `s${next++}`;
      shapes.set(id, { point, opts });
      return id;
    },
    getShapeById: (id: string) => shapes.get(id) ?? null,
    removeEntity: (id: string) => shapes.delete(id),
  };
  return { chart, shapes };
}

async function draw(chart: unknown, markers: Parameters<typeof drawScript>[0]): Promise<number> {
  const g = globalThis as Record<string, unknown>;
  g.document = { querySelector: () => ({ contentWindow: { tradingViewApi: { activeChart: () => chart } } }) };
  return (0, eval)(drawScript(markers)) as Promise<number>;
}

const buy = { item: 'A01612', time: 1_000_000, price: 950, kind: 'buy' as const, up: true };
const sell = { item: 'A01612', time: 1_000_001, price: 951.5, kind: 'sell' as const, up: false };

describe('chart markers', () => {
  it('draws the original 26 px triangle over a thick white outline, in front of the candles', async () => {
    (globalThis as Record<string, unknown>).window = {};
    const { chart, shapes } = fakeChart();
    expect(await draw(chart, [buy])).toBe(1);
    const layers = [...shapes.values()];
    expect(layers.map((s) => s.opts.overrides.size)).toEqual([34, 26]);
    expect(layers.map((s) => s.opts.overrides.color)).toEqual(['#ffffff', '#ef4a4a']);
    expect(layers.every((s) => s.opts.zOrder === 'top')).toBe(true);
  });

  it('puts every layer exactly at the signal time and price', async () => {
    (globalThis as Record<string, unknown>).window = {};
    const { chart, shapes } = fakeChart();
    await draw(chart, [buy, sell]);
    const points = [...shapes.values()].map((s) => s.point);
    expect(points).toEqual([
      { time: 1_000_000, price: 950 },
      { time: 1_000_000, price: 950 },
      { time: 1_000_001, price: 951.5 },
      { time: 1_000_001, price: 951.5 },
    ]);
  });

  it('does not draw the same marker twice', async () => {
    (globalThis as Record<string, unknown>).window = {};
    const { chart, shapes } = fakeChart();
    await draw(chart, [buy]);
    expect(await draw(chart, [buy])).toBe(0);
    expect(shapes.size).toBe(2);
  });
});
