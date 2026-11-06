import React, { useEffect, useState } from 'react'
import { formatDateTime } from '@shared/dates'

/**
 * Says so when the window is showing a copy of the real history.
 *
 * `npm run preview` runs the app against a snapshot, so this is the one build
 * where every number looks exactly right and none of it is live. Without a
 * marker the only way to tell a preview from the installed app is to notice
 * that the most recent session is missing, which is precisely the thing
 * nobody notices.
 *
 * It also says what happens to what is done here: since 2026-11-06 the
 * preview's changes are copied into the real history when it closes, and the
 * line under it reports what the last preview's copy did - including anything
 * it could not copy, which is the one case that needs the user to look.
 *
 * **Dashboard only.** The timer window is filmed for the timelapses the user
 * posts, so a banner there would end up in them; the dashboard carries the
 * detail in this app, and it carries this too.
 *
 * The styles are a `<style>` block rather than a rule in `main.css`, the same
 * way `AnalyticsCharts` keeps its chart CSS. They belong to a component that
 * renders in one build and nowhere else, and a global rule for something that
 * is almost never on screen is harder to find than one sitting beside the
 * markup it styles.
 */
const CSS = `
.preview-flag {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 16px;
  background: #3a2a0d;
  border-bottom: 1px solid #6b4e14;
  color: #f0c674;
  font-size: 12px;
  line-height: 1.4;
}
.preview-flag__tag {
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.preview-flag__note {
  color: #c9a76a;
}
.preview-flag__last {
  display: block;
  margin-top: 2px;
  color: #c9a76a;
}
`

interface Snapshot {
  takenAt: string | null
  sessions: number | null
  lastSync: {
    at: string | null
    added: number
    edited: number
    deleted: number
    conflicts: number
    recoveryDir: string | null
  } | null
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** What the last preview's copy did, in one sentence, or null if it did nothing. */
function lastSyncLine(last: Snapshot['lastSync']): string | null {
  if (last === null) return null
  const parts = [
    last.added > 0 ? `${plural(last.added, 'session')} added` : null,
    last.edited > 0 ? `${last.edited} edited` : null,
    last.deleted > 0 ? `${last.deleted} deleted` : null
  ].filter((part): part is string => part !== null)
  const when = last.at === null ? '' : ` (${formatDateTime(last.at)})`
  const saved =
    parts.length === 0 ? null : `Last preview${when}: ${parts.join(', ')} in your real history.`
  const kept =
    last.conflicts === 0
      ? null
      : `${plural(last.conflicts, 'change')} not saved, because the desktop app changed the ` +
        `same session too - kept in ${last.recoveryDir ?? 'Recovery'}.`
  return [saved, kept].filter(Boolean).join(' ') || null
}

export function PreviewBanner(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)

  useEffect(() => {
    let live = true
    window.api.build
      .preview()
      .then((found) => {
        if (live) setSnapshot(found)
      })
      // A missing marker must not take the dashboard with it. The banner is a
      // courtesy; the tab behind it is the thing the user opened.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  if (snapshot === null) return null

  const taken = snapshot.takenAt === null ? null : formatDateTime(snapshot.takenAt)
  const last = lastSyncLine(snapshot.lastSync)

  return (
    // The `<style>` sits outside the strip, not inside it: as a child its
    // rules land in the strip's own `textContent`, which is what anything
    // reading the banner back - a test, a screen reader walking text - gets
    // handed before the words.
    <>
      <style>{CSS}</style>
      <div className="preview-flag">
        <span className="preview-flag__tag">Preview</span>
        <span className="preview-flag__note">
          {taken === null ? 'a copy of your data.' : `a copy of your data from ${taken}.`} What you
          add or change here is saved to your real history when the preview closes.
          {last !== null && <span className="preview-flag__last">{last}</span>}
        </span>
      </div>
    </>
  )
}
