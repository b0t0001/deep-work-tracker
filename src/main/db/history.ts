import {
  deleteSession,
  getPauses,
  getSession,
  insertPauses,
  insertSession,
  patchSession,
  type PauseRow,
  type SessionPatch,
  type SessionRow
} from './sessions'

/**
 * Undo/redo for edits made in the Data tab.
 *
 * Operations are stored with enough information to run in either direction,
 * rather than by snapshotting the table: an insert keeps the row it added, a
 * delete keeps the row and pauses it removed, and an update keeps both the
 * values it replaced and the ones it wrote.
 */
export type Operation =
  | { kind: 'insert'; label: string; row: SessionRow; pauses: PauseRow[] }
  | { kind: 'delete'; label: string; row: SessionRow; pauses: PauseRow[] }
  | { kind: 'update'; label: string; id: number; before: SessionPatch; after: SessionPatch }

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

/** Deep enough for a sitting's worth of corrections without growing unbounded. */
const LIMIT = 50

const undoStack: Operation[] = []
const redoStack: Operation[] = []

export function historyState(): HistoryState {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack[undoStack.length - 1]?.label ?? null,
    redoLabel: redoStack[redoStack.length - 1]?.label ?? null
  }
}

function push(operation: Operation): void {
  undoStack.push(operation)
  if (undoStack.length > LIMIT) undoStack.shift()
  // A new action makes the redo branch unreachable, as in every editor. It also
  // avoids redo replaying onto rows that have since changed underneath it.
  redoStack.length = 0
}

/** Restores a row under its original id, so anything referring to it still does. */
function restore(row: SessionRow, pauses: PauseRow[]): void {
  const { id, ...rest } = row
  insertSession(rest, id)
  insertPauses(pauses)
}

export function createSession(patch: SessionPatch, label: string): number {
  const id = insertSession(patch)
  const row = getSession(id)
  if (row) push({ kind: 'insert', label, row, pauses: [] })
  return id
}

export function updateSession(id: number, patch: SessionPatch, label: string): void {
  const current = getSession(id)
  if (!current) return
  // Only the fields actually changing are kept, so undo touches nothing else.
  const before: SessionPatch = {}
  const after: SessionPatch = {}
  for (const key of Object.keys(patch) as Array<keyof SessionPatch>) {
    if (current[key] === patch[key]) continue
    // @ts-expect-error indexed assignment across a heterogeneous patch
    before[key] = current[key]
    // @ts-expect-error indexed assignment across a heterogeneous patch
    after[key] = patch[key]
  }
  if (Object.keys(after).length === 0) return
  patchSession(id, after)
  push({ kind: 'update', label, id, before, after })
}

export function removeSession(id: number, label: string): void {
  const row = getSession(id)
  if (!row) return
  // Pauses cascade on delete, so they are captured first or undo would restore
  // a session whose running time could no longer be checked.
  const pauses = getPauses(id)
  deleteSession(id)
  push({ kind: 'delete', label, row, pauses })
}

export function undo(): HistoryState {
  const operation = undoStack.pop()
  if (!operation) return historyState()

  if (operation.kind === 'insert') deleteSession(operation.row.id)
  else if (operation.kind === 'delete') restore(operation.row, operation.pauses)
  else patchSession(operation.id, operation.before)

  redoStack.push(operation)
  return historyState()
}

export function redo(): HistoryState {
  const operation = redoStack.pop()
  if (!operation) return historyState()

  if (operation.kind === 'insert') restore(operation.row, operation.pauses)
  else if (operation.kind === 'delete') deleteSession(operation.row.id)
  else patchSession(operation.id, operation.after)

  undoStack.push(operation)
  return historyState()
}
