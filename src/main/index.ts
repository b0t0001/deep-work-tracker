import { app, shell, BrowserWindow, ipcMain, powerMonitor, globalShortcut } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { TimerEngine } from './timer'
import type { TimerSnapshot } from '../shared/timer'

/** Global shortcut for pause/resume. Writing full-screen, the mouse breaks flow. */
const PAUSE_ACCELERATOR = 'CommandOrControl+Shift+Space'

const timer = new TimerEngine()
let compactWindow: BrowserWindow | null = null

function broadcast(channel: string, payload: TimerSnapshot): void {
  if (compactWindow && !compactWindow.isDestroyed()) {
    compactWindow.webContents.send(channel, payload)
  }
}

function createCompactWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 300,
    height: 390,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 'screen-saver' keeps the timer above full-screen apps, which is the whole
  // point - the user writes essays full-screen and still needs to see the clock.
  window.setAlwaysOnTop(true, 'screen-saver')

  window.on('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerTimerIpc(): void {
  ipcMain.handle('timer:get', () => timer.snapshot())
  ipcMain.handle('timer:start', (_event, plannedMs: number) => timer.start(plannedMs))
  ipcMain.handle('timer:pause', () => timer.pause())
  ipcMain.handle('timer:resume', () => timer.resume())
  ipcMain.handle('timer:stop', () => timer.stop())

  timer.on('update', (snapshot: TimerSnapshot) => broadcast('timer:update', snapshot))
  timer.on('expired', (snapshot: TimerSnapshot) => broadcast('timer:expired', snapshot))
}

function togglePause(): void {
  const { status } = timer.snapshot()
  if (status === 'running') timer.pause()
  else if (status === 'paused') timer.resume()
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.b0t0001.deepworktracker')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerTimerIpc()
  compactWindow = createCompactWindow()

  // Sleeping the machine is not working, so suspend pauses rather than letting
  // the countdown burn through a closed lid.
  powerMonitor.on('suspend', () => timer.handleSuspend())
  powerMonitor.on('resume', () => timer.handleResume())

  if (!globalShortcut.register(PAUSE_ACCELERATOR, togglePause)) {
    console.warn(`Could not register ${PAUSE_ACCELERATOR}; another app likely owns it.`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      compactWindow = createCompactWindow()
    }
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  timer.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
