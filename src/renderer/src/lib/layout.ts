/**
 * Reading and writing the Analytics layout from the renderer.
 *
 * The parsing, merging and clamping all live in `shared/layout.ts`; this is
 * only the wire to the main process, plus the hook the tab uses.
 *
 * `window.api.layout` is reached defensively. The store landed before the IPC
 * did, and a dashboard that throws on first paint because a preference channel
 * is missing would be a worse failure than forgetting a layout - there is
 * nothing here that cannot be recreated by dragging. So an absent channel
 * degrades to a layout that works for the session and is not saved, and says
 * so rather than pretending.
 */
import { useCallback, useEffect, useState } from 'react'
import { defaultLayout, parseLayout, serialiseLayout, type Layout } from '@shared/layout'

interface LayoutChannel {
  get(): Promise<string | null>
  set(json: string): Promise<void>
}

function channel(): LayoutChannel | null {
  const api = window.api as unknown as { layout?: LayoutChannel } | undefined
  const found = api?.layout
  return found && typeof found.get === 'function' && typeof found.set === 'function' ? found : null
}

export interface LayoutState {
  layout: Layout
  /** False when the layout is session-only because the channel is missing. */
  persists: boolean
  update(next: Layout): void
  reset(): void
}

export function useLayout(): LayoutState {
  const [layout, setLayout] = useState<Layout>(defaultLayout)
  // Derived once rather than set from inside the effect: whether the channel
  // exists is a fact about the preload bridge at module time, not something
  // that changes, and setting it in an effect makes React re-render to learn
  // what it could have known on the first pass.
  const [persists] = useState(() => channel() !== null)

  useEffect(() => {
    const api = channel()
    if (api === null) return
    let alive = true
    api
      .get()
      .then((text) => {
        if (alive) setLayout(parseLayout(text))
      })
      .catch(() => {
        // A failed read is the same situation as no stored layout: show the
        // default rather than an error. Nothing is lost that a drag cannot
        // redo, and a preference is not worth a failure state over a chart.
        if (alive) setLayout(defaultLayout())
      })
    return () => {
      alive = false
    }
  }, [])

  const update = useCallback((next: Layout) => {
    // Optimistic: the layout is what the user just did, so it should move now
    // and reconcile later rather than wait on a round trip to the database.
    setLayout(next)
    void channel()
      ?.set(serialiseLayout(next))
      .catch(() => {
        /* Saving a preference is not worth interrupting anyone over. */
      })
  }, [])

  const reset = useCallback(() => update(defaultLayout()), [update])

  return { layout, persists, update, reset }
}
