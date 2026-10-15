export type ActionKind = 'buy' | 'sell' | 'close';
export type Side = 'flat' | 'long' | 'short';

export const ACTIONS: readonly ActionKind[] = ['buy', 'sell', 'close'];

export interface Rule {
  /**
   * Buy/Sell: how long the condition must hold without a break, 0..99 seconds.
   * Close: window for the reference high/low; 0 = since entry, N = within the latest N seconds.
   */
  seconds: number;
  /** Buy/Sell: threshold of the 1-second change in ticks. Close: move back from the high/low in ticks. */
  ticks: number;
  /** ON: click the site's button. OFF: signal only (sound + arrow). */
  auto: boolean;
}

export interface EngineSettings {
  buy: Rule;
  sell: Rule;
  /** Shared by long and short positions. */
  close: Rule;
  /**
   * Close delay, 0..99 seconds: the close condition must hold this long without a break.
   * Crossing the entry price against the position closes at once regardless.
   */
  closeDelay: number;
  /** ON: keep watching after a close. OFF: stop after a close until Start is pressed. */
  reentry: boolean;
}

export const LIMITS = {
  seconds: { min: 0, max: 99 },
  entryTicks: { min: 1, max: 999 },
  closeTicks: { min: 1, max: 999 },
} as const;

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  buy: { seconds: 3, ticks: 4, auto: false },
  sell: { seconds: 3, ticks: 4, auto: false },
  close: { seconds: 0, ticks: 5, auto: false },
  closeDelay: 0,
  reentry: false,
};
