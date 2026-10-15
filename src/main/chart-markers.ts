import type { WebContents, WebFrameMain } from 'electron';
import type { ActionKind } from '../engine/types';

export interface ChartMarker {
  /** Instrument code as shown on the site, e.g. A01612 or NQZ26. */
  item: string;
  /** Unix seconds; TradingView snaps it to the candle that contains it. */
  time: number;
  price: number;
  kind: ActionKind;
  /** Triangle points up for buys and for closing a short, down for sells and for closing a long. */
  up: boolean;
}

const COLOR: Record<ActionKind, string> = { buy: '#ef4a4a', sell: '#3b82f6', close: '#f0b429' };
const ICON_UP = 0xf0d8; // FontAwesome caret-up, the triangle TradingView's icon tool draws
const ICON_DOWN = 0xf0d7;
const MAX_MARKERS = 500;
/**
 * Customer's sample (15.10): the original 26 px triangle exactly at the signal's time and price,
 * with a thick white outline. The outline is a larger white triangle drawn first on the same point;
 * both are in front of the candles.
 */
const LAYERS = [
  { size: 34, color: '#ffffff' },
  { size: 26, color: null },
] as const;

/**
 * Puts a triangle on the site's TradingView chart for every signal.
 * The chart lives in a cross-origin iframe (/tradingchart/), whose inner frame exposes the
 * standard `tradingViewApi`. Shapes are created with disableSave, so the user's saved layout
 * is never touched. Sync is idempotent: it redraws whatever is missing after a chart reload
 * or an instrument switch.
 */
export class ChartMarkers {
  private markers: ChartMarker[] = [];
  private busy = false;

  constructor(private readonly site: () => WebContents | null) {}

  add(marker: ChartMarker): void {
    this.markers.push(marker);
    if (this.markers.length > MAX_MARKERS) this.markers.shift();
    void this.sync();
  }

  async sync(): Promise<void> {
    const wc = this.site();
    if (this.busy || !wc || wc.isDestroyed()) return;
    const frame = findChartFrame(wc.mainFrame);
    if (!frame) return;
    this.busy = true;
    try {
      await frame.executeJavaScript(drawScript(this.markers));
    } catch {
      // The chart may be reloading; the next sync will catch up.
    } finally {
      this.busy = false;
    }
  }
}

function findChartFrame(root: WebFrameMain): WebFrameMain | undefined {
  return root.framesInSubtree.find((f) => f.url.includes('/tradingchart/'));
}

/** Runs in the chart frame's own page context. Kept self-contained: it is sent as a string. */
export function drawScript(markers: ChartMarker[]): string {
  const payload = JSON.stringify(
    markers.map((m) => ({
      key: `${m.item}|${m.time}|${m.kind}|${m.price}`,
      item: m.item,
      time: m.time,
      price: m.price,
      icon: m.up ? ICON_UP : ICON_DOWN,
      color: COLOR[m.kind],
    })),
  );
  return `(async () => {
    const inner = document.querySelector('iframe');
    const api = inner && inner.contentWindow && inner.contentWindow.tradingViewApi;
    if (!api) return 0;
    const chart = api.activeChart();
    const symbol = String(chart.symbol() || '').split(':').pop();
    const state = window.__ttMarkers || (window.__ttMarkers = { symbol, ids: new Map() });
    const removeAll = (ids) => { for (const id of ids) { try { chart.removeEntity(id); } catch (e) {} } };
    if (state.symbol !== symbol) {
      for (const ids of state.ids.values()) removeAll(ids);
      state.ids.clear();
      state.symbol = symbol;
    }

    let drawn = 0;
    const markers = ${payload};
    const layers = ${JSON.stringify(LAYERS)};
    for (const m of markers) {
      if (m.item !== symbol) continue;
      const known = state.ids.get(m.key);
      if (known && known.length) { try { if (chart.getShapeById(known[known.length - 1])) continue; } catch (e) {} removeAll(known); }
      // Exactly at the signal's time and price, on the candle.
      const ids = [];
      for (const layer of layers) {
        const id = await chart.createShape({ time: m.time, price: m.price }, {
          shape: 'icon', lock: true, disableSelection: true, disableSave: true, disableUndo: true, zOrder: 'top',
          overrides: { icon: m.icon, color: layer.color || m.color, size: layer.size },
        });
        if (id) ids.push(id);
      }
      if (ids.length) { state.ids.set(m.key, ids); drawn++; }
    }
    return drawn;
  })()`;
}
