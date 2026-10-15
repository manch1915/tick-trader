// Runs inside the trading website. Reads price, instrument and position from the page and
// presses the site's own order buttons on request. The page itself is never modified.
import { ipcRenderer } from 'electron';
import type { ActionKind, Side } from '../engine/types';
import { CH, type SiteSnapshot } from '../shared/ipc';

const BUTTON_TEXT: Record<ActionKind, string> = {
  buy: '시장가매수',
  sell: '시장가매도',
  close: '현종목청산',
};

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function parseNumber(text: string): number | null {
  const n = Number.parseFloat(text.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isVisible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Smallest visible element whose whole text equals `text`. */
function findByText(text: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(
    'button, a, input[type=button], td, th, div, span, label, p, strong, b, li',
  );
  let best: HTMLElement | null = null;
  for (const el of all) {
    const t = el instanceof HTMLInputElement ? el.value : el.textContent;
    if (norm(t) !== text || !isVisible(el)) continue;
    if (!best || best.contains(el)) best = el;
  }
  return best;
}

/** Info tables put labels in one row and values in the next row, same column. */
function valueBelow(label: string): string | null {
  const cell = [...document.querySelectorAll('td, th')].find((c) => norm(c.textContent) === label);
  if (!cell) return null;
  const row = cell.parentElement as HTMLTableRowElement | null;
  const next = row?.nextElementSibling as HTMLTableRowElement | null;
  const idx = (cell as HTMLTableCellElement).cellIndex;
  const value = next?.cells[idx];
  return value ? norm(value.textContent) : null;
}

function readPrice(): number | null {
  const el = document.querySelector('.markCurrPrice');
  return el ? parseNumber(el.textContent ?? '') : null;
}

function readItem(): string | null {
  const label = findByText('현종목');
  const input = label?.parentElement?.querySelector('input') ?? null;
  return input?.value ? norm(input.value) : null;
}

// TODO(live session): confirm how an open position appears in the 잔고 cell
// (sign, 매수/매도 text or colour) and adjust parsing if needed.
function readPosition(): { side: Side; qty: number; raw: string } {
  const raw = valueBelow('잔고') ?? '';
  const qty = parseNumber(raw);
  if (!qty) return { side: 'flat', qty: 0, raw };
  const short = /매도|sell|short/i.test(raw) || qty < 0;
  return { side: short ? 'short' : 'long', qty: Math.abs(qty), raw };
}

/** "주문가능수량 매수 0 매도 0": how many contracts the account margin allows right now. */
function readOrderable(): { canBuy: number | null; canSell: number | null } {
  const label = findByText('주문가능수량');
  // The numbers can sit in sibling cells or spans, so climb until a container holds both of them.
  let el: HTMLElement | null = label;
  for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
    const text = norm(el.textContent);
    const after = text.slice(text.indexOf('주문가능수량') + '주문가능수량'.length);
    const m = after.match(/매수\s*([\d,]+)\s*매도\s*([\d,]+)/);
    if (m) return { canBuy: parseNumber(m[1]!), canSell: parseNumber(m[2]!) };
  }
  return { canBuy: null, canSell: null };
}

function snapshot(): SiteSnapshot {
  const pos = readPosition();
  const tick = valueBelow('틱 사이즈');
  return {
    item: readItem(),
    tickSize: tick ? parseNumber(tick) : null,
    side: pos.side,
    qty: pos.qty,
    positionRaw: pos.raw,
    buttons: {
      buy: !!findByText(BUTTON_TEXT.buy),
      sell: !!findByText(BUTTON_TEXT.sell),
      close: !!findByText(BUTTON_TEXT.close),
    },
    ...readOrderable(),
    hasPrice: readPrice() !== null,
  };
}

let lastPrice: number | null = null;
let lastSnapshot = '';

function emitPrice(): void {
  const price = readPrice();
  if (price === null || price === lastPrice) return;
  lastPrice = price;
  ipcRenderer.send(CH.sitePrice, { ts: Date.now(), price });
}

function emitSnapshot(): void {
  const snap = snapshot();
  const key = JSON.stringify(snap);
  if (key === lastSnapshot) return;
  lastSnapshot = key;
  ipcRenderer.send(CH.siteSnapshot, snap);
}

window.addEventListener('DOMContentLoaded', () => {
  // Price updates arrive over the site's WebSocket and repaint the order book;
  // the observer picks them up immediately, the interval is a safety net.
  new MutationObserver(emitPrice).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  setInterval(emitPrice, 100);
  setInterval(emitSnapshot, 250);
});

ipcRenderer.on(CH.siteClick, (_e, kind: ActionKind) => {
  const btn = findByText(BUTTON_TEXT[kind]);
  if (btn) btn.click();
  ipcRenderer.send(CH.siteClickResult, { kind, ok: !!btn });
});
