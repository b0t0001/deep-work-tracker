import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  globalShortcut,
  dialog,
  Tray,
  Menu,
  nativeImage,
  type IpcMainInvokeEvent
} from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { TimerEngine, type PaceConfig, type PaceEvent } from './timer'
import { closeDatabase, openDatabase } from './db'
import { deleteSession, recentSessions, recordSession, setStopReason } from './db/sessions'
import { importRows, importedSessionCount } from './db/import'
import { createSession, historyState, redo, removeSession, undo, updateSession } from './db/history'
import type { SessionPatch } from './db/sessions'
import { readImportRows, summarize } from './import/csv'
import { formatClock, remainingMs, type TimerSnapshot } from '../shared/timer'

/** Actions a global shortcut can drive, and what they start out bound to. */
export type ShortcutAction = 'pause' | 'stop' | 'newTimer'

const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  pause: 'CommandOrControl+Shift+Space',
  stop: '',
  newTimer: ''
}

/**
 * Opens at its smallest usable footprint, matching the size Hourglass is
 * actually run at. Everything scales with the window, so the user resizes up
 * when they want a bigger dial.
 */
const BAR_MIN = { width: 250, height: 136 }
const RING_MIN = { width: 250, height: 220 }

/**
 * One timer per window.
 *
 * The user ran two Hourglass windows side by side, and a second window is still
 * the natural way to time two things at once. Each carries its own engine and
 * its own last-completed run, so an undo in one window cannot reach into
 * another's session.
 */
interface TimerInstance {
  window: BrowserWindow
  engine: TimerEngine
  lastCompleted: { id: number; snapshot: TimerSnapshot } | null
  minimum: { width: number; height: number }
  /**
   * The pace loop's own window: a small circle beside the timer it belongs to.
   * It is a view onto the parent's engine, not a second clock - it holds no
   * state and records nothing.
   */
  paceWindow: BrowserWindow | null
  /**
   * The pace the last completed run was carrying, kept so undo can bring it
   * back. Undo restores timing exactly; the pace it was run against is part of
   * that, not a setting to be typed again.
   */
  lastPace: PaceConfig | null
}

/** Small, circular, and deliberately almost empty. */
const PACE_SIZE = 132

const instances = new Map<number, TimerInstance>()
/** Pace windows resolve back to the timer they belong to. */
const paceWindows = new Map<number, TimerInstance>()
let dashboardWindow: BrowserWindow | null = null
let tray: Tray | null = null

/**
 * Settings that belong to the app rather than to one timer. The dashboard is a
 * single window, so a change there applies to every open timer and is inherited
 * by any opened afterwards.
 */
const settings = {
  loop: true,
  autoEndMinutes: 180,
  shortcuts: { ...DEFAULT_SHORTCUTS }
}

function instanceFor(event: IpcMainInvokeEvent): TimerInstance | undefined {
  const window = BrowserWindow.fromWebContents(event.sender)
  return window ? instances.get(window.id) : undefined
}

/** The timer a global shortcut should act on: focused first, else the only one. */
function activeInstance(): TimerInstance | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && instances.has(focused.id)) return instances.get(focused.id)
  return instances.values().next().value
}

function send(instance: TimerInstance, channel: string, payload: unknown): void {
  if (!instance.window.isDestroyed()) instance.window.webContents.send(channel, payload)
}

/**
 * Ends the pace loop with the session.
 *
 * Distinct from the user closing the pace window: that means "remove this", and
 * clears what was typed. This means "the session it belonged to is over", so
 * the values stay in the panel and re-arming is one click.
 */
function endPace(instance: TimerInstance): void {
  const config = instance.engine.paceConfig()
  if (!config) return
  instance.lastPace = config
  instance.engine.setPace(null)
  syncPaceWindow(instance)
  send(instance, 'pace:ended', null)
}

function sendToPace(instance: TimerInstance, channel: string, payload: unknown): void {
  const target = instance.paceWindow
  if (target && !target.isDestroyed()) target.webContents.send(channel, payload)
}

/**
 * Opens or closes the pace window to match the configuration.
 *
 * The window exists exactly when a pace loop does, so there is no separate
 * on/off to keep in step with the settings - clearing the interval closes it.
 */
function syncPaceWindow(instance: TimerInstance): void {
  const config = instance.engine.paceConfig()

  if (!config) {
    if (instance.paceWindow && !instance.paceWindow.isDestroyed()) instance.paceWindow.close()
    return
  }
  if (instance.paceWindow && !instance.paceWindow.isDestroyed()) {
    sendToPace(instance, 'pace:config', config)
    return
  }

  // Opens beside its parent, so the pair reads as one thing.
  const [px, py] = instance.window.getPosition()
  const [pw] = instance.window.getSize()

  const paceWindow = new BrowserWindow({
    width: PACE_SIZE,
    height: PACE_SIZE,
    x: px + pw + 8,
    y: py,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  paceWindow.setAlwaysOnTop(true, 'screen-saver')
  instance.paceWindow = paceWindow
  paceWindows.set(paceWindow.id, instance)

  paceWindow.on('ready-to-show', () => {
    // Shown without being activated: it opens while the user is still typing
    // the interval, and taking focus would pull the caret out of the field.
    paceWindow.showInactive()
    sendToPace(instance, 'pace:config', config)
    sendToPace(instance, 'timer:update', instance.engine.snapshot())
  })
  paceWindow.on('closed', () => {
    paceWindows.delete(paceWindow.id)
    if (instance.paceWindow === paceWindow) instance.paceWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void paceWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/pace`)
  } else {
    void paceWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/pace' })
  }
}

function createTimerWindow(): BrowserWindow {
  // New windows cascade rather than stack, so a second timer is visible as soon
  // as it opens instead of hiding exactly behind the first.
  const offset = instances.size * 28

  const window = new BrowserWindow({
    ...BAR_MIN,
    minWidth: BAR_MIN.width,
    minHeight: BAR_MIN.height,
    ...(instances.size > 0 ? { x: undefined, y: undefined } : {}),
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

  // 'screen-saver' keeps the timer above full-screen apps, which is the point:
  // essays get written full-screen.
  window.setAlwaysOnTop(true, 'screen-saver')

  const engine = new TimerEngine()
  engine.setLoop(settings.loop)
  engine.setAutoEndMinutes(settings.autoEndMinutes)

  const instance: TimerInstance = {
    window,
    engine,
    lastCompleted: null,
    minimum: BAR_MIN,
    paceWindow: null,
    lastPace: null
  }
  instances.set(window.id, instance)

  engine.on('update', (snapshot: TimerSnapshot) => {
    send(instance, 'timer:update', snapshot)
    sendToPace(instance, 'timer:update', snapshot)
    // A pace belongs to the session it was set for, so it ends with it. Looping
    // does not pass through idle - expiry starts the next run directly - so a
    // repeating session keeps its pace across laps.
    if (snapshot.status === 'idle' || snapshot.status === 'expired') endPace(instance)
    updateTray()
  })

  // Every finished run arrives here - stopped by hand, expired, or auto-ended -
  // so there is one place a session is recorded and no path can miss it.
  engine.on('completed', (snapshot: TimerSnapshot) => {
    const id = recordSession(snapshot, engine.paceConfig())
    instance.lastCompleted = id === null ? null : { id, snapshot }
    send(instance, 'timer:completed', null)
  })

  // The pace window owns its own cue and flash: it is the thing that fires, so
  // cueing from the main window as well would double every tick.
  engine.on('pace', (event: PaceEvent) => sendToPace(instance, 'timer:pace', event))
  engine.on('autoEnded', () => send(instance, 'timer:autoEnded', null))

  engine.on('expired', (snapshot: TimerSnapshot) => {
    send(instance, 'timer:expired', snapshot)
    // Flashing the taskbar button is the only cue that lands when the window is
    // behind a full-screen document.
    if (!window.isDestroyed() && !window.isFocused()) window.flashFrame(true)
  })

  window.on('ready-to-show', () => {
    if (offset > 0) {
      const [x, y] = window.getPosition()
      window.setPosition(x + offset, y + offset)
    }
    window.show()
  })
  window.on('enter-full-screen', () => send(instance, 'window:fullscreen', true))
  window.on('leave-full-screen', () => send(instance, 'window:fullscreen', false))
  window.on('closed', () => {
    engine.dispose()
    // The pace window belongs to this timer and has no meaning without it.
    if (instance.paceWindow && !instance.paceWindow.isDestroyed()) {
      instance.paceWindow.destroy()
    }
    instances.delete(window.id)
    updateTray()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/**
 * Settings, data and analytics live in a normal window. The timer is a widget
 * that has to stay small and out of the way; anything with tabs in it does not
 * belong there.
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

/** The tray is the only surface left when every window is minimised. */
function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'New timer', click: () => createTimerWindow() },
      { label: 'Show timers', click: () => instances.forEach((i) => i.window.show()) },
      { label: 'Settings and data', click: () => openDashboard() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  tray.on('click', () => {
    const anyHidden = [...instances.values()].some((i) => !i.window.isVisible())
    instances.forEach((i) => (anyHidden ? i.window.show() : i.window.hide()))
  })
  updateTray()
}

function updateTray(): void {
  if (!tray) return
  const running = [...instances.values()]
    .map((i) => i.engine.snapshot())
    .filter((s) => s.status !== 'idle')
  const label =
    running.length === 0
      ? 'Deep Work Tracker'
      : running.map((s) => `${formatClock(remainingMs(s, Date.now()))} ${s.status}`).join('  |  ')
  tray.setToolTip(label)
}

function registerIpc(): void {
  // Every timer call resolves the instance from the window that sent it, so two
  // open timers never touch each other's clock.
  ipcMain.handle('timer:get', (event) => instanceFor(event)?.engine.snapshot() ?? null)
  ipcMain.handle('timer:start', (event, plannedMs: number) =>
    instanceFor(event)?.engine.start(plannedMs)
  )
  ipcMain.handle('timer:pause', (event) => instanceFor(event)?.engine.pause())
  ipcMain.handle('timer:resume', (event) => instanceFor(event)?.engine.resume())
  ipcMain.handle('timer:stop', (event) => instanceFor(event)?.engine.stop())
  ipcMain.handle('timer:setTask', (event, task: string) => instanceFor(event)?.engine.setTask(task))

  ipcMain.handle('sessions:setStopReason', (event, reason: string | null, note: string | null) => {
    const completed = instanceFor(event)?.lastCompleted
    if (completed) setStopReason(completed.id, reason, note)
  })

  ipcMain.handle('timer:undoStop', (event) => {
    const instance = instanceFor(event)
    if (!instance?.lastCompleted) return null
    deleteSession(instance.lastCompleted.id)
    const restored = instance.engine.restore(instance.lastCompleted.snapshot)
    instance.lastCompleted = null

    // The pace comes back with it. Lap position needs no restoring: it is
    // derived from running time, which the snapshot already carries.
    if (instance.lastPace) {
      instance.engine.setPace(instance.lastPace)
      instance.lastPace = null
      syncPaceWindow(instance)
    }
    return restored
  })

  // Settings belong to the app, so a change reaches every open timer.
  ipcMain.handle('timer:getLoop', () => settings.loop)
  ipcMain.handle('timer:setLoop', (_event, value: boolean) => {
    settings.loop = value
    instances.forEach((i) => i.engine.setLoop(value))
  })
  // Pace belongs to one timer, not to the app: a writing sprint and a problem
  // set running side by side keep different rates.
  ipcMain.handle('timer:getPace', (event) => instanceFor(event)?.engine.paceConfig() ?? null)
  ipcMain.handle('timer:setPace', (event, config: PaceConfig | null) => {
    const instance = instanceFor(event)
    if (!instance) return
    instance.engine.setPace(config)
    syncPaceWindow(instance)
  })

  // The pace window reads its parent's clock; it owns nothing of its own.
  ipcMain.handle('pace:state', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const instance = window ? paceWindows.get(window.id) : undefined
    if (!instance) return null
    return { snapshot: instance.engine.snapshot(), config: instance.engine.paceConfig() }
  })
  /**
   * Closing the pace window means different things depending on the session.
   *
   * Mid-session it is dismissing a window, not abandoning the pace - the run is
   * still being paced against it - so the values stay and reopening restores
   * the same loop. Its position needs nothing kept: lap and remaining both
   * derive from running time, so re-arming lands exactly where it left off.
   *
   * With no session running there is nothing to come back to, so closing means
   * remove it, and the fields clear.
   */
  ipcMain.handle('pace:close', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const instance = window ? paceWindows.get(window.id) : undefined
    if (!instance) return

    const config = instance.engine.paceConfig()
    const { status } = instance.engine.snapshot()
    const midSession = status === 'running' || status === 'paused'

    instance.engine.setPace(null)
    syncPaceWindow(instance)

    if (midSession && config) {
      instance.lastPace = config
      send(instance, 'pace:ended', null)
    } else {
      send(instance, 'pace:cleared', null)
    }
  })
  ipcMain.handle('timer:getAutoEnd', () => settings.autoEndMinutes)
  ipcMain.handle('timer:setAutoEnd', (_event, minutes: number) => {
    settings.autoEndMinutes = minutes
    instances.forEach((i) => i.engine.setAutoEndMinutes(minutes))
  })

  ipcMain.handle('sessions:recent', (_event, limit?: number) => recentSessions(limit))

  // Edits from the Data tab go through the history module rather than the
  // repository, so every one of them is undoable by construction.
  ipcMain.handle('sessions:create', (_event, patch: SessionPatch) =>
    createSession(patch, 'add session')
  )
  ipcMain.handle('sessions:update', (_event, id: number, patch: SessionPatch) =>
    updateSession(id, patch, 'edit session')
  )
  ipcMain.handle('sessions:remove', (_event, id: number) => removeSession(id, 'delete session'))
  ipcMain.handle('history:state', () => historyState())
  ipcMain.handle('history:undo', () => undo())
  ipcMain.handle('history:redo', () => redo())

  ipcMain.handle('shortcuts:get', () => settings.shortcuts)
  ipcMain.handle('shortcuts:set', (_event, next: Record<ShortcutAction, string>) => {
    settings.shortcuts = { ...settings.shortcuts, ...next }
    return registerShortcuts()
  })

  ipcMain.handle('window:newTimer', () => {
    createTimerWindow()
  })
  ipcMain.handle('window:openDashboard', () => openDashboard())
  ipcMain.handle(
    'window:isFullScreen',
    (event) => instanceFor(event)?.window.isFullScreen() ?? false
  )
  ipcMain.handle('window:setFullScreen', (event, value: boolean) => {
    instanceFor(event)?.window.setFullScreen(value)
    return value
  })
  ipcMain.handle('window:minimize', (event) => instanceFor(event)?.window.minimize())
  ipcMain.handle('window:close', (event) => instanceFor(event)?.window.close())

  /**
   * Each dial has its own minimum. A window sitting at the old minimum follows
   * the new one, which is what makes ring shrink back on the way to bar, while
   * a size chosen deliberately is left alone unless it is now too small.
   */
  ipcMain.handle('window:setVariant', (event, variant: 'ring' | 'bar') => {
    const instance = instanceFor(event)
    if (!instance || instance.window.isFullScreen()) return
    const next = variant === 'ring' ? RING_MIN : BAR_MIN
    const [width, height] = instance.window.getSize()
    const wasAtMinimum =
      width <= instance.minimum.width + 2 && height <= instance.minimum.height + 2
    instance.window.setMinimumSize(next.width, next.height)
    if (wasAtMinimum) instance.window.setSize(next.width, next.height)
    else if (width < next.width || height < next.height) {
      instance.window.setSize(Math.max(width, next.width), Math.max(height, next.height))
    }
    instance.minimum = next
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
}

function togglePause(): void {
  const instance = activeInstance()
  if (!instance) return
  const { status } = instance.engine.snapshot()
  if (status === 'running') instance.engine.pause()
  else if (status === 'paused') instance.engine.resume()
}

const SHORTCUT_ACTIONS: Record<ShortcutAction, () => void> = {
  pause: togglePause,
  stop: () => activeInstance()?.engine.stop(),
  newTimer: () => createTimerWindow()
}

/**
 * Re-registers every binding from scratch.
 *
 * Registration fails silently when another application already owns the
 * combination, so the result is reported back and shown in settings - a
 * shortcut that quietly does nothing is worse than one you know is taken.
 */
function registerShortcuts(): Record<ShortcutAction, boolean> {
  globalShortcut.unregisterAll()
  const result = {} as Record<ShortcutAction, boolean>
  for (const [action, accelerator] of Object.entries(settings.shortcuts)) {
    const key = action as ShortcutAction
    if (!accelerator) {
      result[key] = true
      continue
    }
    try {
      result[key] = globalShortcut.register(accelerator, SHORTCUT_ACTIONS[key])
    } catch {
      // Electron throws rather than returning false on a malformed accelerator.
      result[key] = false
    }
  }
  return result
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.b0t0001.deepworktracker')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  openDatabase()
  registerIpc()
  createTimerWindow()
  createTray()

  // Sleeping the machine is not working, so suspend pauses every running timer
  // rather than letting countdowns burn through a closed lid.
  powerMonitor.on('suspend', () => instances.forEach((i) => i.engine.handleSuspend()))
  powerMonitor.on('resume', () => instances.forEach((i) => i.engine.handleResume()))

  registerShortcuts()

  app.on('activate', () => {
    if (instances.size === 0) createTimerWindow()
  })
})

app.on('will-quit', () => {
  tray?.destroy()
  globalShortcut.unregisterAll()
  instances.forEach((i) => i.engine.dispose())
  closeDatabase()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
