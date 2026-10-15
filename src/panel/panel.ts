import type { ActionKind } from '../engine/types';
import type { PanelApi } from '../preload/panel';
import { STALE_PRICE_MS, type AppSettings, type LogEntry, type PanelState, type SignalEvent, type WarningCode } from '../shared/ipc';

declare global {
  interface Window {
    api: PanelApi;
  }
}

const api = window.api;
const KINDS: ActionKind[] = ['buy', 'sell', 'close'];
const SIGNAL_MS = 5000;
const NAMES: Record<ActionKind, string> = { buy: '매수', sell: '매도', close: '청산' };
const SIDE_TEXT = { flat: '없음', long: '매수', short: '매도' } as const;

const WARNING_TEXT: Record<WarningCode, { text: string; danger: boolean }> = {
  noSite: { text: '사이트 주소를 아래 설정에 입력해 주세요', danger: true },
  noPrice: { text: '가격을 읽을 수 없음 · 로그인 후 주문 화면을 열어 주세요', danger: true },
  stale: { text: `가격이 ${STALE_PRICE_MS / 1000}초 이상 변하지 않음 · 장 마감 또는 연결 끊김`, danger: false },
  noMargin: { text: '주문가능수량 0 · 증거금 부족으로 자동 주문이 실행되지 않습니다', danger: true },
  noButtons: { text: '주문 버튼을 찾을 수 없음 · 사이트의 주문 화면을 확인해 주세요', danger: true },
};

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const ruleEl = (kind: ActionKind) => $(`.rule[data-kind=${kind}]`);
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

let settings: AppSettings;

function setToggle(btn: HTMLButtonElement, on: boolean): void {
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? 'ON' : 'OFF';
}

function renderSettings(s: AppSettings): void {
  settings = s;
  for (const kind of KINDS) {
    const el = ruleEl(kind);
    const rule = s[kind];
    const sec = $<HTMLInputElement>('.seconds', el);
    const ticks = $<HTMLInputElement>('.ticks', el);
    if (document.activeElement !== sec) sec.value = String(rule.seconds);
    if (document.activeElement !== ticks) ticks.value = String(rule.ticks);
    setToggle($<HTMLButtonElement>('.toggle', el), rule.auto);
  }
  setToggle($<HTMLButtonElement>('#reentry'), s.reentry);
  const url = $<HTMLInputElement>('#site-url');
  if (document.activeElement !== url) url.value = s.siteUrl;
  const delay = $<HTMLInputElement>('#close-delay');
  if (document.activeElement !== delay) delay.value = String(s.closeDelay);
}

async function save(patch: Partial<AppSettings>): Promise<void> {
  renderSettings(await api.setSettings(patch));
}

function bindControls(): void {
  for (const kind of KINDS) {
    const el = ruleEl(kind);
    for (const field of ['seconds', 'ticks'] as const) {
      $<HTMLInputElement>(`.${field}`, el).addEventListener('change', (e) => {
        const value = Number((e.target as HTMLInputElement).value);
        void save({ [kind]: { ...settings[kind], [field]: value } });
      });
    }
    $<HTMLButtonElement>('.toggle', el).addEventListener('click', async () => {
      const turningOn = !settings[kind].auto;
      if (
        turningOn &&
        !(await api.confirm({
          message: `${NAMES[kind]} 자동 주문을 켜시겠습니까?`,
          detail: '조건이 충족되면 사이트의 주문 버튼이 자동으로 클릭되어 실제 주문이 전송됩니다.',
          ok: '자동 주문 켜기',
        }))
      ) {
        return;
      }
      void save({ [kind]: { ...settings[kind], auto: turningOn } });
    });
  }
  $<HTMLButtonElement>('#reentry').addEventListener('click', () => void save({ reentry: !settings.reentry }));
  $<HTMLInputElement>('#site-url').addEventListener('change', (e) => {
    void save({ siteUrl: (e.target as HTMLInputElement).value.trim() });
  });
  $<HTMLInputElement>('#close-delay').addEventListener('change', (e) => {
    void save({ closeDelay: Number((e.target as HTMLInputElement).value) });
  });
  $<HTMLButtonElement>('#start').addEventListener('click', (e) => {
    const running = (e.currentTarget as HTMLElement).classList.contains('stop');
    void api.control(running ? 'stop' : 'start');
  });
  $<HTMLButtonElement>('#reset').addEventListener('click', async () => {
    const ok = await api.confirm({
      message: '모든 설정을 초기화하시겠습니까?',
      detail: '시간, 틱, 자동 주문, 자동 재진입이 기본값으로 돌아갑니다.',
      ok: '초기화',
    });
    if (ok) renderSettings(await api.control('resetSettings'));
  });
  $<HTMLButtonElement>('#reload').addEventListener('click', () => void api.control('reloadSite'));
}

function fmt(n: number | null, digits = 2): string {
  return n === null ? '-' : n.toFixed(digits);
}

// --- Tick gauge: where the 1-second move is relative to the thresholds ---

function renderGauge(s: PanelState): void {
  const set = settings;
  const side = s.site.side !== 'flat' ? s.site.side : s.signalSide;
  const inPosition = side !== 'flat';
  const range = Math.max(10, Math.ceil(Math.max(set.buy.ticks, set.sell.ticks) * 1.5));
  const pos = (v: number) => 50 + (Math.max(-range, Math.min(range, v)) / range) * 50;

  $('#gauge-min').textContent = String(-range);
  $('#gauge-max').textContent = `+${range}`;

  const buy = $('#gauge-buy');
  const sell = $('#gauge-sell');
  const close = $('#gauge-close');
  buy.hidden = inPosition;
  sell.hidden = inPosition;
  // Close is measured from the high/low, not on the 1-second scale; its progress is in the 청산 row.
  close.hidden = true;
  buy.style.left = `${pos(set.buy.ticks)}%`;
  sell.style.left = `${pos(-set.sell.ticks)}%`;

  const t = s.ticks ?? 0;
  const at = pos(t);
  const fill = $('#gauge-fill');
  fill.style.left = `${Math.min(50, at)}%`;
  fill.style.width = `${Math.abs(at - 50)}%`;
  fill.className = `gauge-fill${t > 0 ? ' up' : t < 0 ? ' down' : ''}`;
  $('#gauge-dot').style.left = `${at}%`;
}

/** Close row: move back against the limit, the running delay, and the fixed entry level. */
function closeTimer(s: PanelState): string {
  const c = s.close;
  if (!c) return '';
  const delay = settings.closeDelay;
  const running = c.delayMs !== null && delay > 0 ? ` · ${(c.delayMs / 1000).toFixed(1)} / ${delay}초` : '';
  return `${c.moveTicks} / ${settings.close.ticks}틱${running}`;
}

function renderState(s: PanelState): void {
  $('#armed').hidden = !s.armed;
  $('#status-dot').classList.toggle('on', s.running);
  $('#status-dot').classList.toggle('paused', s.paused);
  const holding = s.signalSide !== 'flat' ? ` · 신호 ${SIDE_TEXT[s.signalSide]}, 청산 대기` : '';
  $('#status-text').textContent = s.running
    ? `실행 중${s.pending ? ' · 주문 확인 중' : holding}`
    : s.paused
      ? '일시정지 · 가격이 움직이면 자동 재개'
      : '정지';
  const start = $<HTMLButtonElement>('#start');
  start.classList.toggle('stop', s.running);
  start.textContent = s.running ? '정지' : s.paused ? '재개' : '시작';

  const list = $('#warnings');
  const key = s.warnings.join();
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.replaceChildren(
      ...s.warnings.map((code) => {
        const li = document.createElement('li');
        li.textContent = WARNING_TEXT[code].text;
        if (WARNING_TEXT[code].danger) li.className = 'danger';
        return li;
      }),
    );
  }

  const digits = s.tickSize ? Math.max(0, -Math.floor(Math.log10(s.tickSize))) : 2;
  $('#item').textContent = s.site.item ?? '-';
  $('#price').textContent = fmt(s.price, digits);
  const ticks = $('#ticks');
  ticks.textContent = s.ticks === null ? '-' : signed(s.ticks);
  ticks.className = 'val mono' + (s.ticks && s.ticks > 0 ? ' up' : s.ticks && s.ticks < 0 ? ' down' : '');
  $('#tick-size').textContent = s.tickSize === null ? '-' : String(s.tickSize);
  $('#position').textContent = `${SIDE_TEXT[s.site.side]}${s.site.qty ? ` ${s.site.qty}계약` : ''}`;

  const orderable = $('#orderable');
  const { canBuy, canSell } = s.site;
  orderable.textContent = canBuy === null && canSell === null ? '-' : `매수 ${canBuy ?? '-'} · 매도 ${canSell ?? '-'}`;
  orderable.classList.toggle('bad', canBuy === 0 && canSell === 0);

  for (const kind of KINDS) {
    const el = ruleEl(kind);
    const p = s.progress[kind];
    const sec = settings[kind].seconds;
    $<HTMLElement>('.progress i', el).style.width = `${Math.round(p * 100)}%`;
    const timer =
      kind === 'close'
        ? closeTimer(s)
        : p > 0 && sec > 0
          ? `${(p * sec).toFixed(1)} / ${sec}초`
          : '';
    $('.timer', el).textContent = timer;
    $('.count', el).textContent = String(s.counts[kind]);
  }

  renderGauge(s);
  lastState = s;
  renderSignalBox();
}

// --- Sounds and the blinking arrow ---

let audio: AudioContext | null = null;
let signalTimer: number | undefined;
const TONE: Record<ActionKind, number> = { buy: 1046, sell: 523, close: 784 };

function beeps(freq: number, interval: number, length: number): void {
  audio ??= new AudioContext();
  const start = audio.currentTime;
  for (let t = 0; t < SIGNAL_MS / 1000; t += interval) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + t);
    gain.gain.exponentialRampToValueAtTime(0.25, start + t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + t + length);
    osc.connect(gain).connect(audio.destination);
    osc.start(start + t);
    osc.stop(start + t + length + 0.02);
  }
}

/** The blinking signal of the last 5 seconds; after it the box shows the held position. */
let flash: { kind: ActionKind | 'alarm'; text: string; until: number } | null = null;
let lastState: PanelState | null = null;

function setBox(cls: string, text: string): void {
  const box = $('#signal');
  if (box.className !== cls) box.className = cls;
  const label = $('#signal-text');
  if (label.textContent !== text) label.textContent = text;
}

/**
 * Buy or Sell stays on screen until Close, so the box always tells what the program holds.
 * Close blinks for 5 seconds, then the box goes back to waiting.
 */
function renderSignalBox(): void {
  if (flash && Date.now() < flash.until) {
    setBox(`signal ${flash.kind === 'alarm' ? 'sell' : flash.kind} blink`, flash.text);
    return;
  }
  flash = null;
  const s = lastState;
  const side = !s ? 'flat' : s.site.side !== 'flat' ? s.site.side : s.signalSide;
  if (side === 'flat') {
    setBox('signal idle', '신호 대기');
    return;
  }
  const kind = side === 'long' ? 'buy' : 'sell';
  const w = s?.close;
  const watch = w
    ? ` ${w.entryPrice} · ${side === 'long' ? '하락' : '상승'} ${w.moveTicks} / ${settings.close.ticks}틱`
    : '';
  setBox(`signal ${kind}`, `${NAMES[kind]}${watch}`);
}

function flashSignal(kind: ActionKind | 'alarm', text: string): void {
  flash = { kind, text, until: Date.now() + SIGNAL_MS };
  renderSignalBox();
  window.clearTimeout(signalTimer);
  signalTimer = window.setTimeout(renderSignalBox, SIGNAL_MS);
}

function showSignal(e: SignalEvent): void {
  flashSignal(e.kind, `${NAMES[e.kind]} ${e.auto ? '주문' : '신호'} · ${signed(e.ticks)}틱`);
  beeps(TONE[e.kind], 0.5, 0.25);
}

function showAlarm(): void {
  flashSignal('alarm', '가격 데이터 멈춤');
  beeps(440, 0.25, 0.2);
}

// --- Log ---

function addLog(e: LogEntry): void {
  const list = $('#log');
  const li = document.createElement('li');
  li.className = `lvl-${e.level}`;
  li.textContent = `${new Date(e.ts).toTimeString().slice(0, 8)}  ${e.text}`;
  li.title = li.textContent;
  list.prepend(li);
  while (list.children.length > 300) list.lastElementChild?.remove();
}

async function init(): Promise<void> {
  bindControls();
  renderSettings(await api.getSettings());
  for (const e of await api.getLogs()) addLog(e);
  api.onState(renderState);
  api.onSignal(showSignal);
  api.onAlarm(showAlarm);
  api.onLog(addLog);
}

void init();
