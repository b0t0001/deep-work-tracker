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
 * ## Nothing moves in the DOM until the drop
 *
 * This is the rule the first version broke, and everything else here follows
 * from it. While the pointer is down the DOM order never changes: the dragged
 * element is translated under the hand, every other member is translated to
 * the slot it would occupy, and an outlined placeholder marks where the
 * dragged one will land. On release the order is committed once and every
 * transform is dropped in the same render - the elements are already where
 * the new order puts them, so nothing visibly moves.
 *
 * What the first version did instead was reorder the DOM on every preview
 * change and animate the result with FLIP: measure each element, compare
 * with the last measurement, set the inverse transform, transition it to
 * zero. That is the standard technique and it is sound only if the
 * measurements are taken when nothing is moving. Here a render arrives on
 * every pointer move - every 8 to 16ms - while the transitions last 170ms,
 * so **every measurement was taken mid-animation and fed straight back in as
 * the next "First" position**. The error compounds. Recorded by
 * `scripts/drag-repro.ts`, driving a real 40-step drag through CDP:
 *
 * ```
 * lifted card jumped 97 times, worst 19,524,847px
 * ```
 *
 * Nineteen million pixels. Every panel was thrown so far out of the viewport
 * that the tab rendered as an empty dark rectangle - the user's *"everything
 * else actually goes black"* - and the card under the pointer was somewhere
 * off the end of the world, which is *"I can't see where my panel goes"*.
 * `arrange-check.ts` passed against this: it drags a section in four coarse
 * steps with a 220ms settle between them, so every transition had finished
 * before the next measurement and the feedback loop never closed. A check
 * that waits is a check that cannot see this class of bug.
 *
 * Reordering the DOM mid-drag was also what made the rest of it expensive.
 * Moving a panel moves its subtree: Recharts' `ResponsiveContainer` sees a
 * resize, and a lazily-loaded WebGL canvas is re-parented and stops painting
 * - measured as 0 of 64 sampled pixels lit, read from the GL buffer rather
 * than from a screenshot, where a dead canvas and a dark one are the same
 * colour. None of that can happen to a subtree nobody touched.
 *
 * ## The geometry
 *
 * Slot rectangles are captured once, at drag start, in **document**
 * coordinates - `rect.top + scrollTop`, not `rect.top`. The viewport version
 * is wrong the moment anything scrolls, and this drag scrolls on purpose:
 * see the auto-scroll below. They are a property of the layout, not of
 * whatever currently sits in them, and they are never re-measured, because
 * measuring during an animation is the fault above.
 *
 * The target index is the slot centre nearest the pointer, with hysteresis:
 * a new candidate has to beat the current one by `SWITCH_PX` before it is
 * taken. Without that a pointer resting on a boundary flips between two
 * indices every frame, which is the other half of "spasming".
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Long enough to read as movement, short enough not to lag the pointer. */
const REFLOW_MS = 170

/**
 * How much nearer a slot has to be before the preview moves to it.
 *
 * A plain nearest-centre test has no stable state anywhere near a boundary:
 * sub-pixel pointer noise, or a slot edge that happens to sit under a
 * resting hand, flips the answer on every frame. This makes the current
 * choice sticky by 28px, about a finger's worth of wobble and far less than
 * the smallest slot.
 */
const SWITCH_PX = 28

/** How close to an edge the pointer gets before the page starts scrolling. */
const EDGE_PX = 90
/** Pixels per frame at the very edge, tapering to zero at `EDGE_PX`. */
const EDGE_SPEED = 18

export interface DragHandle {
  onPointerDown: (event: React.PointerEvent) => void
}

export interface Arrangement {
  /** The group and key being dragged, or null. */
  dragging: { group: string; key: string } | null
  /**
   * The order to render a group in.
   *
   * Always the committed order: the preview is drawn with transforms, so the
   * DOM is not reordered until the drop.
   */
  orderOf: (group: string, committed: string[]) => string[]
  /** Attach to the element that starts a drag - a grip, or a section header. */
  grab: (group: string, key: string) => DragHandle
  /** Attach to every draggable element, so it can be measured and moved. */
  ref: (group: string, key: string) => (element: HTMLElement | null) => void
  /** Where this element should be drawn right now: lifted, or shifted aside. */
  styleFor: (group: string, key: string) => React.CSSProperties | undefined
  /** The outlined drop target for a group, or null when it is not dragging. */
  dropStyle: (group: string) => React.CSSProperties | null
}

interface Slot {
  left: number
  top: number
  width: number
  height: number
}

interface DragState {
  group: string
  key: string
  pointerId: number
  /** Where the pointer went down, in document coordinates. */
  startX: number
  startY: number
  /** Where the pointer is now, in document coordinates. */
  x: number
  y: number
  /** Where the group's slots were when the drag began, in document space. */
  slots: Slot[]
  /** The group's order when the drag began; index i sits in `slots[i]`. */
  from: string[]
  /** Which slot the dragged element will land in. */
  target: number
  /** The element the page scrolls in, for auto-scroll and for coordinates. */
  scroller: Element
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

/** The nearest scrollable ancestor, or the document. */
function scrollerOf(element: Element): Element {
  let at: Element | null = element.parentElement
  while (at !== null) {
    const style = window.getComputedStyle(at)
    if (/(auto|scroll|overlay)/.test(style.overflowY) && at.scrollHeight > at.clientHeight)
      return at
    at = at.parentElement
  }
  return document.scrollingElement ?? document.documentElement
}

/** The order the drop would commit: the dragged key moved to `target`. */
function previewOrder(drag: DragState): string[] {
  const rest = drag.from.filter((one) => one !== drag.key)
  const at = Math.max(0, Math.min(drag.target, rest.length))
  rest.splice(at, 0, drag.key)
  return rest
}

/**
 * Where each member sits once the dragged one has moved to `target`.
 *
 * Two cases, because one formula cannot cover both. A single column - the
 * sections, and the panel grid below 1040px - stacks, so an item's top is the
 * first slot's top plus the heights of everything the preview puts before it.
 * Taking `slots[j]` there would be wrong whenever the items differ in height,
 * which sections do.
 *
 * A grid takes `slots[j]` directly. That is exact while every slot is the
 * same height, which is what the compact cards in arranging mode guarantee,
 * and approximate only for the packing of a full-width panel among half-width
 * ones - where the placeholder is what states the intent anyway.
 */
function targetSlots(drag: DragState): Map<string, Slot> {
  const order = previewOrder(drag)
  const out = new Map<string, Slot>()
  const slots = drag.slots
  if (slots.length === 0) return out

  const column = slots.every((one) => Math.abs(one.left - slots[0].left) < 1)
  if (!column) {
    order.forEach((key, index) => {
      const slot = slots[index]
      if (slot !== undefined) out.set(key, slot)
    })
    return out
  }

  // The gap is read from the layout rather than from CSS, so it follows
  // whatever the stylesheet says without this file knowing the number.
  const gap = slots.length > 1 ? Math.max(0, slots[1].top - (slots[0].top + slots[0].height)) : 0
  let top = slots[0].top
  for (const key of order) {
    const home = drag.from.indexOf(key)
    const size = slots[home] ?? slots[0]
    out.set(key, { left: slots[0].left, top, width: size.width, height: size.height })
    top += size.height + gap
  }
  return out
}

/**
 * `onCommit` is given the group and its new order, and is called **only** on
 * a successful drop - never during the drag. The preview is local state, so
 * an abandoned drag writes nothing to the layout and cannot leave a
 * half-applied arrangement in `app_settings`.
 *
 * It is also called from a plain handler rather than from inside a state
 * updater. It used to be inside one, which is a side effect in a function
 * React may run during the render phase - and the one case where
 * `useLayout`'s `update` could not see its own new layout, so a drop wrote
 * the order it started with while the screen showed the new one.
 */
export function useArrange(
  enabled: boolean,
  onCommit: (group: string, order: string[]) => void
): Arrangement {
  const [drag, setDrag] = useState<DragState | null>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  /** Mirrors `drag` for the frame loop, which must not re-subscribe. */
  const live = useRef<DragState | null>(null)

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

  const orderOf = useCallback((_group: string, committed: string[]): string[] => committed, [])

  const grab = useCallback(
    (group: string, key: string): DragHandle => ({
      onPointerDown: (event: React.PointerEvent) => {
        if (!enabled || event.button !== 0) return
        const element = nodes.current.get(at(group, key))
        if (element === undefined) return
        const scroller = scrollerOf(element)
        const scrollTop = scroller.scrollTop
        const scrollLeft = scroller.scrollLeft

        // Every registered element of this group, in document order, is a
        // slot. Captured now, in document coordinates, and not re-read: see
        // the file comment.
        const members: { key: string; slot: Slot }[] = []
        for (const [id, node] of nodes.current) {
          if (!id.startsWith(`${group}\u0000`)) continue
          const rect = node.getBoundingClientRect()
          members.push({
            key: id.slice(group.length + 1),
            slot: {
              left: rect.left + scrollLeft,
              top: rect.top + scrollTop,
              width: rect.width,
              height: rect.height
            }
          })
        }
        members.sort((a, b) => a.slot.top - b.slot.top || a.slot.left - b.slot.left)
        if (members.length < 2) return

        event.preventDefault()
        ;(event.target as Element).setPointerCapture?.(event.pointerId)
        const from = members.map((one) => one.key)
        const started: DragState = {
          group,
          key,
          pointerId: event.pointerId,
          startX: event.clientX + scrollLeft,
          startY: event.clientY + scrollTop,
          x: event.clientX + scrollLeft,
          y: event.clientY + scrollTop,
          slots: members.map((one) => one.slot),
          from,
          target: from.indexOf(key),
          scroller
        }
        live.current = started
        setDrag(started)
      }
    }),
    [enabled]
  )

  const finish = useCallback(
    (commit: boolean) => {
      const current = live.current
      if (current !== null && commit) {
        const order = previewOrder(current)
        if (order.some((one, index) => one !== current.from[index])) {
          onCommit(current.group, order)
        }
      }
      live.current = null
      setDrag(null)
    },
    [onCommit]
  )

  /*
   * One subscription for the whole gesture.
   *
   * The dependency is `dragging`, not `drag`: the drag state changes on every
   * pointer move, and re-subscribing four listeners and an animation frame
   * loop sixty times a second is exactly the per-frame work this tab is not
   * supposed to do. The handlers read the current state from `live`, which is
   * written wherever the state is.
   */
  const dragging = drag !== null
  useEffect(() => {
    const started = live.current
    if (!dragging || started === null) return
    const scroller = started.scroller
    const pointerId = started.pointerId
    let frame = 0
    /** The last viewport y, for the edge test. Auto-scroll has no new event. */
    let clientY = started.y - scroller.scrollTop

    /** Apply a change to both the state and the mirror, in one place. */
    const put = (next: (state: DragState) => DragState): void => {
      const current = live.current
      if (current === null) return
      const made = next(current)
      live.current = made
      setDrag(made)
    }

    /*
     * The slot the **card** is over, made sticky.
     *
     * Two things here were each wrong on their own, and the geometry of this
     * grid needs both.
     *
     * **Measured from the dragged card, not from the pointer.** The grip
     * sits at the right-hand end of a card up to 1,094px wide, so the
     * pointer is some 500px from a slot's centre on the x axis for the whole
     * gesture, and that constant dwarfs the vertical movement it is being
     * compared against. Dragging a card a full slot down moved it from 502px
     * away to 502.3px away - less than any hysteresis worth having - so the
     * preview never moved. The card's centre is its own slot plus however far
     * the pointer has travelled, which needs no measurement of anything that
     * is currently animating.
     *
     * **Distance to the slot's rectangle, not to its centre.** The panels
     * are not all the same width: Projects and output holds two half-width
     * panels side by side with a full-width one under them, whose centre is
     * in the middle of the page. A half-width card dragged straight down
     * from the left-hand column gets no nearer that centre than it started -
     * measured, 150px from its own slot against 288px from the one directly
     * below it - so the one place in the tab where three panels can actually
     * be reordered was the one place reordering did not work. The nearest
     * point of a rectangle has no such blind spot, and inside a slot the
     * distance is zero, which is the answer anyone would expect.
     */
    const near = (slot: Slot, x: number, y: number): number => {
      const dx = Math.max(slot.left - x, 0, x - (slot.left + slot.width))
      const dy = Math.max(slot.top - y, 0, y - (slot.top + slot.height))
      return Math.hypot(dx, dy)
    }

    const pick = (current: DragState, x: number, y: number): number => {
      const home = current.slots[current.from.indexOf(current.key)]
      if (home === undefined) return current.target
      const cx = home.left + home.width / 2 + (x - current.startX)
      const cy = home.top + home.height / 2 + (y - current.startY)
      let best = current.target
      let bestDistance = Infinity
      current.slots.forEach((slot, index) => {
        const distance = near(slot, cx, cy)
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      })
      if (best === current.target) return current.target
      const held = current.slots[current.target]
      if (held === undefined) return best
      // Sticky: a candidate has to beat the slot already chosen by a clear
      // margin, or a card resting on a boundary flips between the two on
      // every frame - the other half of "spasming".
      return bestDistance < near(held, cx, cy) - SWITCH_PX ? best : current.target
    }

    const move = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      event.preventDefault()
      clientY = event.clientY
      const x = event.clientX + scroller.scrollLeft
      const y = event.clientY + scroller.scrollTop
      put((state) => ({ ...state, x, y, target: pick(state, x, y) }))
    }

    /*
     * Auto-scroll, and why the pointer is tracked in document space.
     *
     * A drag that cannot scroll can only reach what is already on screen, and
     * the arrangement is taller than the window. Scrolling moves every element
     * under a pointer that has not moved, so the hit test has to be in
     * coordinates the scroll does not change - which is the whole reason the
     * slots are captured as document rectangles. When the page scrolls under
     * a still hand the pointer's document position changes by exactly the
     * scroll, and the target is re-picked from it.
     */
    const tick = (): void => {
      frame = requestAnimationFrame(tick)
      const current = live.current
      if (current === null) return
      const box = scroller.getBoundingClientRect()
      let by = 0
      if (clientY < box.top + EDGE_PX) {
        by = -EDGE_SPEED * Math.min(1, (box.top + EDGE_PX - clientY) / EDGE_PX)
      } else if (clientY > box.bottom - EDGE_PX) {
        by = EDGE_SPEED * Math.min(1, (clientY - (box.bottom - EDGE_PX)) / EDGE_PX)
      }
      if (by === 0) return
      const was = scroller.scrollTop
      scroller.scrollTop = was + by
      const moved = scroller.scrollTop - was
      if (moved === 0) return
      put((state) => {
        const y = state.y + moved
        return { ...state, y, target: pick(state, state.x, y) }
      })
    }
    frame = requestAnimationFrame(tick)

    const up = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
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
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key)
    }
  }, [dragging, finish])

  const targets = drag === null ? null : targetSlots(drag)

  const styleFor = useCallback(
    (group: string, key: string): React.CSSProperties | undefined => {
      if (drag === null || drag.group !== group) return undefined
      if (drag.key === key) {
        return {
          transform: `translate(${drag.x - drag.startX}px, ${drag.y - drag.startY}px)`,
          transition: 'none',
          zIndex: 6,
          position: 'relative',
          // The card is under the pointer for the whole gesture, so anything
          // it covers would never see a hover or a drop. It is a picture of
          // what is being moved, not a target.
          pointerEvents: 'none'
        }
      }
      const home = drag.from.indexOf(key)
      const to = targets?.get(key)
      if (home === -1 || to === undefined) return undefined
      const was = drag.slots[home]
      return {
        transform: `translate(${to.left - was.left}px, ${to.top - was.top}px)`,
        transition: reducedMotion()
          ? 'none'
          : `transform ${REFLOW_MS}ms cubic-bezier(0.2, 0, 0, 1)`,
        // Raised above the untransformed siblings, so a card sliding past one
        // is not half-hidden behind it.
        position: 'relative',
        zIndex: 1
      }
    },
    [drag, targets]
  )

  /**
   * The outlined slot the dragged element will land in.
   *
   * Positioned `fixed` from the captured document rectangle less the current
   * scroll, rather than absolutely inside the group, so it needs no
   * positioned ancestor and cannot be clipped by one. Inert: a drop target
   * that could take a pointer event would steal the drop.
   */
  const dropStyle = useCallback(
    (group: string): React.CSSProperties | null => {
      if (drag === null || drag.group !== group) return null
      const to = targets?.get(drag.key)
      if (to === undefined) return null
      return {
        position: 'fixed',
        left: to.left - drag.scroller.scrollLeft,
        top: to.top - drag.scroller.scrollTop,
        width: to.width,
        height: to.height,
        pointerEvents: 'none',
        zIndex: 4
      }
    },
    [drag, targets]
  )

  return {
    dragging: drag === null ? null : { group: drag.group, key: drag.key },
    orderOf,
    grab,
    ref,
    styleFor,
    dropStyle
  }
}
