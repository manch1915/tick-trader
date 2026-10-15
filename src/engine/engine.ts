import type { ActionKind, EngineSettings, Side } from './types';

export interface EngineInput {
  now: number;
  /** 1-second price change in ticks, null while warming up or without a price. */
  ticks: number | null;
  /** Current price and tick size; Close is measured in price, not in 1-second ticks. */
  price: number | null;
  tickSize: number | null;
  side: Side;
}

export interface Fired {
  kind: ActionKind;
  auto: boolean;
  /** 1-second change in ticks at the moment of firing. */
  ticks: number;
  /** Threshold of the rule that fired. */
  threshold: number;
  /** Entry: how long the condition held. Close: how long the position was held. */
  heldMs: number;
  /** Entry only: lowest and highest 1-second tick values seen while the condition held. */
  minTicks: number;
  maxTicks: number;
  /** Close only: the high (long) or low (short) the move back is measured from, and that move in ticks. */
  refPrice: number | null;
  moveTicks: number | null;
  /** Close only: price at the entry; also the fixed level for the forced close. */
  entryPrice: number | null;
  /**
   * Close only. 'move': the move back held through the close delay.
   * 'entry': the price crossed the entry price against the position (forced, no delay).
   */
  reason: CloseReason | null;
  /** Close only: how long the move-back condition held before closing (the delay part). */
  delayMs: number | null;
  /** Position the rule was judged against: the site's, or the signal position when the site is flat. */
  side: Side;
  /** True when the position is only a signal position (no real order behind it). */
  virtual: boolean;
}

export type CloseReason = 'move' | 'entry';

export interface CloseWatch {
  /** High (long) or low (short) the move back is measured from. */
  refPrice: number;
  /** Move back from the reference in ticks, 0 or more. */
  moveTicks: number;
  /** Entry price: crossing it against the position closes at once. */
  entryPrice: number;
  /** How long the move-back condition has held so far, null while it does not hold. */
  delayMs: number | null;
}

export interface EngineResult {
  fired: Fired | null;
  /** True when a close stopped the engine because re-entry is OFF. */
  stopped: boolean;
  /** Entries: share of the duration the condition has held. Close: move back / threshold. 0..1 */
  progress: Record<ActionKind, number>;
  /** Close measurement while a position is held, null otherwise. */
  close: CloseWatch | null;
}

interface EntryState {
  since: number | null;
  minTicks: number;
  maxTicks: number;
  /** Set after firing; cleared only when the condition breaks, so one move gives one signal. */
  latched: boolean;
}

interface Point {
  ts: number;
  price: number;
}

/**
 * Prices since entry for the Close rule.
 * Window 0 s: the move is measured from where the current move against the position began.
 *   Long: any rise, even 1 tick, makes the new price the reference; short: any fall.
 *   Starts at the entry price.
 * Window N s: long measures from the highest price within the latest N seconds, short from the lowest
 *   (never before entry).
 */
class CloseTracker {
  readonly points: Point[];
  latched = false;
  /** When the current run of the move-back condition began (close delay), null while it does not hold. */
  hitSince: number | null = null;
  /** Reference for the 0 s window: the price where the current move against the position began. */
  private turnPrice: number;

  constructor(
    readonly side: 'long' | 'short',
    readonly since: number,
    readonly entryPrice: number,
  ) {
    this.points = [{ ts: since, price: entryPrice }];
    this.turnPrice = entryPrice;
  }

  push(ts: number, price: number): void {
    const last = this.points[this.points.length - 1]!;
    if (last.price === price) return;
    const inFavour = this.side === 'long' ? price > last.price : price < last.price;
    if (inFavour) this.turnPrice = price;
    // Page updates and loop samples interleave; keep the list in time order.
    this.points.push({ ts: Math.max(ts, last.ts), price });
  }

  reference(now: number, windowMs: number): number {
    if (windowMs <= 0) return this.turnPrice;
    const better = this.side === 'long' ? Math.max : Math.min;
    const cutoff = now - windowMs;
    let ref: number | null = null;
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i]!;
      ref = ref === null ? p.price : better(ref, p.price);
      // The last price before the window is still the price at the window's start.
      if (p.ts <= cutoff) break;
    }
    return ref!;
  }

  /** Drops points older than any window can reach, keeping the price at the oldest window start. */
  prune(now: number, keepMs: number): void {
    const cutoff = now - keepMs;
    let first = 0;
    while (first + 1 < this.points.length && this.points[first + 1]!.ts <= cutoff) first++;
    if (first > 0) this.points.splice(0, first);
  }
}

const MAX_WINDOW_MS = 99_000;

const freshEntry = (): EntryState => ({ since: null, minTicks: 0, maxTicks: 0, latched: false });
const freshState = () => ({ buy: freshEntry(), sell: freshEntry() });

export class SignalEngine {
  private running = false;
  /** Paused by the program (frozen price in signal-only mode); keeps the signal position. */
  private paused = false;
  /**
   * Position opened by a signal-only entry. The site stays flat, but new entries are blocked
   * until the close signal, the same way a real position blocks them.
   */
  private signalSide: Side = 'flat';
  private state = freshState();
  private tracker: CloseTracker | null = null;
  private pendingUntil = 0;
  private lastSide: Side = 'flat';

  constructor(
    public settings: EngineSettings,
    /** How long to wait for the site to show a position change after a click. */
    private readonly pendingMs = 5000,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get signalPosition(): Side {
    return this.signalSide;
  }

  start(): void {
    this.running = true;
    this.paused = false;
    this.signalSide = 'flat';
    this.tracker = null;
    this.resetTimers();
  }

  /** Stops watching but keeps the signal position, so resume() continues where it left off. */
  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.paused = true;
    this.resetTimers();
  }

  resume(): void {
    if (!this.paused) return;
    this.running = true;
    this.paused = false;
    this.resetTimers();
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.signalSide = 'flat';
    this.tracker = null;
    this.resetTimers();
  }

  /** Restarts the entry duration timers (instrument switch, position change). */
  resetTimers(): void {
    this.state = freshState();
  }

  /**
   * Every price update from the page, as it arrives. The loop samples prices every 50 ms; a 1-tick
   * rebound between two samples still has to reset the 0 s Close reference.
   */
  notePrice(ts: number, price: number): void {
    this.tracker?.push(ts, price);
  }

  /** Call right after an order button is clicked; blocks further actions until the position changes. */
  markOrderSent(now: number): void {
    this.pendingUntil = now + this.pendingMs;
  }

  update({ now, ticks, price, tickSize, side }: EngineInput): EngineResult {
    let stopped = false;

    if (side !== this.lastSide) {
      const closed = this.lastSide !== 'flat' && side === 'flat';
      this.lastSide = side;
      this.pendingUntil = 0;
      this.resetTimers();
      if (closed && this.running && !this.settings.reentry) {
        this.running = false;
        stopped = true;
      }
    }
    // A real position always wins over the signal one.
    if (side !== 'flat') this.signalSide = 'flat';

    const virtual = side === 'flat' && this.signalSide !== 'flat';
    const held: Side = virtual ? this.signalSide : side;
    this.track(now, price, held);

    const result = (fired: Fired | null): EngineResult => {
      const close = this.closeWatch(now, price, tickSize);
      const progress = this.progress(now);
      const limit = this.settings.close.ticks;
      const delay = this.settings.closeDelay * 1000;
      // While the delay runs, the bar shows the delay; otherwise how close the move back is to the limit.
      if (close?.delayMs != null && delay > 0) progress.close = Math.min(1, close.delayMs / delay);
      else if (close && limit > 0) progress.close = Math.min(1, close.moveTicks / limit);
      return { fired, stopped, progress, close };
    };

    if (!this.running || ticks === null || price === null || !tickSize || now < this.pendingUntil) {
      this.resetTimers();
      if (this.tracker) this.tracker.hitSince = null;
      return result(null);
    }

    const fired = held === 'flat' ? this.checkEntries(now, ticks) : this.checkClose(now, ticks, price, tickSize, held);
    if (!fired) return result(null);
    fired.side = held;
    fired.virtual = virtual;
    // A signal position has nothing to close on the site, so its close is a signal only.
    if (virtual) fired.auto = false;

    if (fired.kind === 'close') {
      if (virtual) {
        this.signalSide = 'flat';
        this.tracker = null;
        this.resetTimers();
        // Same as a real close: re-entry OFF stops until Start.
        if (!this.settings.reentry) {
          this.running = false;
          stopped = true;
        }
      }
    } else {
      const entered = fired.kind === 'buy' ? 'long' : 'short';
      // Close is measured from the entry signal price, also for auto orders still waiting for the site.
      this.tracker = new CloseTracker(entered, now, price);
      if (!fired.auto) {
        this.signalSide = entered;
        this.resetTimers();
      }
      // Auto entries keep the latch: if the order never shows up, the same move must not order again.
    }
    return result(fired);
  }

  /** Keeps the Close reference in step with the held position and the latest price. */
  private track(now: number, price: number | null, held: Side): void {
    if (held === 'flat') {
      // An auto entry keeps its tracker, and keeps it up to date, while the site has not shown the position yet.
      if (now >= this.pendingUntil) this.tracker = null;
      else if (this.tracker && price !== null) this.tracker.push(now, price);
      return;
    }
    if (price === null) return;
    if (this.tracker?.side !== held) {
      // A position the program did not open (manual, or open at Start): measure from when it was seen.
      this.tracker = new CloseTracker(held, now, price);
      return;
    }
    this.tracker.push(now, price);
    this.tracker.prune(now, MAX_WINDOW_MS);
  }

  private checkEntries(now: number, ticks: number): Fired | null {
    let fired: Fired | null = null;
    for (const kind of ['buy', 'sell'] as const) {
      const st = this.state[kind];
      const rule = this.settings[kind];
      const holds = kind === 'buy' ? ticks >= rule.ticks : -ticks >= rule.ticks;
      if (!holds) {
        st.since = null;
        st.latched = false;
        continue;
      }
      if (st.latched) continue;
      if (st.since === null) {
        st.since = now;
        st.minTicks = ticks;
        st.maxTicks = ticks;
      } else {
        st.minTicks = Math.min(st.minTicks, ticks);
        st.maxTicks = Math.max(st.maxTicks, ticks);
      }
      if (!fired && now - st.since >= rule.seconds * 1000) {
        fired = {
          kind,
          auto: rule.auto,
          ticks,
          threshold: rule.ticks,
          heldMs: now - st.since,
          minTicks: st.minTicks,
          maxTicks: st.maxTicks,
          refPrice: null,
          moveTicks: null,
          entryPrice: null,
          reason: null,
          delayMs: null,
          side: 'flat',
          virtual: false,
        };
        st.since = null;
        st.latched = true;
      }
    }
    return fired;
  }

  /**
   * Close fires when either
   * - the move back from the reference holds for the whole close delay (a break resets the delay), or
   * - the price crosses the entry price against the position: at once, whatever the delay timer says.
   *   The entry price is fixed for the position and does not follow the market.
   */
  private checkClose(now: number, ticks: number, price: number, tickSize: number, held: Side): Fired | null {
    const tr = this.tracker;
    if (!tr || tr.side !== held) return null;
    const rule = this.settings.close;
    const ref = tr.reference(now, rule.seconds * 1000);
    const move = moveBack(tr.side, ref, price, tickSize);
    const hit = move >= rule.ticks;
    const forced = moveBack(tr.side, tr.entryPrice, price, tickSize) >= 1;
    if (!hit) tr.hitSince = null;
    if (!hit && !forced) {
      tr.latched = false;
      return null;
    }
    // A real position closed by signal only stays open on the site: one signal per move.
    if (tr.latched) return null;
    if (hit) tr.hitSince ??= now;
    const delayMs = tr.hitSince === null ? null : now - tr.hitSince;
    let reason: CloseReason;
    if (forced) reason = 'entry';
    else if (delayMs !== null && delayMs >= this.settings.closeDelay * 1000) reason = 'move';
    else return null;
    tr.latched = true;
    tr.hitSince = null;
    return {
      kind: 'close',
      auto: rule.auto,
      ticks,
      threshold: rule.ticks,
      heldMs: now - tr.since,
      minTicks: ticks,
      maxTicks: ticks,
      refPrice: ref,
      moveTicks: move,
      entryPrice: tr.entryPrice,
      reason,
      delayMs,
      side: held,
      virtual: false,
    };
  }

  private closeWatch(now: number, price: number | null, tickSize: number | null): CloseWatch | null {
    const tr = this.tracker;
    if (!tr || price === null || !tickSize) return null;
    const refPrice = tr.reference(now, this.settings.close.seconds * 1000);
    return {
      refPrice,
      moveTicks: moveBack(tr.side, refPrice, price, tickSize),
      entryPrice: tr.entryPrice,
      delayMs: tr.hitSince === null ? null : now - tr.hitSince,
    };
  }

  private progress(now: number): Record<ActionKind, number> {
    const p = (kind: 'buy' | 'sell'): number => {
      const st = this.state[kind];
      if (st.since === null) return 0;
      const ms = this.settings[kind].seconds * 1000;
      return ms === 0 ? 1 : Math.min(1, (now - st.since) / ms);
    };
    return { buy: p('buy'), sell: p('sell'), close: 0 };
  }
}

/** How far the price came back from the reference against the position, in ticks (never negative). */
function moveBack(side: 'long' | 'short', ref: number, price: number, tickSize: number): number {
  const delta = side === 'long' ? ref - price : price - ref;
  return Math.max(0, Math.round(delta / tickSize));
}
