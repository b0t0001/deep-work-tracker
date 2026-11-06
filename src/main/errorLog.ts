import { app, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Errors and warnings, written to a file that outlives the process.
 *
 * On 11/06/2026 the installed app started, failed partway through its own
 * startup, and kept running with no timer window and no answers for the Data
 * tab - which sat on "Loading..." while the user's 2,478 sessions were intact
 * on disk. The packaged app has no console anyone can see, so whatever went
 * wrong went nowhere, and the cause could not be found afterwards. That is
 * the gap this closes: the next failure leaves its message and its stack in
 * `userData/logs/errors.log`.
 *
 * - **Everything that already said something now says it here too.** The
 *   codebase reports failures with `console.error` (a failed read, a session
 *   that could not be recorded, Electron's own "error occurred in handler for"
 *   line when an IPC call throws). Those are mirrored to the file, so no call
 *   site had to change and none can forget to.
 * - **What used to say nothing is caught.** Uncaught exceptions and unhandled
 *   promise rejections in main, a renderer or helper process dying, and errors
 *   a window's page logs or throws - which is where an unhandled rejection in
 *   React ends up.
 * - **Synchronous appends.** A crash is exactly when an async write would
 *   still be sitting in a buffer. Errors are rare, so the cost is nothing.
 * - **Bounded.** Past 1 MB the file is renamed to `errors.1.log` and a fresh
 *   one started, so two files at most, and the newest failure is always in
 *   the one with the plain name.
 * - **Per profile.** It lives under `userData`, which the dev and preview
 *   builds point elsewhere, so a test run never writes into the installed
 *   app's log. It must therefore start *after* that choice is made.
 * - **Never the cause of a failure.** Writing the log can itself fail (disk
 *   full, folder gone); that is swallowed, because a logger that throws turns
 *   a reported problem into a crash.
 */

const MAX_BYTES = 1024 * 1024
let file: string | null = null
let writing = false

export function logDirectory(): string {
  return join(app.getPath('userData'), 'logs')
}

export function logFile(): string {
  return join(logDirectory(), 'errors.log')
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Appends one entry. Safe to call from anywhere, including while crashing. */
export function logError(
  level: 'info' | 'warn' | 'error' | 'fatal',
  where: string,
  ...parts: unknown[]
): void {
  if (file === null || writing) return
  // Guards against the write itself logging an error and recursing.
  writing = true
  try {
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) {
        renameSync(file, join(logDirectory(), 'errors.1.log'))
      }
    } catch {
      /* rotation is best-effort; appending below still records the entry */
    }
    const text = parts.map(describe).join(' ')
    appendFileSync(
      file,
      `${new Date().toISOString()}  ${level.toUpperCase().padEnd(5)}  [${where}]  ${text}\n`,
      'utf8'
    )
  } catch {
    /* a log that cannot be written must not become the failure */
  } finally {
    writing = false
  }
}

/** Opens the folder in Explorer, for the Settings link. */
export function revealLog(): void {
  void shell.openPath(logDirectory())
}

/**
 * Starts the log and wires every source into it. Call once, after `userData`
 * has been chosen and before anything that could fail.
 */
export function startErrorLog(): void {
  try {
    mkdirSync(logDirectory(), { recursive: true })
    file = logFile()
  } catch {
    file = null
    return
  }

  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      logError(level, 'main', ...args)
    }
  }

  process.on('uncaughtException', (error) => {
    logError('fatal', 'main', 'Uncaught exception:', error)
  })
  process.on('unhandledRejection', (reason) => {
    logError('error', 'main', 'Unhandled promise rejection:', reason)
  })

  app.on('render-process-gone', (_event, contents, details) => {
    logError(
      'fatal',
      'renderer',
      `A window's page stopped (${details.reason}, exit ${details.exitCode}):`,
      contents.getURL()
    )
  })
  app.on('child-process-gone', (_event, details) => {
    // A clean exit is how helper processes normally end.
    if (details.reason === 'clean-exit') return
    logError(
      'error',
      'process',
      `${details.type} process ended: ${details.reason}, exit ${details.exitCode}`
    )
  })

  // Errors a page logs or throws. Uncaught exceptions and unhandled rejections
  // in the renderer arrive here as console errors, which is the only way they
  // reach main at all.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (...args: unknown[]) => {
      // Electron 35+ passes one details object; older versions passed
      // (event, level, message, line, source). Both are read.
      const first = args[0] as {
        level?: unknown
        message?: unknown
        lineNumber?: unknown
        sourceId?: unknown
      }
      const level =
        typeof first?.level === 'string'
          ? first.level
          : args[1] === 3
            ? 'error'
            : args[1] === 2
              ? 'warning'
              : ''
      const message = typeof first?.message === 'string' ? first.message : String(args[2] ?? '')
      if (level !== 'error') return
      const source = typeof first?.sourceId === 'string' ? first.sourceId : String(args[4] ?? '')
      const line = typeof first?.lineNumber === 'number' ? first.lineNumber : args[3]
      const page = contents.getURL().split('#')[1] ?? 'timer'
      logError(
        'error',
        `page ${page || 'timer'}`,
        message,
        source ? `(${source.split('/').pop()}:${String(line)})` : ''
      )
    })
  })

  // A line per launch, so the entries between two launches read as one run.
  logError(
    'info',
    'main',
    `Started ${app.getName()} ${app.getVersion()}${app.isPackaged ? '' : ' (unpackaged)'}`
  )
}
