import { clearSetting, getSetting, setSetting } from './db/settings'
import { recordSession } from './db/sessions'
import type { TimerSnapshot } from '../shared/timer'
import type { PaceConfig, TimerEngine } from './timer'

/**
 * Timers that were closed while a session was still going.
 *
 * Hourglass does this, and it is the behaviour the user expects: closing a
 * running timer's window, or quitting the app, does not throw the timer away.
 * It goes into a list of saved timers (Hourglass keeps ten, in its right-click
 * and tray menus) and can be opened again where it left off.
 *
 * Until 2026-11-06 this app did the opposite: closing a timer window or
 * quitting disposed the engine without recording anything, so a session that
 * was paused and closed - the user's stated habit - was simply gone.
 *
 * Here the session is **recorded first** and the list is a convenience on top.
 * Closing pauses the timer (time spent closed is not work), writes the row,
 * and adds an entry pointing at that row. Reopening restores the timer paused
 * and keeps updating the same row, so a session closed and reopened three
 * times is still one session, with the closed stretches recorded as pauses.
 * Clearing the list, or an entry falling off the end of it, never touches the
 * recorded row - it only gives up the ability to carry on with it.
 *
 * Stored as JSON in `app_settings` because it must survive a restart: a
 * timer saved by quitting is exactly one the user will look for after the
 * next launch.
 */

export const MAX_SAVED = 10
const KEY = 'timers.saved'

export interface SavedTimer {
  /** The sessions row this timer has been recorded to. Reopening keeps updating it. */
  sessionId: number
  /** Paused, with the pause that began when it was closed still open. */
  snapshot: TimerSnapshot
  pace: PaceConfig | null
  savedAt: number
}

function isSaved(value: unknown): value is SavedTimer {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<SavedTimer>
  return (
    typeof v.sessionId === 'number' &&
    typeof v.savedAt === 'number' &&
    typeof v.snapshot === 'object' &&
    v.snapshot !== null &&
    typeof v.snapshot.plannedMs === 'number' &&
    typeof v.snapshot.bankedRunningMs === 'number' &&
    Array.isArray(v.snapshot.pauses)
  )
}

/**
 * Newest first. A damaged value reads as an empty list rather than an error:
 * the sessions themselves are already recorded, so losing the list costs only
 * the shortcut back to them, and it must never stop a timer window opening.
 */
export function listSaved(): SavedTimer[] {
  const raw = getSetting(KEY)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isSaved) : []
  } catch {
    return []
  }
}

function write(list: SavedTimer[]): void {
  if (list.length === 0) clearSetting(KEY)
  else setSetting(KEY, JSON.stringify(list.slice(0, MAX_SAVED)))
}

/** Adds or refreshes the entry for a session, at the top of the list. */
export function addSaved(entry: SavedTimer): void {
  write([entry, ...listSaved().filter((s) => s.sessionId !== entry.sessionId)])
}

/** Removes and returns an entry, for reopening it. */
export function takeSaved(sessionId: number): SavedTimer | null {
  const list = listSaved()
  const found = list.find((s) => s.sessionId === sessionId) ?? null
  if (found) write(list.filter((s) => s.sessionId !== sessionId))
  return found
}

export function clearSaved(): void {
  write([])
}

/**
 * Records a timer that is being closed mid-session and keeps it in the list.
 * Returns the row it was recorded to, or null when there was nothing to keep
 * (idle, already finished, or under a second of running time).
 *
 * Paused first, because the time a timer spends closed is not work; the pause
 * this opens is closed again if the timer is reopened, so the gap is recorded
 * rather than counted. `existingId` is the row the session was already written
 * to - by a lap of a loop, or by an earlier close - so it is updated, not
 * duplicated.
 */
export function saveRunning(engine: TimerEngine, existingId: number | null): number | null {
  const status = engine.snapshot().status
  if (status !== 'running' && status !== 'paused') return null
  if (status === 'running') engine.pause()
  const snapshot = engine.snapshot()
  const id = recordSession(snapshot, engine.paceConfig(), existingId)
  if (id === null) return null
  addSaved({ sessionId: id, snapshot, pace: engine.paceConfig(), savedAt: Date.now() })
  return id
}

/**
 * Puts a saved timer back into an engine, paused where it was left. The
 * caller keeps the returned row id, so recording carries on into that row.
 */
export function reopenSaved(engine: TimerEngine, sessionId: number): number | null {
  const saved = takeSaved(sessionId)
  if (!saved) return null
  engine.restore(saved.snapshot)
  // After restore, so the lap count the pace starts from is the restored one.
  if (saved.pace) engine.setPace(saved.pace)
  return saved.sessionId
}
