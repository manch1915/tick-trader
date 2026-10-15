import type { ActionKind } from './types';

export type Counts = Record<ActionKind, number>;

export function localDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Signal counts for the current local day; resets itself when the date changes. */
export class DailyCounter {
  constructor(
    private date = '',
    private counts: Counts = { buy: 0, sell: 0, close: 0 },
  ) {}

  add(kind: ActionKind, now: number): void {
    this.roll(now);
    this.counts[kind]++;
  }

  get(now: number): { date: string; counts: Counts } {
    this.roll(now);
    return { date: this.date, counts: { ...this.counts } };
  }

  private roll(now: number): void {
    const today = localDate(now);
    if (today !== this.date) {
      this.date = today;
      this.counts = { buy: 0, sell: 0, close: 0 };
    }
  }
}
