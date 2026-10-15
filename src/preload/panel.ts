import { contextBridge, ipcRenderer } from 'electron';
import { CH, type AppSettings, type ControlCommand, type LogEntry, type PanelState, type SignalEvent } from '../shared/ipc';

const subscribe =
  <T>(channel: string) =>
  (cb: (payload: T) => void) => {
    ipcRenderer.on(channel, (_e, payload: T) => cb(payload));
  };

const api = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(CH.getSettings),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(CH.setSettings, patch),
  control: (cmd: ControlCommand): Promise<AppSettings> => ipcRenderer.invoke(CH.control, cmd),
  getLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke(CH.getLogs),
  /** Native warning dialog; resolves true only when the user picks the confirm button. */
  confirm: (opts: { message: string; detail: string; ok: string }): Promise<boolean> =>
    ipcRenderer.invoke(CH.confirm, opts),
  onState: subscribe<PanelState>(CH.panelState),
  onSignal: subscribe<SignalEvent>(CH.panelSignal),
  onLog: subscribe<LogEntry>(CH.panelLog),
  onAlarm: subscribe<null>(CH.panelAlarm),
};

export type PanelApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
