import { app, BaseWindow, dialog, globalShortcut, ipcMain, Menu, Notification, WebContentsView } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DailyCounter } from '../engine/daily-counter';
import { SignalEngine } from '../engine/engine';
import { TickWindow, toTicks } from '../engine/tick-window';
import { ACTIONS, type ActionKind, type Side } from '../engine/types';
import {
  CH,
  STALE_PRICE_MS,
  type AppSettings,
  type ControlCommand,
  type PanelState,
  type SignalEvent,
  type SiteSnapshot,
  type WarningCode,
} from '../shared/ipc';
import { ChartMarkers } from './chart-markers';
import { ActivityLog, PriceFeedLog, SettingsStore, SignalJournal } from './store';

const PANEL_WIDTH = 380;
const TICK_INTERVAL_MS = 50;
const STATE_INTERVAL_MS = 100;
const PENDING_MS = 5000;

const NAME: Record<ActionKind, string> = { buy: '매수', sell: '매도', close: '청산' };
const SIDE_NAME: Record<Side, string> = { flat: '없음', long: '매수', short: '매도' };

let win: BaseWindow;
let siteView: WebContentsView;
let panelView: WebContentsView;

// Development hooks: a separate data folder and auto-start for runs against the mock site.
if (process.env.TT_USER_DATA) app.setPath('userData', process.env.TT_USER_DATA);
const userDir = () => app.getPath('userData');

// Two running copies would send every order twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(main);
}

function createWindow(settings: AppSettings): void {
  // No File/Edit/View menu: it only offers ways to reload the site by accident.
  Menu.setApplicationMenu(null);
  win = new BaseWindow({ width: 1600, height: 960, minWidth: 1100, minHeight: 700, title: 'Tick Trader' });

  siteView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'preload-site.js'),
      // Separate session, never shared with other browsers. The site keeps its login token in
      // sessionStorage, so the user has to log in again after every restart of the app.
      partition: 'persist:site',
      contextIsolation: true,
      sandbox: true,
      // Keep the site's timers and rendering alive when the window is minimized or covered,
      // otherwise the order book stops repainting and the program sees a frozen price.
      backgroundThrottling: false,
    },
  });
  panelView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'preload-panel.js'),
      contextIsolation: true,
      sandbox: true,
      // Signal sounds must play even if nobody clicked the panel yet.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });

  win.contentView.addChildView(siteView);
  win.contentView.addChildView(panelView);

  const layout = () => {
    const { width, height } = win.getContentBounds();
    siteView.setBounds({ x: 0, y: 0, width: width - PANEL_WIDTH, height });
    panelView.setBounds({ x: width - PANEL_WIDTH, y: 0, width: PANEL_WIDTH, height });
  };
  layout();
  win.on('resize', layout);
  win.on('focus', () => win.flashFrame(false));

  // Popups from the site (order windows, notices) open inside the app, not in a system browser.
  siteView.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));

  // TT_SITE_URL points the app at another page, e.g. test/fixtures/mock-site.html during development.
  void siteView.webContents.loadURL(process.env.TT_SITE_URL || settings.siteUrl || 'about:blank');
  void panelView.webContents.loadFile(join(__dirname, 'panel', 'index.html'));
}

function loadCounter(file: string): DailyCounter {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    return new DailyCounter(saved.date, saved.counts);
  } catch {
    return new DailyCounter();
  }
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function main(): void {
  const store = new SettingsStore(userDir());
  const counterFile = join(userDir(), 'counts.json');
  const counter = loadCounter(counterFile);
  const prices = new TickWindow();
  const engine = new SignalEngine(store.current, PENDING_MS);

  let price: number | null = null;
  let lastPriceAt: number | null = null;
  let startedAt = 0;
  let ticks: number | null = null;
  let progress: PanelState['progress'] = { buy: 0, sell: 0, close: 0 };
  let closeWatch: PanelState['close'] = null;
  let site: SiteSnapshot = {
    item: null,
    tickSize: null,
    side: 'flat',
    qty: 0,
    positionRaw: '',
    buttons: { buy: false, sell: false, close: false },
    canBuy: null,
    canSell: null,
    hasPrice: false,
  };
  let pendingSince: number | null = null;
  let pausedAt = 0;
  let instrumentLogTimer: NodeJS.Timeout | undefined;

  const alive = () => !win.isDestroyed() && !panelView.webContents.isDestroyed();
  const toPanel = (channel: string, payload: unknown) => {
    if (alive()) panelView.webContents.send(channel, payload);
  };
  const log = new ActivityLog(userDir(), (e) => toPanel(CH.panelLog, e));
  const journal = new SignalJournal(userDir());
  const feed = new PriceFeedLog(userDir());

  const armed = () => ACTIONS.some((k) => store.current[k].auto);
  const tickSize = () => store.current.tickSizeOverride ?? site.tickSize;

  /** Taskbar flash + Windows notification, only when the user is looking elsewhere. */
  const notify = (body: string) => {
    if (win.isFocused()) return;
    win.flashFrame(true);
    if (Notification.isSupported()) new Notification({ title: 'Tick Trader', body, silent: true }).show();
  };

  const start = () => {
    if (engine.isRunning) return;
    // Resuming a signal-only pause keeps the signal position; anything else starts fresh.
    const resumed = engine.isPaused && !armed();
    startedAt = Date.now();
    if (resumed) engine.resume();
    else engine.start();
    const mode = armed() ? '자동 주문 ON' : '신호만';
    log.add('info', resumed ? `재개 (${mode})` : `시작 (${mode})`);
  };
  const stop = (reason?: string) => {
    if (!engine.isRunning && !engine.isPaused) return;
    engine.stop();
    pendingSince = null;
    log.add(reason ? 'warn' : 'info', reason ? `정지: ${reason}` : '정지');
  };

  createWindow(store.current);
  log.add('info', '프로그램 시작');
  const markers = new ChartMarkers(() => (win.isDestroyed() ? null : siteView.webContents));
  if (process.env.TT_AUTOSTART === '1') start();
  if (process.env.TT_MINIMIZE === '1') setTimeout(() => win.minimize(), 2000);
  if (process.env.TT_SNAPSHOT_MS) {
    setTimeout(async () => {
      const img = await panelView.webContents.capturePage();
      writeFileSync(join(userDir(), 'panel.png'), img.toPNG());
    }, Number(process.env.TT_SNAPSHOT_MS));
  }

  // Emergency stop: F9 works even when the window is in the background, Esc inside the panel.
  globalShortcut.register('F9', () => stop('F9'));
  panelView.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') stop('Esc');
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  ipcMain.on(CH.sitePrice, (_e, msg: { ts: number; price: number }) => {
    price = msg.price;
    lastPriceAt = msg.ts;
    prices.push(msg.ts, msg.price);
    engine.notePrice(msg.ts, msg.price);
    feed.add(msg.ts, site.item, msg.price);
  });

  ipcMain.on(CH.siteSnapshot, (_e, snap: SiteSnapshot) => {
    // After switching instruments the site updates the item code before the tick size table,
    // so treat either change as a new instrument: old prices with a wrong tick size would
    // produce inflated tick counts and false signals.
    if (snap.item !== site.item || snap.tickSize !== site.tickSize) {
      prices.clear();
      engine.resetTimers();
      // Log once the pair has settled, so the half-updated state never shows up in the log.
      clearTimeout(instrumentLogTimer);
      instrumentLogTimer = setTimeout(() => {
        if (site.item && site.tickSize) log.add('info', `종목: ${site.item}, 틱 사이즈 ${site.tickSize}`);
      }, 600);
    }
    if (snap.side !== site.side) {
      log.add('info', `포지션: ${SIDE_NAME[snap.side]}${snap.qty ? ` ${snap.qty}계약` : ''}`);
      pendingSince = null;
    }
    site = snap;
  });

  ipcMain.on(CH.siteClickResult, (_e, r: { kind: ActionKind; ok: boolean }) => {
    if (!r.ok) log.add('warn', `${NAME[r.kind]} 버튼을 찾을 수 없음`);
  });

  ipcMain.handle(CH.getSettings, () => store.current);
  ipcMain.handle(CH.setSettings, (_e, patch: Partial<AppSettings>) => {
    const urlBefore = store.current.siteUrl;
    const wasArmed = armed();
    engine.settings = store.update(patch);
    if (!wasArmed && armed()) log.add('warn', '자동 주문 ON: 실제 주문이 전송됩니다');
    if (wasArmed && !armed()) log.add('info', '자동 주문 OFF: 신호만');
    if (store.current.siteUrl !== urlBefore) void siteView.webContents.loadURL(store.current.siteUrl || 'about:blank');
    return store.current;
  });
  ipcMain.handle(CH.getLogs, () => log.list());
  ipcMain.handle(CH.confirm, async (_e, opts: { message: string; detail: string; ok: string }) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Tick Trader',
      message: opts.message,
      detail: opts.detail,
      buttons: [opts.ok, '취소'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response === 0;
  });

  ipcMain.handle(CH.control, (_e, cmd: ControlCommand) => {
    switch (cmd) {
      case 'start':
        start();
        break;
      case 'stop':
        stop();
        break;
      case 'resetSettings':
        engine.settings = store.reset();
        log.add('info', '설정 초기화');
        break;
      case 'reloadSite':
        siteView.webContents.reload();
        break;
    }
    return store.current;
  });

  const warnings = (now: number): WarningCode[] => {
    const out: WarningCode[] = [];
    if (!process.env.TT_SITE_URL && !store.current.siteUrl) out.push('noSite');
    else if (!site.hasPrice) out.push('noPrice');
    else if (lastPriceAt !== null && now - lastPriceAt > STALE_PRICE_MS) out.push('stale');
    const s = store.current;
    if ((s.buy.auto && site.canBuy === 0) || (s.sell.auto && site.canSell === 0)) out.push('noMargin');
    if (ACTIONS.some((k) => s[k].auto && !site.buttons[k])) out.push('noButtons');
    return out;
  };

  const loop = setInterval(() => {
    if (win.isDestroyed()) return;
    const now = Date.now();

    // A frozen price usually means the site logged out or lost its feed. With auto orders: stop rather
    // than trade blind. Signal-only: pause and pick up again by itself once prices move.
    if (engine.isRunning && now - Math.max(lastPriceAt ?? 0, startedAt) > STALE_PRICE_MS) {
      const why = `가격이 ${STALE_PRICE_MS / 1000}초 동안 변하지 않음`;
      if (armed()) {
        stop(`${why} (로그인/연결 확인)`);
        notify('가격 데이터가 멈춰 정지했습니다');
      } else {
        engine.pause();
        pausedAt = now;
        log.add('warn', `일시정지: ${why}, 가격이 다시 움직이면 자동 재개`);
        notify('가격 데이터가 멈춰 일시정지했습니다');
      }
      toPanel(CH.panelAlarm, null);
    }
    if (engine.isPaused && lastPriceAt !== null && lastPriceAt > pausedAt) {
      if (armed()) {
        // Auto orders were switched on during the pause: never start trading without Start.
        stop('일시정지 중 자동 주문 ON, 시작 버튼으로 다시 시작');
      } else {
        engine.resume();
        startedAt = now;
        log.add('info', '가격 수신 재개: 자동 재개');
      }
    }

    const size = tickSize();
    const delta = prices.change(now);
    ticks = delta === null || !size ? null : toTicks(delta, size);

    const r = engine.update({ now, ticks, price, tickSize: size, side: site.side });
    progress = r.progress;
    closeWatch = r.close;

    if (r.fired) {
      const f = r.fired;
      counter.add(f.kind, now);
      writeFileSync(counterFile, JSON.stringify(counter.get(now)));
      const what = `${NAME[f.kind]} ${price ?? '-'} (${signed(f.ticks)}틱)`;
      const noMargin = (f.kind === 'buy' && site.canBuy === 0) || (f.kind === 'sell' && site.canSell === 0);
      const mode = f.auto ? (noMargin ? '차단' : '주문') : '신호';
      const sideText = (s: Side, virtual: boolean) => (s === 'flat' ? '없음' : `${SIDE_NAME[s]}${virtual ? '(신호)' : ''}`);
      const after = engine.signalPosition;
      const isClose = f.kind === 'close';
      const record = {
        ts: now,
        item: site.item,
        kind: NAME[f.kind],
        mode,
        price,
        priceBefore: prices.priceAt(now - 1000),
        ticks: f.ticks,
        threshold: f.threshold,
        heldSec: Math.round(f.heldMs / 100) / 10,
        minTicks: isClose ? null : f.minTicks,
        maxTicks: isClose ? null : f.maxTicks,
        windowSec: isClose ? store.current.close.seconds : null,
        refPrice: f.refPrice,
        entryPrice: f.entryPrice,
        moveTicks: f.moveTicks,
        closeReason: f.reason === 'entry' ? '진입가 이탈' : f.reason === 'move' ? '되돌림' : null,
        delaySec: f.delayMs === null ? null : Math.round(f.delayMs / 100) / 10,
        tickSize: size,
        positionBefore: sideText(f.side, f.virtual),
        // Real positions change on the site a moment later; only signal positions are known right away.
        positionAfter:
          mode === '주문' ? '사이트 확인 중' : sideText(after === 'flat' ? site.side : after, after !== 'flat'),
      };
      journal.add(record);
      const position = ` · 포지션 ${record.positionBefore} → ${record.positionAfter}`;
      let detail: string;
      if (isClose) {
        const long = f.side === 'long';
        const ref = record.windowSec
          ? `최근 ${record.windowSec}초 ${long ? '최고가' : '최저가'}`
          : `${long ? '하락' : '상승'} 시작가`;
        const move = `${long ? '하락' : '상승'} ${f.moveTicks}틱`;
        detail =
          f.reason === 'entry'
            ? ` · 진입가 이탈 즉시 청산 (진입 ${f.entryPrice ?? '-'}, ${ref} ${f.refPrice ?? '-'}, ${move}) · ` +
              `보유 ${record.heldSec}초${position}`
            : ` · ${ref} ${f.refPrice ?? '-'} (진입 ${f.entryPrice ?? '-'}) · ${move} ≥ ${f.threshold}틱` +
              `${record.delaySec ? ` · 지연 ${record.delaySec}초 유지` : ''} · 보유 ${record.heldSec}초${position}`;
      } else {
        const cmp = f.kind === 'buy' ? '≥ ' : '≤ -';
        detail =
          ` · 1초 전 ${record.priceBefore ?? '-'} · 조건 ${cmp}${f.threshold}틱 ` +
          `${record.heldSec}초 유지 (최소 ${signed(f.minTicks)} / 최대 ${signed(f.maxTicks)}틱)${position}`;
      }
      // `auto` in the event means "an order was actually sent", so the panel never shows 주문 for a blocked click.
      const event: SignalEvent = { kind: f.kind, auto: f.auto && !noMargin, ticks: f.ticks, price, ts: now };
      toPanel(CH.panelSignal, event);
      if (site.item && price !== null) {
        const up = f.kind === 'buy' || (f.kind === 'close' && f.side === 'short');
        markers.add({ item: site.item, time: Math.floor(now / 1000), price, kind: f.kind, up });
      }

      if (f.auto && noMargin) {
        log.add('warn', `${what}: 주문가능수량 0 (증거금 부족), 주문하지 않음${detail}`);
      } else if (f.auto) {
        siteView.webContents.send(CH.siteClick, f.kind);
        engine.markOrderSent(now);
        pendingSince = now;
        log.add('order', `${what} 주문 클릭${detail}`);
      } else {
        log.add('signal', `${what} 신호${detail}`);
      }
      notify(`${NAME[f.kind]} ${f.auto && !noMargin ? '주문' : '신호'} · ${price ?? '-'}`);
    }
    if (r.stopped) log.add('info', `${r.fired ? '청산 신호' : '청산 완료'}, 자동 재진입 OFF: 정지`);
    if (pendingSince !== null && now - pendingSince > PENDING_MS) {
      log.add('warn', '클릭 후 5초 내 포지션 변화 없음');
      pendingSince = null;
    }
  }, TICK_INTERVAL_MS);

  const stateLoop = setInterval(() => {
    if (!alive()) return;
    const now = Date.now();
    const state: PanelState = {
      running: engine.isRunning,
      paused: engine.isPaused,
      signalSide: engine.signalPosition,
      armed: armed(),
      price,
      ticks,
      tickSize: tickSize(),
      site,
      progress,
      close: closeWatch,
      counts: counter.get(now).counts,
      pending: pendingSince !== null,
      warnings: warnings(now),
    };
    toPanel(CH.panelState, state);
    win.setTitle(
      `Tick Trader · ${site.item ?? '-'} · ${engine.isRunning ? '실행 중' : engine.isPaused ? '일시정지' : '정지'}${armed() ? ' · AUTO' : ''}`,
    );
  }, STATE_INTERVAL_MS);

  // Closing the window ends the program: stop the loops first so nothing touches destroyed views.
  // Redraw markers the chart lost after a reload or an instrument switch.
  const markerLoop = setInterval(() => void markers.sync(), 3000);

  win.on('closed', () => {
    clearInterval(loop);
    clearInterval(stateLoop);
    clearInterval(markerLoop);
    feed.close();
    engine.stop();
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
