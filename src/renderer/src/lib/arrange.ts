/**
 * Dragging panels and sections around, with the rest of the page getting out
 * of the way as you go.
 *
 * *"I want you to add like a live preview of how my dragging is affecting the
 * other panels. Apps where you can drag panels around, and like basically it
 * shows all the other ones changing to react to that."*
 *
 * ## Why pointer events and not HTML5 drag-and-drop
 *
 * The tab used `draggable` with `dragstart`/`dragover`/`drop`, which is less
 * code and cannot do this. Three reasons, in the order they bite:
 *
 * - **During a native drag the page is frozen.** The browser owns the
 *   gesture and the drag image is a snapshot taken at `dragstart`; the
 *   siblings can be re-ordered in the DOM but nothing can be animated
 *   smoothly, because the only position information arriving is a
 *   `dragover` per sibling rather than a continuous pointer track.
 * - **The drag image cannot be styled.** A lifted, semi-transparent card is
 *   the part that makes the gesture read as picking something up, and
 *   `setDragImage` takes a static element, not a live one.
 * - **Electron.** Native drag interacts with `-webkit-app-region` in ways
 *   this project has already lost three builds to, and the dashboard is one
 *   `no-drag` mistake away from the same class of bug.
 *
 * Pointer events give a continuous position, leave the DOM ours to animate,
 * and work identically under CDP - which is how the mid-drag screenshots are
 * taken. The cost is that focus, capture and cancellation are ours to get
 * right; that is what the rest of this file is.
 *
 * ## How the reflow works
 *
 * FLIP, the standard trick, and the only subtle part is what is measured.
 *
 * **Slot positions are captured once, at drag start.** They are a property of
 * the layout, not of which item currently sits in them: a two-column grid has
 * the same eight boxes whatever order the panels are in. Re-measuring each
 * frame would read positions that are mid-animation and feed them back into
 * the hit test, which oscillates. So the target index is "which captured slot
 * centre is the pointer nearest", which is stable, and the preview order is
 * the dragged item moved to that index.
 *
 * Then on every render where the preview changed: measure each element (Last),
 * compare with where it was (First), set the inverse transform with no
 * transition, and on the next frame transition it to zero. The dragged element
 * is excluded - it follows the pointer instead.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** Long enough to read as movement, short enough not to lag the pointer. */
const REFLOW_MS = 170

export interface DragHandle {
  onPointerDown: (event: React.PointerEvent) => void
}

export interface Arrangement {
  /** The group and key being dragged, or null. */
  dragging: { group: string; key: string } | null
  /** The order to render a group in right now: the preview while dragging. */
  orderOf: (group: string, committed: string[]) => string[]
  /** Attach to the element that starts a drag - a grip, or a section header. */
  grab: (group: string, key: string) => DragHandle
  /** Attach to every draggable element, so it can be measured and moved. */
  ref: (group: string, key: string) => (element: HTMLElement | null) => void
  /** The lift transform for the element under the pointer. */
  liftStyle: (group: string, key: string) => React.CSSProperties | undefined
}

interface DragState {
  group: string
  key: string
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  /** Where the group's slots were when the drag began. */
  slots: { left: number; top: number; width: number; height: number }[]
  /** The group's order when the drag began, to restore on cancel. */
  from: string[]
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    // A renderer where `matchMedia` is unavailable gets the animation. The
    // alternative - treating a missing API as "reduce" - would quietly
    // disable the feature this file exists for.
    return false
  }
}

/**
 * `onCommit` is given the group and its new order, and is called **only** on
 * a successful drop - never during the drag. The preview is local state, so
 * an abandoned drag writes nothing to the layout and cannot leave a
 * half-applied arrangement in `app_settings`.
 */
export function useArrange(
  enabled: boolean,
  onCommit: (group: string, order: string[]) => void
): Arrangement {
  const [drag, setDrag] = useState<DragState | null>(null)
  const [preview, setPreview] = useState<{ group: string; order: string[] } | null>(null)

  const nodes = useRef(new Map<string, HTMLElement>())
  const rects = useRef(new Map<string, DOMRect>())
  /** Set while a drop is being committed, so the FLIP pass does not fight it. */
  const settling = useRef(false)

  const at = (group: string, key: string): string => `${group}\u0000${key}`

  /*
   * One ref callback per element, kept.
   *
   * Returning a fresh closure each render makes React detach and reattach
   * every registered node on every render - it calls the old ref with null
   * and the new one with the element. That is churn for nothing here, and
   * it is the kind of per-render DOM work the tab is supposed not to do.
   * Cached by key, so each element keeps the same callback for its life.
   */
  const refs = useRef(new Map<string, (element: HTMLElement | null) => void>())
  const ref = useCallback((group: string, key: string) => {
    const id = at(group, key)
    const found = refs.current.get(id)
    if (found !== undefined) return found
    const made = (element: HTMLElement | null): void => {
      if (element === null) nodes.current.delete(id)
      else nodes.current.set(id, element)
    }
    refs.current.set(id, made)
    return made
  }, [])

  const orderOf = useCallback(
    (group: string, committed: string[]): string[] => {
      if (preview !== null && preview.group === group) return preview.order
      return committed
    },
    [preview]
  )

  /*
   * FLIP, every render.
   *
   * No dependency array: the thing that has to be caught is any render in
   * which an element ended up somewhere new, and that is not expressible as a
   * dependency - the preview is one cause, a range change under the panel is
   * another. Measuring is cheap and the loop below does nothing when nothing
   * moved.
   */
  useLayoutEffect(() => {
    const dragged = drag === null ? null : at(drag.group, drag.key)
    const instant = reducedMotion()
    /*
     * **Only while a drag is in progress.**
     *
     * This effect runs on every render, which is right for *measuring* -
     * positions must be current when a drag starts, and the thing that moved
     * them is not expressible as a dependency. It was wrong for *animating*:
     * any render that changed a height got the full FLIP treatment, so
     * changing a panel's range threw the whole page to its previous layout
     * and eased it back.
     *
     * That is the bug the user reported as "the panels want to move up or
     * something like that and then they quickly go back down... just there
     * for a split second", and it is invisible to a layout assertion -
     * `offsetTop` never changed. Measured frame by frame on a range change:
     *
     *   offsetTop  147 147 147 147 ... 147   (never moves)
     *   rect.top   -353 147 -853 -839 -779 -682 -608 -482 -391 -367 -358 -353
     *
     * A transform thrown 1,000px and eased back over fifteen frames, for a
     * layout change nobody dragged. `scripts/reflow-check.ts` asserts the
     * painted position as well as the laid-out one, because the first
     * version of that check watched `offsetTop` alone and passed.
     */
    const animating = drag !== null && !settling.current && !instant
    for (const [id, element] of nodes.current) {
      const now = element.getBoundingClientRect()
      const was = rects.current.get(id)
      rects.current.set(id, now)
      if (id === dragged || was === undefined || !animating) continue
      const dx = was.left - now.left
      const dy = was.top - now.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      /*
       * Writing to the DOM directly, which the compiler's immutability rule
       * is right to flag in general and is the whole technique here: FLIP
       * works by setting a start transform, forcing a reflow so the browser
       * accepts it as a fact, and only then declaring the transition. There
       * is no way to express "these two style writes must be separated by a
       * layout read" through React state, and going through state would
       * render twice per frame per element for an animation React is not
       * driving. These elements are ours - registered through `ref` above
       * and never rendered from this value.
       */
      /* eslint-disable react-hooks/immutability */
      element.style.transition = 'none'
      element.style.transform = `translate(${dx}px, ${dy}px)`
      // Read back, so the browser takes the start position as a fact before
      // the transition is declared. Without this the two styles coalesce
      // into one frame and nothing animates.
      void element.offsetWidth
      element.style.transition = `transform ${REFLOW_MS}ms cubic-bezier(0.2, 0, 0, 1)`
      element.style.transform = ''
      /* eslint-enable react-hooks/immutability */
    }
  })

  /**
   * End the drag, committing the preview or discarding it.
   *
   * **`onCommit` is called here, not inside a `setDrag` updater.** It used to
   * be, which reads as a tidy way to get the drag state and the decision in
   * one place and is a side effect in a function React is allowed to call
   * during the render phase - and does. The commit then ran while the
   * component had pending work, which is exactly the case where
   * `useLayout`'s `update` could not see its own new layout, so a drop wrote
   * the layout it started with. `scripts/arrange-check.ts` caught it as
   * "dropping commits what the preview showed": the preview was right on
   * screen, the engine passed the right order to `onCommit`, and the order
   * that reached the database was the one before the drag.
   *
   * `drag` and `preview` are read from this render instead. `finish` is in
   * the listener effect's dependencies, so the handlers always hold the
   * current one.
   */
  const finish = useCallback(
    (commit: boolean) => {
      if (drag !== null && commit && preview !== null && preview.group === drag.group) {
        settling.current = true
        onCommit(drag.group, preview.order)
        // Cleared after the commit has rendered, so the one render where the
        // real order replaces the preview is not animated - the items are
        // already where the preview put them.
        requestAnimationFrame(() => {
          settling.current = false
        })
      }
      setDrag(null)
      setPreview(null)
    },
    [drag, preview, onCommit]
  )

  const grab = useCallback(
    (group: string, key: string): DragHandle => ({
      onPointerDown: (event: React.PointerEvent) => {
        if (!enabled || event.button !== 0) return
        const element = nodes.current.get(at(group, key))
        if (element === undefined) return

        // Every registered element of this group, in document order, is a
        // slot. Captured now and not re-read: see the file comment.
        const members: { key: string; rect: DOMRect }[] = []
        for (const [id, node] of nodes.current) {
          if (!id.startsWith(`${group}\u0000`)) continue
          members.push({ key: id.slice(group.length + 1), rect: node.getBoundingClientRect() })
        }
        members.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
        if (members.length < 2) return

        event.preventDefault()
        ;(event.target as Element).setPointerCapture?.(event.pointerId)
        setDrag({
          group,
          key,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          x: event.clientX,
          y: event.clientY,
          slots: members.map((one) => ({
            left: one.rect.left,
            top: one.rect.top,
            width: one.rect.width,
            height: one.rect.height
          })),
          from: members.map((one) => one.key)
        })
        setPreview({ group, order: members.map((one) => one.key) })
      }
    }),
    [enabled]
  )

  useLayoutEffect(() => {
    if (drag === null) return

    const move = (event: PointerEvent): void => {
      if (event.pointerId !== drag.pointerId) return
      setDrag((current) =>
        current === null ? null : { ...current, x: event.clientX, y: event.clientY }
      )

      // Nearest slot centre to the pointer. Nearest rather than "crossed the
      // midpoint" because the panel grid is two-dimensional: a half-width
      // panel's neighbour can be beside it as easily as below.
      let best = 0
      let bestDistance = Infinity
      drag.slots.forEach((slot, index) => {
        const dx = slot.left + slot.width / 2 - event.clientX
        const dy = slot.top + slot.height / 2 - event.clientY
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      })

      setPreview((current) => {
        if (current === null || current.group !== drag.group) return current
        if (current.order[best] === drag.key) return current
        const next = current.order.filter((one) => one !== drag.key)
        next.splice(best, 0, drag.key)
        return { group: drag.group, order: next }
      })
    }

    const up = (event: PointerEvent): void => {
      if (event.pointerId !== drag.pointerId) return
      finish(true)
    }

    const cancel = (): void => finish(false)

    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key)
    }
  }, [drag, finish])

  const liftStyle = useCallback(
    (group: string, key: string): React.CSSProperties | undefined => {
      if (drag === null || drag.group !== group || drag.key !== key) return undefined
      return {
        transform: `translate(${drag.x - drag.startX}px, ${drag.y - drag.startY}px)`,
        transition: 'none',
        zIndex: 5,
        position: 'relative'
      }
    },
    [drag]
  )

  return {
    dragging: drag === null ? null : { group: drag.group, key: drag.key },
    orderOf,
    grab,
    ref,
    liftStyle
  }
}
