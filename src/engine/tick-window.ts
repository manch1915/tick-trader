interface Point {
  ts: number;
  price: number;
}

/**
 * Keeps recent price updates and answers "how far did the price move over the last window".
 * The price at a moment is the last update at or before it, so gaps between updates mean
 * the price stood still.
 */
export class TickWindow {
  private points: Point[] = [];
  private lastTs = -Infinity;

  constructor(
    private readonly windowMs = 1000,
    private readonly keepMs = 5000,
  ) {}

  push(ts: number, price: number): void {
    if (!Number.isFinite(price)) return;
    if (ts < this.lastTs) return;
    this.lastTs = ts;
    const last = this.points[this.points.length - 1];
    if (last && last.price === price) return;
    this.points.push({ ts, price });
    this.prune(ts);
  }

  clear(): void {
    this.points = [];
    this.lastTs = -Infinity;
  }

  priceAt(t: number): number | null {
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i]!;
      if (p.ts <= t) return p.price;
    }
    return null;
  }

  /** Price change over the last window, or null until a full window of history exists. */
  change(now: number): number | null {
    const cur = this.priceAt(now);
    const prev = this.priceAt(now - this.windowMs);
    if (cur === null || prev === null) return null;
    return cur - prev;
  }

  private prune(now: number): void {
    const cutoff = now - this.keepMs;
    // Keep the last point before the cutoff: it is still the price at the cutoff moment.
    let firstKept = 0;
    while (firstKept + 1 < this.points.length && this.points[firstKept + 1]!.ts <= cutoff) firstKept++;
    if (firstKept > 0) this.points.splice(0, firstKept);
  }
}

export function toTicks(delta: number, tickSize: number): number {
  return Math.round(delta / tickSize);
}
