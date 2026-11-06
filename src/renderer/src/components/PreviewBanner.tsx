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
 * It also says what happens to what is done here, which is nothing: the
 * preview is read-only toward the real history. Anything recorded is marked
 * TEST and deleted with the copy when the preview closes. That is the rule the
 * user chose on 11/06/2026, after a day in which the preview copied its rows
 * back - an unreleased build writing to the real data.
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
`

interface Snapshot {
  takenAt: string | null
  sessions: number | null
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
          {taken === null ? 'a copy of your data.' : `a copy of your data from ${taken}.`} Nothing
          here is saved to your real history: anything you record is marked TEST and deleted when
          the preview closes. Record real work in Deep Work Tracker.
        </span>
      </div>
    </>
  )
}
