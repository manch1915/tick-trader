import type { CloseWatch } from '../engine/engine';
import type { ActionKind, EngineSettings, Side } from '../engine/types';
import type { Counts } from '../engine/daily-counter';

export interface AppSettings extends EngineSettings {
  siteUrl: string;
  /** Overrides the tick size read from the site; null = use the site's value. */
  tickSizeOverride: number | null;
}

export interface SiteSnapshot {
  item: string | null;
  tickSize: number | null;
  side: Side;
  qty: number;
  /** Raw text of the balance cell, shown in the panel while position parsing is being verified. */
  positionRaw: string;
  buttons: Record<ActionKind, boolean>;
  /** 주문가능수량 for buy/sell, null when the field is not on the page. */
  canBuy: number | null;
  canSell: number | null;
  hasPrice: boolean;
}

export type WarningCode = 'noSite' | 'noPrice' | 'stale' | 'noMargin' | 'noButtons';

export interface PanelState {
  running: boolean;
  /** Stopped by a close signal with re-entry OFF; Start resumes. */
  paused: boolean;
  /** Position opened by a signal-only entry, 'flat' when there is none. */
  signalSide: Side;
  /** At least one action has auto (real orders) switched on. */
  armed: boolean;
  price: number | null;
  ticks: number | null;
  tickSize: number | null;
  site: SiteSnapshot;
  progress: Record<ActionKind, number>;
  /** Close measurement while a position (real or signal) is held. */
  close: CloseWatch | null;
  counts: Counts;
  pending: boolean;
  warnings: WarningCode[];
}

/** Stop when the price has not changed for this long while running (logout, frozen feed). */
export const STALE_PRICE_MS = 30_000;

export interface SignalEvent {
  kind: ActionKind;
  auto: boolean;
  ticks: number;
  price: number | null;
  ts: number;
}

export interface LogEntry {
  ts: number;
  level: 'info' | 'signal' | 'order' | 'warn';
  text: string;
}

export type ControlCommand = 'start' | 'stop' | 'resetSettings' | 'reloadSite';

export const CH = {
  sitePrice: 'site:price',
  siteSnapshot: 'site:snapshot',
  siteClick: 'site:click',
  siteClickResult: 'site:click-result',
  panelState: 'panel:state',
  panelSignal: 'panel:signal',
  panelLog: 'panel:log',
  panelAlarm: 'panel:alarm',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  getLogs: 'logs:get',
  control: 'control',
  confirm: 'confirm',
} as const;
