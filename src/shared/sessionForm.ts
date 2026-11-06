/**
 * What a session entered by hand must carry before it is written.
 *
 * Date, project, task, planned and actual are required; output is optional.
 * A remembered session with no project or task is a row nobody can place
 * later, and on 11/05/2026 the form let exactly that through - or rather,
 * failed to save it in a way nothing on screen reported. So the rule lives
 * here, once, and both the form (to say what is missing) and main (to refuse
 * a write that skipped the form) apply it.
 *
 * Editing an existing row is held to less: imported history has rows with no
 * project, and refusing to save an unrelated fix to one until it is labeled
 * would make the Data tab worse at the job it exists for.
 */

export interface SessionFields {
  session_date?: unknown
  project?: unknown
  task?: unknown
  planned_duration_s?: unknown
  running_duration_s?: unknown
  /** Laps of a loop. Absent means one: the rule predates laps. */
  laps?: unknown
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''
const positive = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
const wholeLaps = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1)

/** The labels the form shows, in the order the form shows them. */
export function missingForNewSession(fields: SessionFields): string[] {
  const missing: string[] = []
  if (typeof fields.session_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fields.session_date))
    missing.push('Date')
  if (!filled(fields.project)) missing.push('Project')
  if (!filled(fields.task)) missing.push('Task')
  if (!positive(fields.planned_duration_s)) missing.push('Planned')
  if (!wholeLaps(fields.laps)) missing.push('Laps')
  if (!positive(fields.running_duration_s)) missing.push('Actual')
  return missing
}

/** An edit keeps the older, smaller rule: a real date and a real duration. */
export function missingForEdit(fields: SessionFields): string[] {
  const missing: string[] = []
  if (typeof fields.session_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fields.session_date))
    missing.push('Date')
  if (!wholeLaps(fields.laps)) missing.push('Laps')
  if (!positive(fields.running_duration_s)) missing.push('Actual')
  return missing
}

/** "Project", "Project and Task", "Project, Task and Actual". */
export function listOf(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
