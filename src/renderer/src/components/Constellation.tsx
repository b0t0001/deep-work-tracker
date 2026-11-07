/**
 * Constellation: every session as a star in one slowly turning cloud.
 *
 * The user's brief was a point cloud "like one of those LiDAR things ... those
 * obsidian mind maps", every session a point, three axes that are each "some
 * sort of range". Where each star sits is decided entirely by
 * `shared/constellation.ts` and tested there; this file only draws it.
 *
 * Loaded lazily (see `Dashboard.tsx`). The renderer bundle is shared by every
 * window, and three.js is several hundred kilobytes that the timer window - the
 * one that has to open instantly - must never parse.
 *
 * Things that are easy to undo by accident:
 *
 * - **One WebGL context per mount, disposed on unmount.** Chromium caps live
 *   contexts at sixteen and drops the oldest past that, so a context leaked
 *   per visit to the tab would eventually blank a chart. A range change swaps
 *   the geometry inside the same context and disposes the old buffers rather
 *   than building a second context.
 * - **The wheel scrolls the page until the cloud has been clicked.** A panel
 *   that captured the wheel on sight would stop the Analytics tab scrolling
 *   the moment the pointer drifted over it on the way down. Once you have
 *   clicked or dragged the cloud, the wheel zooms until the pointer leaves;
 *   in fullscreen it always zooms.
 * - **The stage is opaque.** Additive blending into a transparent canvas adds
 *   into the alpha channel too, and the compositor then lets the panel show
 *   through every bright star. An opaque stage with its own near-black is
 *   what makes the glow read as light rather than as holes.
 * - **The loop stops when nobody can see it** - scrolled out of view or the
 *   window hidden - so a dashboard left open does not spin a GPU all day.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AdditiveBlending,
  NormalBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LineLoop,
  LineSegments,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
  type Material
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  HEIGHT,
  RADIUS,
  SITTING_GAP_MINUTES,
  TWIST,
  armColours,
  colourRanks,
  starRows,
  projectChoices,
  projectColour,
  withProjectShown,
  hideAllProjects,
  showAllProjects,
  PROJECTIONS,
  type Projection,
  buildConstellation,
  type Constellation as Model
} from '@shared/constellation'
import type { SessionRow } from '@shared/analytics'
import { formatDate } from '@shared/dates'
import { formatCount, pluralUnit } from '@shared/facts'
import { ChartTip } from './AnalyticsCharts'

const STAGE_BG = '#05060a'
const SHAPE_KEY = 'dwt.constellation.shape'
/** Where the camera looks: a little above the floor, so tall stars are not cropped. */
const TARGET_Y = HEIGHT * 0.32
/** Seconds of stillness after an interaction before the slow turn resumes. */
const IDLE_RESUME_MS = 5000

const CSS = `
.cst__stage {
  position: relative;
  height: clamp(440px, 62vh, 760px);
  border-radius: 10px;
  overflow: hidden;
  background: ${STAGE_BG};
  isolation: isolate;
  outline: none;
}
.cst__stage:fullscreen {
  height: 100vh;
  border-radius: 0;
}
.cst__stage canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
}
.cst__stage canvas:active {
  cursor: grabbing;
}
.cst__stage.is-hovering canvas {
  cursor: pointer;
}
/* A vignette, above the canvas and below everything else. It is what makes
   the stage read as depth rather than as a black rectangle. */
.cst__vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 70% 60% at 50% 52%, transparent 40%, #00000099 100%),
    radial-gradient(ellipse 45% 38% at 50% 55%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 70%);
}
.cst__labels {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.cst__label {
  position: absolute;
  left: 0;
  top: 0;
  white-space: nowrap;
  font-size: calc(10.5px * var(--an-fs, 1));
  letter-spacing: 0.02em;
  color: #c9ced8;
  will-change: transform, opacity;
}
.cst__label--ring {
  color: #8b919c;
  font-variant-numeric: tabular-nums;
}
.cst__label--tick {
  color: #6c727d;
  font-size: calc(9.5px * var(--an-fs, 1));
  font-variant-numeric: tabular-nums;
}
.cst__label--arm {
  font-weight: 560;
  text-shadow: 0 0 8px #000;
}
.cst__legend {
  position: absolute;
  left: 12px;
  top: 12px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: calc(100% - 24px);
  overflow: auto;
  padding: 6px;
  border-radius: 9px;
  background: color-mix(in srgb, ${STAGE_BG} 70%, transparent);
  backdrop-filter: blur(6px);
}
.cst__arm {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px 3px 6px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: calc(11.5px * var(--an-fs, 1));
  text-align: left;
  cursor: pointer;
  transition: opacity 160ms ease, background 120ms ease;
}
.cst__arm:hover {
  background: #ffffff0d;
}
.cst__arm.is-dim {
  opacity: 0.38;
}
.cst__arm.is-on {
  background: #ffffff12;
}
.cst__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
}
.cst__arm-name {
  flex: 1 1 auto;
  max-width: 16ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cst__arm-hours {
  color: var(--text-dim);
  font-size: calc(10.5px * var(--an-fs, 1));
  font-variant-numeric: tabular-nums;
  margin-left: 8px;
}
.cst__title {
  display: none;
  position: absolute;
  right: 18px;
  bottom: 16px;
  text-align: right;
  pointer-events: none;
}
.cst__stage:fullscreen .cst__title {
  display: block;
}
.cst__title b {
  display: block;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--text);
}
.cst__title span {
  font-size: 12px;
  color: var(--text-dim);
}
.cst__tip {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 3;
  pointer-events: none;
  max-width: 280px;
}
.cst__hint {
  position: absolute;
  right: 12px;
  bottom: 12px;
  padding: 5px 10px;
  border-radius: 7px;
  background: #000000aa;
  color: var(--text-dim);
  font-size: 11px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 200ms ease;
}
.cst__hint.is-on {
  opacity: 1;
}
/* Doubled class: .cst__btn below sets display too, and would win on order. */
.cst__btn.cst__exit {
  display: none;
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 3;
}
.cst__stage:fullscreen .cst__btn.cst__exit {
  display: inline-flex;
}
.cst__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.cst__btn:hover {
  color: var(--text);
  border-color: var(--border);
}
.cst__btn svg {
  width: 13px;
  height: 13px;
  display: block;
}
.cst__picker {
  position: relative;
}
.cst__pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: calc(11.5px * var(--an-fs, 1));
  cursor: pointer;
}
.cst__pick:hover,
.cst__pick.is-on {
  color: var(--text);
  border-color: var(--border);
}
.cst__pick-count {
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}
.cst__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 5;
  width: 280px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-raised);
  box-shadow: 0 10px 28px #00000077;
}
.cst__search {
  box-sizing: border-box;
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 12px;
}
.cst__menu-actions {
  display: flex;
  gap: 4px;
  margin: 8px 0 6px;
}
.cst__menu-actions button {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.cst__menu-actions button:hover:not(:disabled) {
  color: var(--text);
}
.cst__menu-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}
.cst__menu-list {
  max-height: 300px;
  overflow: auto;
}
.cst__choice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}
.cst__choice:hover {
  background: #ffffff0a;
}
.cst__choice input {
  margin: 0;
  accent-color: var(--accent);
}
.cst__choice .cst__arm-hours {
  margin-left: auto;
}
.cst__menu-note {
  margin: 6px 2px 0;
  color: var(--text-dim);
  font-size: 11px;
}
.cst__shape {
  display: inline-flex;
  gap: 2px;
}
.cst__shape button {
  padding: 2px 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: calc(11.5px * var(--an-fs, 1));
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.cst__shape button:hover {
  color: var(--text);
}
.cst__shape button.is-on {
  color: var(--text);
  border-color: var(--border);
}
.cst__aside {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.cst__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
}
/* While panels are being arranged the cloud must not take the pointer: a
   drag that started on it would orbit instead of doing nothing, and the
   grip is the only handle. */
.an.is-arranging .cst__stage {
  pointer-events: none;
}
`

/* ---------- shaders ---------- */

const STAR_VERT = `
attribute vec3 color;
attribute float size;
attribute float bright;
attribute float arm;
uniform float uScale;
uniform float uPixelRatio;
uniform float uIsolate;
uniform float uFocus;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
uniform float uWave;
varying vec3 vColor;
varying float vAlpha;
varying float vHot;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(0.1, -mv.z);
  float on = (uIsolate < -0.5 || abs(arm - uIsolate) < 0.5) ? 1.0 : 0.0;
  float dim = mix(1.0, mix(0.05, 1.0, on), uFocus);
  // Depth is carried by size and by fading into the stage with distance -
  // the way a scanned point cloud reads - not by glow.
  float fog = 1.0 - 0.72 * smoothstep(uFogNear, uFogFar, depth);
  // A faint swell travelling outward through time, from the first session
  // to the latest, while the cloud turns. uWave < -1 switches it off.
  float wave = exp(-pow((bright - uWave) * 9.0, 2.0));
  vColor = color * (0.62 + 0.38 * bright) + vec3(0.16 * wave);
  vHot = wave;
  vAlpha = 0.92 * fog * dim;
  gl_PointSize = clamp(size * uScale / depth, 1.2, 16.0) * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}
`

const STAR_FRAG = `
varying vec3 vColor;
varying float vAlpha;
varying float vHot;
void main() {
  // A crisp disc with a pixel of soft edge, and nothing outside it. No halo:
  // halos added up in the dense arms and blew them out to white, which read
  // as a constellation rather than as a scan.
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  float a = 1.0 - smoothstep(0.62, 1.0, d);
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}
`

const LINE_VERT = `
attribute vec3 color;
attribute float arm;
uniform float uIsolate;
uniform float uFocus;
uniform float uFogNear;
uniform float uFogFar;
uniform float uAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = -mv.z;
  float on = (uIsolate < -0.5 || abs(arm - uIsolate) < 0.5) ? 1.0 : 0.0;
  float dim = mix(1.0, mix(0.03, 1.0, on), uFocus);
  float fog = 1.0 - 0.85 * smoothstep(uFogNear, uFogFar, depth);
  vColor = color;
  vAlpha = uAlpha * fog * dim;
  gl_Position = projectionMatrix * mv;
}
`

const LINE_FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`

/** Faint, fixed dust far behind the cloud: parallax, so turning reads as depth. */
const DUST_VERT = `
attribute float bright;
uniform float uPixelRatio;
varying float vAlpha;
void main() {
  vAlpha = bright;
  gl_PointSize = (1.0 + bright * 1.6) * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const DUST_FRAG = `
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = dot(p, p);
  if (d > 1.0) discard;
  gl_FragColor = vec4(vec3(0.75, 0.82, 1.0), (1.0 - d) * vAlpha * 0.28);
}
`

/** The hovered star's ring. */
const MARK_FRAG = `
uniform vec3 uColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  float ring = smoothstep(0.62, 0.74, d) * (1.0 - smoothstep(0.84, 0.96, d));
  if (ring < 0.01) discard;
  gl_FragColor = vec4(uColor, ring * 0.95);
}
`
const MARK_VERT = `
uniform float uSize;
uniform float uPixelRatio;
void main() {
  gl_PointSize = uSize * uPixelRatio;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/* ---------- formatting ---------- */

function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

function hoursShort(hours: number): string {
  if (hours >= 100) return `${Math.round(hours).toLocaleString('en-US')} h`
  if (hours >= 10) return `${Math.round(hours)} h`
  return `${(Math.round(hours * 10) / 10).toString()} h`
}

/**
 * A hex colour as raw 0-1 channels, with no colour-space conversion.
 *
 * `new Color('#5eead4')` converts sRGB into three's linear working space, and
 * the custom shaders here never convert back - so the accent would arrive on
 * screen visibly darker than the same accent everywhere else in the app.
 * `setRGB` without a colour space stores the numbers as given.
 */
function rawColour(hex: string): Color {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0xffffff
  return new Color().setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/* ---------- the scene ---------- */

interface Label {
  el: HTMLSpanElement
  at: Vector3
  /** Pixels to shift by after projection, so a label sits beside its anchor. */
  dx: number
  dy: number
  /** Ring labels ride the near side of their ring, so they are re-anchored per frame. */
  ring?: number
  /** A height-ruler label, at this height on the ruler wherever the ruler is. */
  ruler?: number
  /** Centred on the anchor rather than starting at it. */
  centre?: boolean
  /** Ends at the anchor rather than starting at it. */
  right?: boolean
}

interface SceneState {
  renderer: WebGLRenderer
  scene: Scene
  camera: PerspectiveCamera
  controls: OrbitControls
  content: Group
  starMat: ShaderMaterial
  lineMat: ShaderMaterial
  glowMat: ShaderMaterial
  markMat: ShaderMaterial
  mark: Points
  glow: LineSegments | null
  positions: Float32Array
  sizes: Float32Array
  labels: Label[]
  /** The height scale, moved each frame to the side of the view. */
  ruler: Group | null
  /** Where the camera orbits: the cylinder looks a little above its floor, the sphere at its centre. */
  centreY: number
  /** Ask for a frame. The loop draws only when something has changed. */
  invalidate: () => void
  /** Re-fit the camera to a new shape, unless the user has moved it. */
  refit: () => void
  isolate: number
  focus: number
  /** Restart the idle turn after the usual pause. */
  resume: () => void
  dispose: () => void
}

/** Every geometry and material under a group, released. */
function disposeTree(group: Group): void {
  group.traverse((object) => {
    const mesh = object as unknown as { geometry?: BufferGeometry; material?: Material }
    mesh.geometry?.dispose()
  })
  group.clear()
}

function homeDistance(aspect: number, fov: number, sphere: boolean): number {
  const v = (fov * Math.PI) / 360
  const h = Math.atan(Math.tan(v) * aspect)
  // Fit the disc's diameter across the narrower of the two half-angles, with
  // room for the ruler and the arm names beside it, seen from about 30
  // degrees above the floor.
  const fitH = (RADIUS * 1.3) / Math.tan(h)
  const fitV = (sphere ? RADIUS * 1.22 : RADIUS * 0.66 + HEIGHT * 0.5) / Math.tan(v)
  return Math.max(fitH, fitV)
}

/**
 * Uploads one model into the scene: stars, sitting lines, guides and labels.
 *
 * Outside the component so the build is plainly a function of its inputs.
 * Returns what undoes it; the previous build's buffers are released here
 * first, inside the same context.
 */
function populate(
  state: SceneState,
  labelLayer: HTMLDivElement,
  model: Model,
  colours: string[]
): () => void {
  disposeTree(state.content)
  if (state.glow !== null) {
    state.glow.geometry.dispose()
    state.scene.remove(state.glow)
    state.glow = null
  }
  for (const label of state.labels) label.el.remove()
  state.labels = []

  const n = model.stars.length
  const positions = new Float32Array(n * 3)
  const colors = new Float32Array(n * 3)
  const sizes = new Float32Array(n)
  const bright = new Float32Array(n)
  const arms = new Float32Array(n)
  const rgb = colours.map(rawColour)
  model.stars.forEach((star, i) => {
    positions[i * 3] = star.x
    positions[i * 3 + 1] = star.y
    positions[i * 3 + 2] = star.z
    const c = rgb[star.wedge] ?? rgb[0]
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
    // World units. No output is the base size; output grows it by its
    // percentile within its own unit, never by its raw quantity.
    sizes[i] = 0.095 * (star.output === null ? 1 : 1 + star.output * 0.6)
    bright[i] = star.recency
    arms[i] = star.wedge
  })
  state.positions = positions
  state.sizes = sizes

  const starGeo = new BufferGeometry()
  starGeo.setAttribute('position', new Float32BufferAttribute(positions, 3))
  starGeo.setAttribute('color', new Float32BufferAttribute(colors, 3))
  starGeo.setAttribute('size', new Float32BufferAttribute(sizes, 1))
  starGeo.setAttribute('bright', new Float32BufferAttribute(bright, 1))
  starGeo.setAttribute('arm', new Float32BufferAttribute(arms, 1))
  const points = new Points(starGeo, state.starMat)
  points.frustumCulled = false

  // Sitting lines, coloured by the stars they join so a line between two
  // arms fades from one colour into the other.
  const lp = new Float32Array(model.links.length * 6)
  const lc = new Float32Array(model.links.length * 6)
  const la = new Float32Array(model.links.length * 2)
  model.links.forEach((link, k) => {
    for (const [slot, i] of [
      [0, link.a],
      [1, link.b]
    ] as const) {
      lp.set(positions.subarray(i * 3, i * 3 + 3), k * 6 + slot * 3)
      lc.set(colors.subarray(i * 3, i * 3 + 3), k * 6 + slot * 3)
      la[k * 2 + slot] = arms[i]
    }
  })
  const lineGeo = new BufferGeometry()
  lineGeo.setAttribute('position', new Float32BufferAttribute(lp, 3))
  lineGeo.setAttribute('color', new Float32BufferAttribute(lc, 3))
  lineGeo.setAttribute('arm', new Float32BufferAttribute(la, 1))
  const lines = new LineSegments(lineGeo, state.lineMat)
  lines.frustumCulled = false

  // Guides: the rim, a ring per period, and the height ruler. Faint and
  // white, so they read as a scale rather than as data.
  const guideMat = new ShaderMaterial({
    vertexShader: LINE_VERT,
    fragmentShader: LINE_FRAG,
    uniforms: {
      uIsolate: { value: -1 },
      uFocus: { value: 0 },
      uFogNear: state.lineMat.uniforms.uFogNear,
      uFogFar: state.lineMat.uniforms.uFogFar,
      uAlpha: { value: 0.07 }
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  })
  const circle = (radius: number, alpha = 1): LineLoop => {
    const seg = 160
    const p = new Float32Array(seg * 3)
    const c = new Float32Array(seg * 3).fill(alpha)
    for (let i = 0; i < seg; i += 1) {
      const a = (i / seg) * Math.PI * 2
      p[i * 3] = Math.cos(a) * radius
      p[i * 3 + 2] = Math.sin(a) * radius
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(p, 3))
    g.setAttribute('color', new Float32BufferAttribute(c, 3))
    g.setAttribute('arm', new Float32BufferAttribute(new Float32Array(seg), 1))
    return new LineLoop(g, guideMat)
  }
  const sphere = model.projection === 'sphere'
  const guides = new Group()
  for (const ring of model.rings) guides.add(circle(ring.radius))
  guides.add(circle(RADIUS * 1.02, 1.6))
  if (sphere) {
    // Two meridians on the outer shell, so the sphere reads as a globe
    // rather than as a disc seen from above.
    for (const turn of [0, Math.PI / 2]) {
      const meridian = circle(RADIUS * 1.02, 1.1)
      meridian.rotation.set(Math.PI / 2, turn, 0, 'YXZ')
      guides.add(meridian)
    }
  }

  /*
   * The height ruler stands just outside the rim on the right of the view and
   * is moved there every frame, so it is always beside the cloud rather than
   * in it. It was on the central axis first, which is where the oldest
   * sessions are: its labels sat on top of the core's stars.
   */
  const ticks: number[] = [0, 0, 0, 0, HEIGHT, 0]
  for (const tick of model.heightTicks) ticks.push(0, tick.y, 0, 0.3, tick.y, 0)
  const spGeo = new BufferGeometry()
  spGeo.setAttribute('position', new Float32BufferAttribute(ticks, 3))
  spGeo.setAttribute(
    'color',
    new Float32BufferAttribute(new Float32Array(ticks.length).fill(2.2), 3)
  )
  spGeo.setAttribute('arm', new Float32BufferAttribute(new Float32Array(ticks.length / 3), 1))
  const ruler = new Group()
  ruler.add(new LineSegments(spGeo, guideMat))
  // On the sphere, length is latitude: north is long, south is short, and a
  // straight ruler would be measuring nothing.
  ruler.visible = !sphere
  state.ruler = sphere ? null : ruler

  state.content.add(guides, ruler, lines, points)

  /* labels */
  // Built whole and never touched again: the positions are written per
  // frame by the scene loop, which owns them from here.
  const add = (
    text: string,
    cls: string,
    at: Vector3,
    dx: number,
    dy: number,
    extra: {
      ring?: number
      ruler?: number
      arm?: number
      colour?: string
      centre?: boolean
      right?: boolean
    } = {}
  ): void => {
    const el = document.createElement('span')
    el.className = `cst__label ${cls}`
    el.textContent = text
    el.style.opacity = '0'
    if (extra.colour !== undefined) el.style.color = extra.colour
    if (extra.arm !== undefined) el.dataset.arm = String(extra.arm)
    labelLayer.appendChild(el)
    state.labels.push({
      el,
      at,
      dx,
      dy,
      ring: extra.ring,
      ruler: extra.ruler,
      centre: extra.centre,
      right: extra.right
    })
  }
  for (const ring of model.rings) {
    add(ring.label, 'cst__label--ring', new Vector3(), 6, 2, { ring: ring.radius })
  }
  for (const tick of sphere ? [] : model.heightTicks) {
    add(tick.label, 'cst__label--tick', new Vector3(), 8, -7, { ruler: tick.y })
  }
  // Each arm is named just past the outer edge of its own stars, on its
  // centre line - not at the rim. Radius is hours, so a project that ended
  // two years ago lives well inside the disc, and a name out at the rim
  // would point at empty space.
  const outer = model.wedges.map(() => [] as number[])
  for (const star of model.stars) outer[star.wedge]?.push(star.radial)
  model.wedges.forEach((wedge, i) => {
    const radials = outer[i].sort((a, b) => a - b)
    const edge = radials.length === 0 ? 1 : radials[Math.floor((radials.length - 1) * 0.92)]
    const a = wedge.start + wedge.width / 2 + TWIST * edge
    const r = edge * RADIUS + 0.9
    add(wedge.label, 'cst__label--arm', new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), 0, -8, {
      arm: i,
      colour: colours[i],
      centre: true
    })
  })

  state.refit()
  // Compile the shaders now, while the panel is usually still below the fold,
  // so the first frame after it scrolls into view is not also the frame that
  // waits on the driver's compiler.
  state.renderer.compile(state.scene, state.camera)
  state.invalidate()
  // The guide material belongs to this build, so it goes with it.
  return () => guideMat.dispose()
}

export interface ConstellationProps {
  /** Every counted session, and the clock numbers beside them - see `starRows`. */
  sessionRows: SessionRow[]
  clock: number[]
  /**
   * The range, as dates rather than a filtered array. A filtered array is a
   * new object on every render of the tab, and the cloud is memoised on its
   * inputs: handed one, it rebuilt and re-uploaded every buffer each time
   * anything on the page changed.
   */
  from: string | null
  to: string | null
  accent: string
  control: React.ReactNode
  /** Hidden projects as JSON text; null is the automatic view. See `projectChoices`. */
  hiddenProjects?: string | null
  onHiddenProjects?: (next: string[] | null) => void
}

export default function Constellation({
  sessionRows,
  clock,
  from,
  to,
  accent,
  control,
  hiddenProjects = null,
  onHiddenProjects
}: ConstellationProps): React.JSX.Element {
  const hidden = useMemo<string[] | null>(() => {
    if (hiddenProjects === null) return null
    try {
      const parsed: unknown = JSON.parse(hiddenProjects)
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : null
    } catch {
      return null
    }
  }, [hiddenProjects])
  const all = useMemo(() => starRows(sessionRows, clock), [sessionRows, clock])
  const rows = useMemo(
    () =>
      all.filter((row) => (from === null || row.date >= from) && (to === null || row.date <= to)),
    [all, from, to]
  )
  /*
   * Disc or sphere: one switch, see `Projection`. Remembered per viewer in
   * localStorage - it is a way of looking, not a setting the app acts on -
   * and every read is guarded, because storage can throw or come back empty.
   */
  const [projection, setProjectionState] = useState<Projection>(() => {
    try {
      const stored = window.localStorage.getItem(SHAPE_KEY)
      return stored === 'sphere' ? 'sphere' : 'cylinder'
    } catch {
      return 'cylinder'
    }
  })
  const setProjection = (next: Projection): void => {
    setProjectionState(next)
    try {
      window.localStorage.setItem(SHAPE_KEY, next)
    } catch {
      // A shape that is not remembered is still the shape on screen.
    }
  }
  const model = useMemo(
    () => buildConstellation(rows, all, projection, hidden),
    [rows, all, projection, hidden]
  )

  /*
   * The Projects list: every project with sessions in range, most hours
   * first, ticked if it is an arm of its own. In-app, never a Windows
   * dialog - see "The app speaks for itself".
   */
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const pickerRef = useRef<HTMLDivElement>(null)
  const choices = useMemo(() => projectChoices(rows, hidden), [rows, hidden])
  const shownChoices = choices.filter((c) =>
    c.name.toLowerCase().includes(query.trim().toLowerCase())
  )
  const setShown = (name: string, shown: boolean): void =>
    onHiddenProjects?.(withProjectShown(hidden, rows, all, name, shown))
  useEffect(() => {
    if (!picking) return
    const away = (event: PointerEvent): void => {
      if (pickerRef.current?.contains(event.target as Node) !== true) setPicking(false)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPicking(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
  }, [picking])
  const ranks = useMemo(() => colourRanks(all), [all])
  const colours = useMemo(() => armColours(model.wedges, accent, ranks), [model, accent, ranks])
  // The arm's own colour where the project is an arm, so the list and the
  // legend agree; its natural colour where it is pooled or hidden.
  const colourOf = (name: string): string => {
    const at = model.wedges.findIndex((w) => !w.other && w.projects.includes(name))
    return at === -1 ? projectColour(ranks.get(name) ?? 0, accent) : colours[at]
  }

  const stageRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneState | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  /*
   * Hover and isolation are indices into this model's stars and arms, so they
   * are stored with the model they index. A range change builds a new model,
   * and a stale index would name a different star or arm in it - keyed like
   * this, it simply stops applying, with no effect needed to clear it.
   */
  const [isolatedAt, setIsolatedAt] = useState<{ model: Model; index: number } | null>(null)
  const [hoverAt, setHoverAt] = useState<{ model: Model; index: number } | null>(null)
  const isolated = isolatedAt !== null && isolatedAt.model === model ? isolatedAt.index : null
  const hover = hoverAt !== null && hoverAt.model === model ? hoverAt.index : null
  const [hint, setHint] = useState(false)
  const [full, setFull] = useState(false)

  // Read inside long-lived listeners through refs, so the scene is not torn
  // down and rebuilt every time one of them changes.
  const modelRef = useRef<Model>(model)
  const hoverRef = useRef<number | null>(null)
  const isolatedRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    modelRef.current = model
    hoverRef.current = hover
    isolatedRef.current = isolated
  })
  const setHover = (index: number | null): void =>
    setHoverAt(index === null ? null : { model: modelRef.current, index })
  const setIsolated = (index: number | null): void =>
    setIsolatedAt(index === null ? null : { model: modelRef.current, index })

  /* The scene: created once per mount, disposed on unmount. */
  useEffect(() => {
    const stage = stageRef.current
    const labelLayer = labelsRef.current
    if (stage === null || labelLayer === null) return

    let renderer: WebGLRenderer
    try {
      // No MSAA: every mark here is a soft sprite or a faint additive line,
      // and neither shows stair-steps at these alphas - so the multisample
      // buffer would be cost with nothing to show for it.
      renderer = new WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance'
      })
    } catch (error) {
      // Once, at mount, and only on failure: the panel has to say why it is
      // blank, and the only place the reason exists is this catch.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailure(error instanceof Error ? error.message : String(error))
      return
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Capped at 1.5: on a 2x screen that is 44% fewer pixels to fill than
    // native, and soft points do not get sharper past it.
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
    renderer.setPixelRatio(pixelRatio)
    renderer.setClearColor(rawColour(STAGE_BG), 1)
    stage.prepend(renderer.domElement)

    const scene = new Scene()
    const camera = new PerspectiveCamera(42, 1, 0.1, 400)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, TARGET_Y, 0)
    controls.enableDamping = !reduced
    controls.dampingFactor = 0.08
    controls.rotateSpeed = 0.6
    controls.zoomSpeed = 0.7
    controls.enablePan = false
    controls.enableZoom = false
    controls.minDistance = RADIUS * 0.35
    controls.maxDistance = RADIUS * 6
    controls.maxPolarAngle = Math.PI * 0.62
    controls.autoRotate = !reduced
    controls.autoRotateSpeed = 0.32

    const common = {
      uIsolate: { value: -1 },
      uFocus: { value: 0 },
      uFogNear: { value: 10 },
      uFogFar: { value: 40 }
    }
    const starMat = new ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: {
        ...common,
        uScale: { value: 600 },
        uPixelRatio: { value: pixelRatio },
        uTime: { value: 0 },
        uWave: { value: -5 }
      },
      // Ordinary alpha blending, not additive: overlapping points keep their
      // colour instead of summing towards white, so a dense arm reads as
      // dense rather than as a hot spot.
      transparent: true,
      depthWrite: false,
      blending: NormalBlending
    })
    // Shared uniform objects, so one write moves stars and lines together.
    const lineMat = new ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: { ...common, uAlpha: { value: 0.075 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
    const glowMat = new ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: {
        uIsolate: { value: -1 },
        uFocus: { value: 0 },
        uFogNear: common.uFogNear,
        uFogFar: common.uFogFar,
        uAlpha: { value: 0.75 }
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
    const markMat = new ShaderMaterial({
      vertexShader: MARK_VERT,
      fragmentShader: MARK_FRAG,
      uniforms: {
        uColor: { value: rawColour('#ffffff') },
        uSize: { value: 22 },
        uPixelRatio: { value: pixelRatio }
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending
    })
    const markGeo = new BufferGeometry()
    markGeo.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3))
    const mark = new Points(markGeo, markMat)
    mark.visible = false
    mark.renderOrder = 10
    scene.add(mark)

    const content = new Group()
    scene.add(content)

    /*
     * Dust: one small draw call, built once, kept very faint. The
     * dust is on a far shell and never moves, so turning the camera makes
     * it slide behind the cloud - which is what makes the cloud read as
     * standing in space rather than painted on a black card.
     */
    const dustN = 500
    const dustPos = new Float32Array(dustN * 3)
    const dustBright = new Float32Array(dustN)
    for (let i = 0; i < dustN; i += 1) {
      const u = (Math.sin(i * 12.9898) * 43758.5453) % 1
      const v = (Math.sin(i * 78.233) * 12345.6789) % 1
      const w = (Math.sin(i * 39.425) * 24634.6345) % 1
      const theta = Math.abs(u) * Math.PI * 2
      const phi = Math.acos(Math.abs(v) * 2 - 1)
      const r = RADIUS * (4 + Math.abs(w) * 4)
      dustPos[i * 3] = Math.sin(phi) * Math.cos(theta) * r
      dustPos[i * 3 + 1] = Math.cos(phi) * r
      dustPos[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r
      dustBright[i] = 0.15 + Math.pow(Math.abs(w * u), 2) * 0.85
    }
    const dustGeo = new BufferGeometry()
    dustGeo.setAttribute('position', new Float32BufferAttribute(dustPos, 3))
    dustGeo.setAttribute('bright', new Float32BufferAttribute(dustBright, 1))
    const dustMat = new ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: { uPixelRatio: { value: pixelRatio } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending
    })
    const dust = new Points(dustGeo, dustMat)
    dust.frustumCulled = false
    scene.add(dust)

    const state: SceneState = {
      renderer,
      scene,
      camera,
      controls,
      content,
      starMat,
      lineMat,
      glowMat,
      markMat,
      mark,
      glow: null,
      positions: new Float32Array(0),
      sizes: new Float32Array(0),
      labels: [],
      ruler: null,
      centreY: TARGET_Y,
      invalidate: () => undefined,
      refit: () => undefined,
      isolate: -1,
      focus: 0,
      resume: () => undefined,
      dispose: () => undefined
    }
    sceneRef.current = state
    // Declared before anything that can ask for a frame: the first resize
    // below already does.
    let visible = false
    let frame = 0

    /* size and framing */
    let interacted = false
    const home = (): void => {
      const sphere = modelRef.current.projection === 'sphere'
      const d = homeDistance(camera.aspect, camera.fov, sphere)
      const elevation = ((sphere ? 22 : 31) * Math.PI) / 180
      const azimuth = (-58 * Math.PI) / 180
      camera.position.set(
        Math.cos(azimuth) * Math.cos(elevation) * d,
        state.centreY + Math.sin(elevation) * d,
        Math.sin(azimuth) * Math.cos(elevation) * d
      )
      controls.target.set(0, state.centreY, 0)
      controls.maxPolarAngle = sphere ? Math.PI : Math.PI * 0.62
      controls.update()
      controls.saveState()
      invalidate()
    }
    state.refit = () => {
      state.centreY = modelRef.current.centreY
      if (!interacted) home()
      else {
        controls.target.set(0, state.centreY, 0)
        invalidate()
      }
    }
    const resize = (): void => {
      const w = Math.max(1, stage.clientWidth)
      const h = Math.max(1, stage.clientHeight)
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      // Sizes are in world units: this turns them into pixels at distance 1.
      starMat.uniforms.uScale.value = h / (2 * Math.tan((camera.fov * Math.PI) / 360))
      if (!interacted) home()
      invalidate()
    }
    resize()
    const sizer = new ResizeObserver(resize)
    sizer.observe(stage)

    /* idle turning */
    let resumeTimer = 0
    const pauseTurn = (): void => {
      interacted = true
      controls.autoRotate = false
      window.clearTimeout(resumeTimer)
    }
    const scheduleResume = (): void => {
      window.clearTimeout(resumeTimer)
      if (reduced) return
      resumeTimer = window.setTimeout(() => {
        if (hoverRef.current === null) {
          controls.autoRotate = true
          invalidate()
        }
      }, IDLE_RESUME_MS)
    }
    controls.addEventListener('start', pauseTurn)
    controls.addEventListener('end', scheduleResume)
    state.resume = scheduleResume

    /* wheel engagement */
    let hintTimer = 0
    const engage = (): void => {
      controls.enableZoom = true
    }
    const disengage = (): void => {
      if (document.fullscreenElement !== stage) controls.enableZoom = false
    }
    const onWheelIdle = (event: WheelEvent): void => {
      if (controls.enableZoom) return
      // Ctrl+wheel is the browser's page zoom elsewhere; here it means the
      // same thing the wheel will mean once the cloud is clicked.
      if (event.ctrlKey) {
        engage()
        return
      }
      setHint(true)
      window.clearTimeout(hintTimer)
      hintTimer = window.setTimeout(() => setHint(false), 1600)
    }
    renderer.domElement.addEventListener('pointerdown', engage)
    renderer.domElement.addEventListener('pointerleave', disengage)
    renderer.domElement.addEventListener('wheel', onWheelIdle, { passive: true, capture: true })

    /* hover picking, in screen space */
    const projected = new Vector3()
    let pointer: { x: number; y: number } | null = null
    let pickQueued = false
    let dragging = false
    controls.addEventListener('start', () => (dragging = true))
    controls.addEventListener('end', () => (dragging = false))
    const pick = (): void => {
      pickQueued = false
      const m = modelRef.current
      if (pointer === null || dragging) {
        if (hoverRef.current !== null) setHover(null)
        return
      }
      const w = stage.clientWidth
      const h = stage.clientHeight
      const iso = isolatedRef.current
      let best = -1
      let bestScore = Infinity
      const pos = state.positions
      const sizes = state.sizes
      const scale = starMat.uniforms.uScale.value as number
      for (let i = 0; i < m.stars.length; i += 1) {
        if (iso !== null && m.stars[i].wedge !== iso) continue
        projected.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).project(camera)
        if (projected.z > 1) continue
        const sx = ((projected.x + 1) / 2) * w
        const sy = ((1 - projected.y) / 2) * h
        const dx = sx - pointer.x
        const dy = sy - pointer.y
        const d2 = dx * dx + dy * dy
        // Generous for small stars, which are the hard ones to land on.
        const ex = pos[i * 3] - camera.position.x
        const ey = pos[i * 3 + 1] - camera.position.y
        const ez = pos[i * 3 + 2] - camera.position.z
        const depth = Math.sqrt(ex * ex + ey * ey + ez * ez)
        const radius = Math.max(7, (sizes[i] * scale) / depth / 3)
        if (d2 <= radius * radius && d2 < bestScore) {
          bestScore = d2
          best = i
        }
      }
      const next = best === -1 ? null : best
      if (next !== hoverRef.current) setHover(next)
      placeTip()
    }
    const placeTip = (): void => {
      const tip = tipRef.current
      if (tip === null || pointer === null) return
      const w = stage.clientWidth
      const h = stage.clientHeight
      const tw = tip.offsetWidth
      const th = tip.offsetHeight
      let x = pointer.x + 16
      let y = pointer.y + 14
      if (x + tw > w - 8) x = pointer.x - tw - 16
      if (y + th > h - 8) y = pointer.y - th - 14
      tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`
    }
    const onMove = (event: PointerEvent): void => {
      const box = stage.getBoundingClientRect()
      pointer = { x: event.clientX - box.left, y: event.clientY - box.top }
      if (!pickQueued) {
        pickQueued = true
        requestAnimationFrame(pick)
      }
    }
    const onLeave = (): void => {
      pointer = null
      setHover(null)
    }
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerleave', onLeave)

    /* double-click: back to the opening view */
    const onDouble = (): void => {
      interacted = false
      controls.reset()
      home()
      setIsolated(null)
      if (!reduced) controls.autoRotate = true
      invalidate()
    }
    renderer.domElement.addEventListener('dblclick', onDouble)

    /* fullscreen */
    const onFullscreen = (): void => {
      const on = document.fullscreenElement === stage
      setFull(on)
      controls.enableZoom = on
      invalidate()
    }
    document.addEventListener('fullscreenchange', onFullscreen)

    /*
     * The loop: drawn on demand, and only while it can be seen.
     *
     * A frame is drawn when something asks for one (`invalidate`) and the
     * loop keeps going only while there is motion to show - the idle turn,
     * damping settling after a drag, or isolation easing. A still cloud
     * draws nothing at all. Off screen (IntersectionObserver), with the
     * window hidden or minimised (`document.hidden`), or with another tab
     * open (the panel is unmounted) it draws nothing either.
     */
    const seen = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting)
      if (visible) invalidate()
    })
    seen.observe(stage)
    const onVisibility = (): void => {
      if (!document.hidden) invalidate()
    }
    document.addEventListener('visibilitychange', onVisibility)
    controls.addEventListener('change', () => invalidate())

    let last = 0
    let clock = 0
    let drawn = 0
    let firstFrameAt: number | null = null
    const mountedAt = performance.now()
    // CPU cost and the interval between frames, the last 600 of each.
    const costs: number[] = []
    const gaps: number[] = []
    function invalidate(): void {
      if (frame === 0 && visible && !document.hidden) {
        frame = requestAnimationFrame(tick)
      }
    }
    state.invalidate = invalidate
    function tick(now: number): void {
      // -1 while drawing, so a request made during this frame - the controls
      // fire 'change' from inside update() - is satisfied by this frame
      // rather than queueing a second one. Without it every frame scheduled
      // two, and the count doubled each frame.
      frame = -1
      if (!visible || document.hidden) {
        frame = 0
        return
      }
      const t0 = performance.now()
      const dt = last === 0 ? 1 / 60 : Math.min(0.1, (now - last) / 1000)
      if (last !== 0 && now - last < 200) {
        gaps.push(now - last)
        if (gaps.length > 600) gaps.shift()
      }
      last = now

      const turning = controls.autoRotate && !reduced
      if (turning) clock += dt
      starMat.uniforms.uTime.value = clock
      // The swell runs every eleven seconds while the cloud turns, and is
      // simply absent from a still frame.
      starMat.uniforms.uWave.value = turning ? ((clock / 11) % 1) * 1.5 - 0.25 : -5

      // Isolation eases in and out rather than snapping, unless motion is reduced.
      const target = state.isolate >= 0 ? 1 : 0
      state.focus = reduced ? target : state.focus + (target - state.focus) * Math.min(1, dt * 7)
      if (Math.abs(target - state.focus) < 0.002) state.focus = target
      if (state.isolate >= 0) common.uIsolate.value = state.isolate
      else if (state.focus === 0) common.uIsolate.value = -1
      common.uFocus.value = state.focus

      const moved = controls.update(dt)
      const dist = camera.position.distanceTo(controls.target)
      common.uFogNear.value = dist - RADIUS * 0.4
      common.uFogFar.value = dist + RADIUS * 1.3

      placeRuler()
      renderer.render(scene, camera)
      placeLabels()
      drawn += 1
      if (firstFrameAt === null) firstFrameAt = performance.now()
      costs.push(performance.now() - t0)
      if (costs.length > 600) costs.shift()

      if (turning || moved || state.focus !== target) {
        frame = requestAnimationFrame(tick)
      } else {
        frame = 0
        last = 0
      }
    }

    /**
     * The ruler to the right of the disc as the viewer sees it. Right, not
     * left: the legend sits in the top-left corner and covered the ruler's
     * top label at 1150px.
     */
    const placeRuler = (): void => {
      if (state.ruler === null) return
      const az = Math.atan2(camera.position.z, camera.position.x)
      const r = RADIUS * 1.1
      state.ruler.position.set(Math.sin(az) * r, 0, -Math.cos(az) * r)
      // Ticks point away from the cloud, towards the labels.
      state.ruler.rotation.y = Math.PI / 2 - az
    }

    const placeLabels = (): void => {
      const w = stage.clientWidth
      const h = stage.clientHeight
      const az = Math.atan2(camera.position.z, camera.position.x)
      const rulerAt = state.ruler?.position
      for (const label of state.labels) {
        // Ring labels ride the side of each ring nearest the viewer, so they
        // stay readable from any angle.
        if (label.ring !== undefined) {
          label.at.set(Math.cos(az) * label.ring, 0, Math.sin(az) * label.ring)
        }
        if (label.ruler !== undefined && rulerAt !== undefined) {
          label.at.set(rulerAt.x, label.ruler, rulerAt.z)
        }
        projected.copy(label.at).project(camera)
        if (projected.z > 1) {
          label.el.style.opacity = '0'
          continue
        }
        const x = ((projected.x + 1) / 2) * w + label.dx
        const y = ((1 - projected.y) / 2) * h + label.dy
        const shift =
          label.centre === true
            ? ' translateX(-50%)'
            : label.right === true
              ? ' translateX(-100%)'
              : ''
        label.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)${shift}`
        // Labels on the far side of the cloud recede with the stars there.
        const depth = camera.position.distanceTo(label.at)
        const fogNear = common.uFogNear.value
        const fogFar = common.uFogFar.value
        const f = Math.min(1, Math.max(0, (depth - fogNear) / (fogFar - fogNear)))
        const dim =
          label.el.dataset.arm !== undefined && state.isolate >= 0
            ? Number(label.el.dataset.arm) === state.isolate
              ? 1
              : 0.15
            : 1
        label.el.style.opacity = String((1 - 0.7 * f) * dim)
      }
    }

    invalidate()

    /*
     * Two hooks for `scripts/shoot.ts`, on the element rather than on window
     * so they vanish with it. `constellationStill` stops the idle turn, so a
     * screenshot is of a known angle. `constellationBench(n)` renders n
     * frames back to back and reads a pixel after each, which waits for the
     * GPU to finish - the true cost of a frame, not the time to queue one -
     * and reports the renderer's own count of live buffers, which is how a
     * leak across range changes would show. Nothing in the app calls either.
     */
    Object.defineProperty(stage, 'constellationStill', {
      configurable: true,
      value: () => {
        interacted = true
        controls.autoRotate = false
        invalidate()
      }
    })
    Object.defineProperty(stage, 'constellationStats', {
      configurable: true,
      value: (reset?: boolean) => {
        const pct = (list: number[], q: number): number | null => {
          if (list.length === 0) return null
          const sorted = [...list].sort((x, y) => x - y)
          return Number(
            sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(2)
          )
        }
        const out = {
          drawn,
          turning: controls.autoRotate,
          cpuMedian: pct(costs, 0.5),
          cpuP95: pct(costs, 0.95),
          gapMedian: pct(gaps, 0.5),
          gapP95: pct(gaps, 0.95),
          firstFrameMs:
            firstFrameAt === null ? null : Number((firstFrameAt - mountedAt).toFixed(1)),
          firstFrameAt,
          calls: renderer.info.render.calls,
          geometries: renderer.info.memory.geometries,
          pixelRatio
        }
        if (reset === true) {
          costs.length = 0
          gaps.length = 0
        }
        return out
      }
    })
    Object.defineProperty(stage, 'constellationBench', {
      configurable: true,
      value: (n: number) => {
        const gl = renderer.getContext()
        const pixel = new Uint8Array(4)
        const t0 = performance.now()
        for (let i = 0; i < n; i += 1) {
          renderer.render(scene, camera)
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        }
        const ms = (performance.now() - t0) / Math.max(1, n)
        return {
          msPerFrame: Number(ms.toFixed(3)),
          geometries: renderer.info.memory.geometries,
          programs: renderer.info.programs?.length ?? null,
          stars: modelRef.current.stars.length,
          links: modelRef.current.links.length,
          width: renderer.domElement.width,
          height: renderer.domElement.height
        }
      }
    })

    state.dispose = () => {
      if (frame > 0) cancelAnimationFrame(frame)
      frame = -1
      window.clearTimeout(resumeTimer)
      window.clearTimeout(hintTimer)
      sizer.disconnect()
      seen.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('fullscreenchange', onFullscreen)
      renderer.domElement.removeEventListener('pointerdown', engage)
      renderer.domElement.removeEventListener('pointerleave', disengage)
      renderer.domElement.removeEventListener('wheel', onWheelIdle, { capture: true })
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      renderer.domElement.removeEventListener('dblclick', onDouble)
      controls.dispose()
      disposeTree(content)
      state.glow?.geometry.dispose()
      markGeo.dispose()
      dustGeo.dispose()
      for (const mat of [starMat, lineMat, glowMat, markMat, dustMat]) mat.dispose()
      renderer.dispose()
      // Release the context now rather than when the garbage collector gets
      // round to the canvas - the sixteen-context cap counts live ones.
      renderer.forceContextLoss()
      renderer.domElement.remove()
      for (const label of state.labels) label.el.remove()
      state.labels = []
    }
    return () => {
      state.dispose()
      sceneRef.current = null
    }
  }, [])

  /* The geometry: rebuilt when the range or the accent changes, same context. */
  useEffect(() => {
    const state = sceneRef.current
    const labelLayer = labelsRef.current
    if (state === null || labelLayer === null) return
    return populate(state, labelLayer, model, colours)
  }, [model, colours])

  /* Isolation goes to the shaders through the scene state, eased per frame. */
  useEffect(() => {
    const state = sceneRef.current
    if (state === null) return
    state.isolate = isolated ?? -1
    state.invalidate()
  }, [isolated])

  /* The hovered star's ring and its sitting, drawn bright. */
  useEffect(() => {
    const state = sceneRef.current
    if (state === null) return
    if (state.glow !== null) {
      state.glow.geometry.dispose()
      state.scene.remove(state.glow)
      state.glow = null
    }
    stageRef.current?.classList.toggle('is-hovering', hover !== null)
    if (hover === null || hover >= model.stars.length) {
      state.mark.visible = false
      state.invalidate()
      // The turn waits while a star is being read, and picks up again after
      // the same pause as any other interaction - not the instant the
      // pointer slips off.
      state.resume()
      return
    }
    state.controls.autoRotate = false
    const star = model.stars[hover]
    const pos = state.mark.geometry.getAttribute('position') as Float32BufferAttribute
    pos.setXYZ(0, star.x, star.y, star.z)
    pos.needsUpdate = true
    const c = rawColour(colours[star.wedge] ?? '#ffffff')
    state.markMat.uniforms.uColor.value = c
    state.mark.visible = true

    // The whole sitting this star belongs to: every star reachable through
    // links, then every link inside that set.
    const adjacent = new Map<number, number[]>()
    const join = (from: number, to: number): void => {
      const list = adjacent.get(from)
      if (list === undefined) adjacent.set(from, [to])
      else list.push(to)
    }
    for (const l of model.links) {
      join(l.a, l.b)
      join(l.b, l.a)
    }
    const sitting = new Set<number>([hover])
    const queue = [hover]
    while (queue.length > 0) {
      const i = queue.pop() as number
      for (const j of adjacent.get(i) ?? []) {
        if (sitting.has(j)) continue
        sitting.add(j)
        queue.push(j)
      }
    }
    const segs: number[] = []
    const cols: number[] = []
    for (const l of model.links) {
      if (!sitting.has(l.a) || !sitting.has(l.b)) continue
      const a = model.stars[l.a]
      const b = model.stars[l.b]
      segs.push(a.x, a.y, a.z, b.x, b.y, b.z)
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
    if (segs.length > 0) {
      const g = new BufferGeometry()
      g.setAttribute('position', new Float32BufferAttribute(segs, 3))
      g.setAttribute('color', new Float32BufferAttribute(cols, 3))
      g.setAttribute('arm', new Float32BufferAttribute(new Float32Array(segs.length / 3), 1))
      state.glow = new LineSegments(g, state.glowMat)
      state.glow.frustumCulled = false
      state.scene.add(state.glow)
    }
    state.invalidate()
  }, [hover, model, colours])

  const toggleFull = (): void => {
    const stage = stageRef.current
    if (stage === null) return
    if (document.fullscreenElement === stage) void document.exitFullscreen()
    else void stage.requestFullscreen().catch(() => undefined)
  }

  const star = hover === null ? null : (model.stars[hover] ?? null)
  const sessions = model.stars.length
  const sub = `${sessions.toLocaleString('en-US')} sessions · ${hoursShort(model.totalHours)}`
  const ringWord = { year: 'year', quarter: 'quarter', month: 'month', week: 'week', day: 'day' }[
    model.ringGrain
  ]

  return (
    <div className="ac an-panel cst">
      <style>{CSS}</style>
      <div className="an-panel__head">
        <h4 className="an-panel__title">
          Constellation
          <span className="an-panel__sub">{sub}</span>
        </h4>
        <span className="cst__aside">
          <span className="cst__picker" ref={pickerRef}>
            <button
              type="button"
              className={`cst__pick${picking ? ' is-on' : ''}`}
              aria-expanded={picking}
              onClick={() => setPicking(!picking)}
            >
              Projects
              {hidden !== null ? (
                <span className="cst__pick-count">
                  {choices.filter((c) => c.shown).length}/{choices.length}
                </span>
              ) : null}
            </button>
            {picking ? (
              <div className="cst__menu" role="dialog" aria-label="Projects shown">
                <input
                  className="cst__search"
                  type="search"
                  placeholder="Search projects"
                  value={query}
                  autoFocus
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div className="cst__menu-actions">
                  <button type="button" onClick={() => onHiddenProjects?.(showAllProjects())}>
                    All
                  </button>
                  <button type="button" onClick={() => onHiddenProjects?.(hideAllProjects(all))}>
                    None
                  </button>
                  <button
                    type="button"
                    disabled={hidden === null}
                    title="The largest projects, with the rest grouped as Other"
                    onClick={() => onHiddenProjects?.(null)}
                  >
                    Automatic
                  </button>
                </div>
                <div className="cst__menu-list">
                  {shownChoices.map((choice) => (
                    <label key={choice.name} className="cst__choice">
                      <input
                        type="checkbox"
                        checked={choice.shown}
                        onChange={(event) => setShown(choice.name, event.target.checked)}
                      />
                      <i className="cst__dot" style={{ background: colourOf(choice.name) }} />
                      <span className="cst__arm-name">{choice.name}</span>
                      <span className="cst__arm-hours">{hoursShort(choice.hours)}</span>
                    </label>
                  ))}
                  {shownChoices.length === 0 ? (
                    <p className="cst__menu-note">No project matches.</p>
                  ) : null}
                </div>
                <p className="cst__menu-note">
                  {hidden === null
                    ? 'Automatic: unticked projects are grouped as Other.'
                    : 'Unticked projects are hidden.'}
                </p>
              </div>
            ) : null}
          </span>
          <span className="cst__shape" role="group" aria-label="Shape">
            {PROJECTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                className={projection === option.id ? 'is-on' : ''}
                aria-pressed={projection === option.id}
                onClick={() => setProjection(option.id)}
              >
                {option.label}
              </button>
            ))}
          </span>
          {control}
          <button
            type="button"
            className="cst__btn"
            title={full ? 'Leave fullscreen' : 'Fullscreen'}
            aria-label={full ? 'Leave fullscreen' : 'Fullscreen'}
            onClick={toggleFull}
          >
            <FullIcon out={full} />
          </button>
        </span>
      </div>

      <div className="cst__stage" ref={stageRef} tabIndex={-1}>
        {/* The canvas is prepended here by the scene effect, so everything
            below is declared after it and sits on top of it. */}
        <div className="cst__vignette" />
        <div className="cst__labels" ref={labelsRef} />
        {failure !== null ? (
          <div className="cst__empty">
            This panel draws with WebGL, and this computer&apos;s graphics driver refused it:{' '}
            {failure}
          </div>
        ) : sessions === 0 ? (
          <div className="cst__empty">
            {hidden !== null && choices.length > 0
              ? 'Every project in this range is hidden. Open Projects to show some.'
              : 'No sessions in this range.'}
          </div>
        ) : null}
        <div className="cst__legend">
          {model.wedges.map((wedge, i) => (
            <button
              type="button"
              key={wedge.key}
              className={`cst__arm${isolated === i ? ' is-on' : isolated !== null ? ' is-dim' : ''}`}
              title={
                wedge.other
                  ? `${wedge.projects.join(', ')} - click to show only these`
                  : `${wedge.label}: ${wedge.sessions.toLocaleString('en-US')} sessions - click to show only this project`
              }
              onClick={() => setIsolated(isolated === i ? null : i)}
            >
              <i
                className="cst__dot"
                style={{ background: colours[i], boxShadow: `0 0 8px ${colours[i]}` }}
              />
              <span className="cst__arm-name">{wedge.label}</span>
              <span className="cst__arm-hours">{hoursShort(wedge.hours)}</span>
            </button>
          ))}
        </div>
        <div className="cst__title">
          <b>Constellation</b>
          <span>{sub}</span>
        </div>
        <div className={`cst__hint${hint ? ' is-on' : ''}`}>
          Click the cloud, then scroll to zoom
        </div>
        <div
          className="cst__tip"
          ref={tipRef}
          style={{ visibility: star === null ? 'hidden' : 'visible' }}
        >
          {star === null ? null : (
            <ChartTip
              active
              payload={[{}]}
              when={() => {
                const project = model.wedges[star.wedge]?.other
                  ? (star.row.project ?? 'Unlabelled')
                  : model.wedges[star.wedge]?.label
                const time = star.row.startMs === null ? '' : `, ${clockTime(star.row.startMs)}`
                return `${formatDate(star.row.date)}${time} · ${project}`
              }}
              rows={() => {
                const lines = [{ name: star.row.task ?? '', value: duration(star.row.runningS) }]
                if (star.row.quantity !== null && star.row.unit !== null) {
                  lines.push({
                    name: 'Output',
                    value: `${formatCount(star.row.quantity)} ${pluralUnit(star.row.unit, star.row.quantity)}`
                  })
                }
                return lines
              }}
            />
          )}
        </div>
        <button
          type="button"
          className="cst__btn cst__exit"
          title="Leave fullscreen"
          aria-label="Leave fullscreen"
          onClick={toggleFull}
        >
          <FullIcon out />
        </button>
      </div>

      <p className="an-panel__note">
        Every point is a session. <b>Distance from the centre</b> is time: the first session at the
        core, the end of the range at the rim, counted in hours of work rather than in days - so
        each ring marks where a {ringWord} began, and a wide band is a busy one. <b>Angle</b> is the
        project, each arm as wide as its share of the hours in this range;{' '}
        {projection === 'sphere' ? (
          <>
            <b>latitude</b> is session length - short in the south, long in the north.
          </>
        ) : (
          <>
            <b>height</b> is session length, on a log scale.
          </>
        )}{' '}
        Size is output, ranked only against sessions in the same unit, and brightness is recency.
        Lines join one sitting: the same day with under {SITTING_GAP_MINUTES} minutes between
        sessions, or - for imported rows, which have no clock times - consecutive rows of the same
        day and project. Drag to turn, double-click to reset, click a project to isolate it.
      </p>
    </div>
  )
}

function FullIcon({ out }: { out: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      {out ? (
        <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
      ) : (
        <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
      )}
    </svg>
  )
}
