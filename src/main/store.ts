import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDate } from '../engine/daily-counter';
import { DEFAULT_ENGINE_SETTINGS, LIMITS, type Rule } from '../engine/types';
import type { AppSettings, LogEntry } from '../shared/ipc';

export const DEFAULT_SETTINGS: AppSettings = {
  ...structuredClone(DEFAULT_ENGINE_SETTINGS),
  // The terminal's address is personal to the account; the user enters it in the panel.
  siteUrl: '',
  tickSizeOverride: null,
};

const clamp = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function sanitizeRule(input: Partial<Rule> | undefined, fallback: Rule, ticks: { min: number; max: number }): Rule {
  return {
    seconds: clamp(input?.seconds, LIMITS.seconds.min, LIMITS.seconds.max, fallback.seconds),
    ticks: clamp(input?.ticks, ticks.min, ticks.max, fallback.ticks),
    auto: typeof input?.auto === 'boolean' ? input.auto : fallback.auto,
  };
}

export function sanitizeSettings(input: Partial<AppSettings>, base: AppSettings = DEFAULT_SETTINGS): AppSettings {
  const tick = Number(input.tickSizeOverride);
  return {
    buy: sanitizeRule(input.buy, base.buy, LIMITS.entryTicks),
    sell: sanitizeRule(input.sell, base.sell, LIMITS.entryTicks),
    close: sanitizeRule(input.close, base.close, LIMITS.closeTicks),
    closeDelay: clamp(input.closeDelay, LIMITS.seconds.min, LIMITS.seconds.max, base.closeDelay),
    reentry: typeof input.reentry === 'boolean' ? input.reentry : base.reentry,
    siteUrl:
      typeof input.siteUrl === 'string' && (input.siteUrl === '' || /^https?:\/\//.test(input.siteUrl.trim()))
        ? input.siteUrl.trim()
        : base.siteUrl,
    tickSizeOverride: input.tickSizeOverride === null ? null : tick > 0 ? tick : base.tickSizeOverride,
  };
}

export class SettingsStore {
  private readonly file: string;
  current: AppSettings;

  constructor(dir: string) {
    this.file = join(dir, 'settings.json');
    this.current = this.load();
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.current = sanitizeSettings({ ...this.current, ...patch }, this.current);
    this.save();
    return this.current;
  }

  reset(): AppSettings {
    // The site address is not a trading setting, keep it.
    this.current = { ...structuredClone(DEFAULT_SETTINGS), siteUrl: this.current.siteUrl };
    this.save();
    return this.current;
  }

  private load(): AppSettings {
    try {
      return sanitizeSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.current, null, 2));
  }
}

/** Activity log: one file per day plus the last entries in memory for the panel. */
export class ActivityLog {
  private readonly dir: string;
  private readonly recent: LogEntry[] = [];

  constructor(
    baseDir: string,
    private readonly onEntry: (e: LogEntry) => void,
    private readonly keep = 300,
  ) {
    this.dir = join(baseDir, 'logs');
    mkdirSync(this.dir, { recursive: true });
  }

  add(level: LogEntry['level'], text: string): void {
    const entry: LogEntry = { ts: Date.now(), level, text };
    this.recent.push(entry);
    if (this.recent.length > this.keep) this.recent.shift();
    const time = new Date(entry.ts).toTimeString().slice(0, 8);
    try {
      appendFileSync(join(this.dir, `${localDate(entry.ts)}.log`), `${time} [${level}] ${text}\n`);
    } catch {
      // Logging must never stop trading logic.
    }
    this.onEntry(entry);
  }

  list(): LogEntry[] {
    return [...this.recent];
  }
}

export interface SignalRecord {
  ts: number;
  item: string | null;
  kind: string;
  /** 주문 (order clicked), 신호 (signal only) or 차단 (order blocked). */
  mode: string;
  price: number | null;
  priceBefore: number | null;
  ticks: number;
  threshold: number;
  heldSec: number;
  /** Entries: lowest and highest 1-second ticks while the condition held. */
  minTicks: number | null;
  maxTicks: number | null;
  /** Close: window in seconds (0 = since entry), high/low it measures from, entry price and the move back. */
  windowSec: number | null;
  refPrice: number | null;
  entryPrice: number | null;
  moveTicks: number | null;
  /** Close: 되돌림 (move back held through the delay) or 진입가 이탈 (price crossed the entry price). */
  closeReason: string | null;
  delaySec: number | null;
  tickSize: number | null;
  positionBefore: string;
  positionAfter: string;
}

const BOM = String.fromCharCode(0xfeff);
const CSV_HEAD =
  'time,item,signal,mode,price,price_1s_ago,ticks,threshold,held_sec,min_ticks,max_ticks,' +
  'close_window_sec,ref_high_low,entry_price,move_back_ticks,close_reason,close_delay_sec,tick_size,' +
  'position_before,position_after';
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Signal journal: one CSV row per signal, one file per day, opens in Excel. */
export class SignalJournal {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'logs');
    mkdirSync(this.dir, { recursive: true });
  }

  add(r: SignalRecord): void {
    const row = [
      stamp(r.ts), r.item, r.kind, r.mode, r.price, r.priceBefore, r.ticks, r.threshold, r.heldSec, r.minTicks,
      r.maxTicks, r.windowSec, r.refPrice, r.entryPrice, r.moveTicks, r.closeReason,
      r.delaySec, r.tickSize, r.positionBefore, r.positionAfter,
    ].map(csvCell).join(',');
    appendCsv(join(this.dir, `signals-${localDate(r.ts)}.csv`), CSV_HEAD, `${row}\n`);
  }
}

const stamp = (ts: number): string => {
  const d = new Date(ts);
  return `${localDate(ts)} ${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

function appendCsv(file: string, head: string, rows: string): void {
  try {
    // BOM so Excel reads the Korean text as UTF-8.
    if (!existsSync(file)) writeFileSync(file, `${BOM}${head}\n`);
    appendFileSync(file, rows);
  } catch {
    // Logging must never stop trading logic.
  }
}

/**
 * Every price update from the page, one file per day. With it a disputed signal can be replayed
 * exactly: feed the rows into TickWindow and SignalEngine with the same settings.
 */
export class PriceFeedLog {
  private readonly dir: string;
  private rows: { ts: number; line: string }[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'logs');
    mkdirSync(this.dir, { recursive: true });
    // Prices can arrive many times a second; write them in batches.
    this.timer = setInterval(() => this.flush(), 1000);
  }

  add(ts: number, item: string | null, price: number): void {
    this.rows.push({ ts, line: [stamp(ts), ts, item, price].map(csvCell).join(',') + '\n' });
  }

  flush(): void {
    if (this.rows.length === 0) return;
    const rows = this.rows;
    this.rows = [];
    // Group by day so rows around midnight land in the right file.
    const byFile = new Map<string, string>();
    for (const r of rows) {
      const file = join(this.dir, `prices-${localDate(r.ts)}.csv`);
      byFile.set(file, (byFile.get(file) ?? '') + r.line);
    }
    for (const [file, text] of byFile) appendCsv(file, 'time,epoch_ms,item,price', text);
  }

  close(): void {
    clearInterval(this.timer);
    this.flush();
  }
}
