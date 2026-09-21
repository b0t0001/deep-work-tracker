import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { TimerSnapshot } from '../shared/timer'

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
    onUpdate: (handler: (snapshot: TimerSnapshot) => void): Unsubscribe =>
      subscribe('timer:update', handler),
    onExpired: (handler: (snapshot: TimerSnapshot) => void): Unsubscribe =>
      subscribe('timer:expired', handler)
  },
  sessions: {
    recent: (limit?: number): Promise<unknown[]> => ipcRenderer.invoke('sessions:recent', limit)
  },
  window: {
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullScreen'),
    setFullScreen: (value: boolean): Promise<boolean> =>
      ipcRenderer.invoke('window:setFullScreen', value),
    setVariant: (variant: 'ring' | 'bar'): Promise<void> =>
      ipcRenderer.invoke('window:setVariant', variant),
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
