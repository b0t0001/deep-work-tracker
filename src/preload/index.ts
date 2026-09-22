import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { TimerSnapshot } from '../shared/timer'
import type { PaceConfig, PaceEvent } from '../main/timer'

type Unsubscribe = () => void

function subscribe(channel: string, handler: (snapshot: TimerSnapshot) => void): Unsubscribe {
  const listener = (_event: unknown, snapshot: TimerSnapshot): void => handler(snapshot)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * The entire surface between main and renderer. Components call this; they
 * never touch ipcRenderer directly. See CLAUDE.md -> Architecture.
 */
const api = {
  timer: {
    get: (): Promise<TimerSnapshot> => ipcRenderer.invoke('timer:get'),
    start: (plannedMs: number): Promise<TimerSnapshot> =>
      ipcRenderer.invoke('timer:start', plannedMs),
    pause: (): Promise<TimerSnapshot> => ipcRenderer.invoke('timer:pause'),
    resume: (): Promise<TimerSnapshot> => ipcRenderer.invoke('timer:resume'),
    stop: (): Promise<TimerSnapshot> => ipcRenderer.invoke('timer:stop'),
    setTask: (task: string): Promise<void> => ipcRenderer.invoke('timer:setTask', task),
    getLoop: (): Promise<boolean> => ipcRenderer.invoke('timer:getLoop'),
    getPace: (): Promise<PaceConfig | null> => ipcRenderer.invoke('timer:getPace'),
    setPace: (config: PaceConfig | null): Promise<void> =>
      ipcRenderer.invoke('timer:setPace', config),
    getAutoEnd: (): Promise<number> => ipcRenderer.invoke('timer:getAutoEnd'),
    setAutoEnd: (minutes: number): Promise<void> => ipcRenderer.invoke('timer:setAutoEnd', minutes),
    undoStop: (): Promise<TimerSnapshot | null> => ipcRenderer.invoke('timer:undoStop'),
    setStopReason: (reason: string | null, note: string | null): Promise<void> =>
      ipcRenderer.invoke('sessions:setStopReason', reason, note),
    onCompleted: (handler: () => void): Unsubscribe => {
      const listener = (): void => handler()
      ipcRenderer.on('timer:completed', listener)
      return () => ipcRenderer.removeListener('timer:completed', listener)
    },
    onPace: (handler: (event: PaceEvent) => void): Unsubscribe => {
      const listener = (_e: unknown, event: PaceEvent): void => handler(event)
      ipcRenderer.on('timer:pace', listener)
      return () => ipcRenderer.removeListener('timer:pace', listener)
    },
    setLoop: (value: boolean): Promise<void> => ipcRenderer.invoke('timer:setLoop', value),
    onUpdate: (handler: (snapshot: TimerSnapshot) => void): Unsubscribe =>
      subscribe('timer:update', handler),
    onExpired: (handler: (snapshot: TimerSnapshot) => void): Unsubscribe =>
      subscribe('timer:expired', handler)
  },
  shortcuts: {
    get: (): Promise<Record<string, string>> => ipcRenderer.invoke('shortcuts:get'),
    set: (next: Record<string, string>): Promise<Record<string, boolean>> =>
      ipcRenderer.invoke('shortcuts:set', next)
  },
  sessions: {
    recent: (limit?: number): Promise<unknown[]> => ipcRenderer.invoke('sessions:recent', limit)
  },
  importer: {
    pickFile: (): Promise<string | null> => ipcRenderer.invoke('import:pickFile'),
    preview: (filePath: string): Promise<unknown> => ipcRenderer.invoke('import:preview', filePath),
    commit: (filePath: string): Promise<unknown> => ipcRenderer.invoke('import:commit', filePath),
    existingCount: (): Promise<number> => ipcRenderer.invoke('import:existingCount')
  },
  window: {
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullScreen'),
    setFullScreen: (value: boolean): Promise<boolean> =>
      ipcRenderer.invoke('window:setFullScreen', value),
    setVariant: (variant: 'ring' | 'bar'): Promise<void> =>
      ipcRenderer.invoke('window:setVariant', variant),
    newTimer: (): Promise<void> => ipcRenderer.invoke('window:newTimer'),
    openDashboard: (): Promise<void> => ipcRenderer.invoke('window:openDashboard'),
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    onFullScreenChange: (handler: (value: boolean) => void): Unsubscribe => {
      const listener = (_event: unknown, value: boolean): void => handler(value)
      ipcRenderer.on('window:fullscreen', listener)
      return () => ipcRenderer.removeListener('window:fullscreen', listener)
    }
  }
}

export type DeepWorkApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (defined in index.d.ts)
  window.electron = electronAPI
  // @ts-ignore (defined in index.d.ts)
  window.api = api
}
