import { app, shell, BrowserWindow, ipcMain, powerMonitor, globalShortcut, dialog } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { TimerEngine } from './timer'
import { closeDatabase, openDatabase } from './db'
import { recentSessions, recordSession } from './db/sessions'
import { importRows, importedSessionCount } from './db/import'
import { readImportRows, summarize } from './import/csv'
import type { TimerSnapshot } from '../shared/timer'

/** Global shortcut for pause/resume. Writing full-screen, the mouse breaks flow. */
const PAUSE_ACCELERATOR = 'CommandOrControl+Shift+Space'

/**
 * Opens at its smallest usable footprint. The comparison against Hourglass made
 * the point: a timer that eats a quarter of the screen will not get used.
 *
 * The ring needs more room than the bar for the same legibility, since a circle
 * is bounded by the shorter dimension while a bar is not. Each variant
 * therefore carries its own minimum.
 */
const BAR_MIN = { width: 250, height: 150 }
const RING_MIN = { width: 250, height: 220 }

let currentMin = BAR_MIN

const timer = new TimerEngine()
let compactWindow: BrowserWindow | null = null
let dashboardWindow: BrowserWindow | null = null

function broadcast(channel: string, payload: unknown): void {
  if (compactWindow && !compactWindow.isDestroyed()) {
    compactWindow.webContents.send(channel, payload)
  }
}

function createCompactWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...BAR_MIN,
    minWidth: BAR_MIN.width,
    minHeight: BAR_MIN.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
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
  window.on('enter-full-screen', () => broadcast('window:fullscreen', true))
  window.on('leave-full-screen', () => broadcast('window:fullscreen', false))

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

/**
 * Settings, data and analytics live in a normal window rather than inside the
 * timer. The timer is a widget that has to stay small and stay out of the way;
 * anything with tabs in it does not belong there.
 */
function openDashboard(): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.focus()
    return
  }

  dashboardWindow = new BrowserWindow({
    width: 940,
    height: 660,
    minWidth: 620,
    minHeight: 440,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#14161a',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  dashboardWindow.on('ready-to-show', () => dashboardWindow?.show())
  dashboardWindow.on('closed', () => {
    dashboardWindow = null
  })

  // Same renderer bundle, routed by hash - one build, one set of styles.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void dashboardWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/dashboard`)
  } else {
    void dashboardWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/dashboard' })
  }
}

function registerIpc(): void {
  ipcMain.handle('timer:get', () => timer.snapshot())
  ipcMain.handle('timer:start', (_event, plannedMs: number) => timer.start(plannedMs))
  ipcMain.handle('timer:pause', () => timer.pause())
  ipcMain.handle('timer:resume', () => timer.resume())
  ipcMain.handle('timer:setTask', (_event, task: string) => timer.setTask(task))
  ipcMain.handle('timer:stop', () => {
    const finished = timer.stop()
    recordSession(finished)
    return finished
  })
  ipcMain.handle('sessions:recent', (_event, limit?: number) => recentSessions(limit))

  ipcMain.handle('window:isFullScreen', () => compactWindow?.isFullScreen() ?? false)
  ipcMain.handle('window:setFullScreen', (_event, value: boolean) => {
    compactWindow?.setFullScreen(value)
    return value
  })
  /**
   * Each dial has its own minimum. A window sitting at the old minimum follows
   * the new one - which is what makes ring shrink back down on the way to bar -
   * while a size the user chose deliberately is left alone unless it is now
   * too small.
   */
  ipcMain.handle('window:setVariant', (_event, variant: 'ring' | 'bar') => {
    if (!compactWindow || compactWindow.isFullScreen()) return
    const next = variant === 'ring' ? RING_MIN : BAR_MIN
    const [width, height] = compactWindow.getSize()
    const wasAtMinimum = width <= currentMin.width + 2 && height <= currentMin.height + 2
    compactWindow.setMinimumSize(next.width, next.height)
    if (wasAtMinimum) {
      compactWindow.setSize(next.width, next.height)
    } else if (width < next.width || height < next.height) {
      compactWindow.setSize(Math.max(width, next.width), Math.max(height, next.height))
    }
    currentMin = next
  })
  ipcMain.handle('import:pickFile', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose the spreadsheet export',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('import:preview', (_event, filePath: string) =>
    summarize(readFileSync(filePath, 'utf8'))
  )
  ipcMain.handle('import:commit', (_event, filePath: string) => {
    const { rows } = readImportRows(readFileSync(filePath, 'utf8'))
    return importRows(rows)
  })
  ipcMain.handle('import:existingCount', () => importedSessionCount())

  ipcMain.handle('window:openDashboard', () => openDashboard())
  ipcMain.handle('window:minimize', () => compactWindow?.minimize())
  ipcMain.handle('window:close', () => compactWindow?.close())

  ipcMain.handle('timer:getLoop', () => timer.isLooping())
  ipcMain.handle('timer:setLoop', (_event, value: boolean) => timer.setLoop(value))

  timer.on('update', (snapshot: TimerSnapshot) => broadcast('timer:update', snapshot))

  // A run that reaches zero is recorded exactly like one stopped by hand.
  timer.on('completed', (snapshot: TimerSnapshot) => recordSession(snapshot))

  timer.on('expired', (snapshot: TimerSnapshot) => {
    broadcast('timer:expired', snapshot)
    // Flashes the taskbar button, which is the only cue that lands when the
    // window is behind a full-screen document.
    if (compactWindow && !compactWindow.isDestroyed() && !compactWindow.isFocused()) {
      compactWindow.flashFrame(true)
    }
  })
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

  openDatabase()
  registerIpc()
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
  closeDatabase()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
