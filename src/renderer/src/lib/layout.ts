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
import type { DeepWorkApi } from '../../../preload'
import { defaultLayout, resolveLayout, type Layout } from '@shared/layout'

/**
 * Objects both ways rather than raw JSON.
 *
 * `main/db/layout.ts` already works in `Layout` and runs `resolveLayout` on
 * the way in, so the renderer cannot store something invalid even by accident
 * and there is nothing for a string interface to protect. What comes back is
 * still resolved here, because an IPC payload is only as trustworthy as the
 * process that sent it and this one crosses a bridge.
 */
/**
 * The channel's shape, taken from the preload bridge rather than redeclared.
 *
 * This file used to declare its own `LayoutChannel` and reach `window.api`
 * through `as unknown as`. That cast is why a real mismatch typechecked clean
 * for three commits: the renderer said the channel took a `Layout`, preload
 * said it took a string, and because the cast erased the boundary there was
 * nothing for TypeScript to compare. Saving a layout threw in the main
 * process, the rejection was swallowed by design, and the `persists` flag
 * below could not see it because the functions did exist - they were simply
 * the wrong shape.
 *
 * `DeepWorkApi` is `typeof api` in `preload/index.ts`, so deriving from it
 * means the two halves are now checked against each other by the compiler.
 * An IPC boundary is the one place where both sides may be written by
 * different people at the same time, which is the worst possible place to
 * turn type checking off.
 */
type LayoutChannel = DeepWorkApi['layout']

function channel(): LayoutChannel | null {
  // `Partial` rather than a cast: a preload built before this channel existed
  // genuinely has no `layout`, and that is worth handling - but it is absence
  // being handled, not the shape being hidden.
  //
  // `| undefined` and the optional chain are the artist's, kept deliberately.
  // The rest of the renderer calls `window.api.x` unguarded thirty-five times
  // over, so a missing bridge breaks the app long before this file runs - but
  // this module's whole argument is that losing a *preference* must not take
  // the dashboard down, and that argument is worth one character.
  const found = (window.api as Partial<DeepWorkApi> | undefined)?.layout
  return found && typeof found.get === 'function' && typeof found.set === 'function' ? found : null
}

export interface LayoutState {
  layout: Layout
  /** False when the layout is session-only because the channel is missing. */
  persists: boolean
  update(next: Layout | ((prev: Layout) => Layout)): void
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
      .then((stored) => {
        if (alive) setLayout(resolveLayout(stored))
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

  const update = useCallback((next: Layout | ((prev: Layout) => Layout)) => {
    // Optimistic: the layout is what the user just did, so it should move now
    // and reconcile later rather than wait on a round trip to the database.
    // Resolved against the layout as it is now, not as it was when the
    // handler closed over it. Two quick presses of the text-size button
    // both computed from the same stale value, so the second did
    // nothing and the step looked like half of what it is.
    let resolved: Layout = defaultLayout()
    setLayout((prev) => {
      resolved = typeof next === 'function' ? next(prev) : next
      return resolved
    })
    void channel()
      ?.set(resolved)
      .then((stored) => {
        // Adopt what was actually stored rather than keeping our own idea of
        // it. `writeLayout` resolves before writing, so this is where a panel
        // the renderer has never heard of gets appended and shown instead of
        // being quietly dropped on the next write.
        setLayout(resolveLayout(stored))
      })
      .catch(() => {
        /* Saving a preference is not worth interrupting anyone over. */
      })
  }, [])

  const reset = useCallback(() => update(defaultLayout()), [update])

  return { layout, persists, update, reset }
}
