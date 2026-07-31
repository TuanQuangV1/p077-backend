/**
 * Deterministic rosbag replay generator.
 *
 * Produces the same payload shape a FastAPI endpoint would return after
 * decoding /map, /amcl_pose, /scan and /odom out of an .mcap file:
 *   GET /api/analysis/{runId}/simulation
 *
 * Grid convention: rows[j] is the cell row at y = j * resolution,
 * i.e. rows[0] is the bottom of the map in world coordinates.
 */

import type { AnomalyKind, OccupancyMap, SimFrame, SimulationData } from "@/lib/types"
import { data, rng } from "@/lib/server/store"

const RES = 0.1
const W_M = 20
const H_M = 12
const WIDTH = Math.round(W_M / RES) // 200
const HEIGHT = Math.round(H_M / RES) // 120

const SCAN_RAYS = 48
const ANGLE_MIN = (-135 * Math.PI) / 180
const ANGLE_MAX = (135 * Math.PI) / 180
const RANGE_MAX = 8
const HZ = 10

const SHELF_BANDS: [number, number][] = [
  [1.2, 3.0],
  [9.0, 10.8],
]
const SHELF_BLOCKS: [number, number][] = [
  [2, 5],
  [6, 9],
  [10, 13],
  [14, 17],
]
/** Free-standing pallets that make the corridor interesting. */
const PALLETS: [number, number, number, number][] = [
  [7.4, 5.2, 0.9, 0.9],
  [12.8, 6.9, 1.1, 0.7],
  [16.2, 5.4, 0.7, 0.7],
]

function buildMap(): { map: OccupancyMap; grid: Uint8Array } {
  const grid = new Uint8Array(WIDTH * HEIGHT)
  const set = (cx: number, cy: number) => {
    if (cx >= 0 && cx < WIDTH && cy >= 0 && cy < HEIGHT) grid[cy * WIDTH + cx] = 1
  }
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let cy = Math.floor(y0 / RES); cy < Math.ceil(y1 / RES); cy++) {
      for (let cx = Math.floor(x0 / RES); cx < Math.ceil(x1 / RES); cx++) set(cx, cy)
    }
  }

  // outer walls (0.2 m thick)
  fill(0, 0, W_M, 0.2)
  fill(0, H_M - 0.2, W_M, H_M)
  fill(0, 0, 0.2, H_M)
  fill(W_M - 0.2, 0, W_M, H_M)

  for (const [y0, y1] of SHELF_BANDS) {
    for (const [x0, x1] of SHELF_BLOCKS) fill(x0, y0, x1, y1)
  }
  for (const [x, y, w, h] of PALLETS) fill(x, y, x + w, y + h)

  const rows: string[] = []
  for (let cy = 0; cy < HEIGHT; cy++) {
    let row = ""
    for (let cx = 0; cx < WIDTH; cx++) row += grid[cy * WIDTH + cx] ? "1" : "0"
    rows.push(row)
  }
  return { map: { width: WIDTH, height: HEIGHT, resolution: RES, rows }, grid }
}

const { map: MAP, grid: GRID } = buildMap()

function occupied(x: number, y: number) {
  const cx = Math.floor(x / RES)
  const cy = Math.floor(y / RES)
  if (cx < 0 || cy < 0 || cx >= WIDTH || cy >= HEIGHT) return true
  return GRID[cy * WIDTH + cx] === 1
}

function raycast(x: number, y: number, angle: number) {
  const dx = Math.cos(angle) * 0.04
  const dy = Math.sin(angle) * 0.04
  let px = x
  let py = y
  for (let d = 0; d < RANGE_MAX; d += 0.04) {
    px += dx
    py += dy
    if (occupied(px, py)) return d
  }
  return -1
}

const WAYPOINTS: { x: number; y: number }[] = [
  { x: 2.0, y: 4.2 },
  { x: 9.0, y: 4.2 },
  { x: 13.5, y: 3.9 },
  { x: 18.4, y: 4.4 },
  { x: 18.6, y: 7.8 },
  { x: 11.0, y: 7.9 },
  { x: 4.0, y: 7.6 },
  { x: 1.6, y: 7.4 },
]

function pathLength(pts: { x: number; y: number }[]) {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return l
}

/** Point + heading at arc-length s along the polyline. */
function atArcLength(pts: { x: number; y: number }[], s: number) {
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (acc + seg >= s) {
      const f = (s - acc) / seg
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
        theta: Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x),
      }
    }
    acc += seg
  }
  const last = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  return { x: last.x, y: last.y, theta: Math.atan2(last.y - prev.y, last.x - prev.x) }
}

const STALL_KINDS: AnomalyKind[] = ["cpu_spike", "nav_recovery", "costmap_stale"]

const simCache = new Map<string, SimulationData>()

export function simulationFor(runId: string): SimulationData {
  const cached = simCache.get(runId)
  if (cached) return cached
  const result = buildSimulation(runId)
  simCache.set(runId, result)
  return result
}

function buildSimulation(runId: string): SimulationData {
  const d = data()
  const run = d.runs.find((r) => r.id === runId)
  const bag = run ? d.rosbags.find((b) => b.id === run.rosbagId) : undefined
  const durationSec = bag?.durationSec ?? 90
  const anomalies = d.anomalies.filter((a) => a.runId === runId)
  const r = rng(runId + ":sim")

  const wp = WAYPOINTS.map((p, i) => ({
    x: p.x + (i === 0 || i === WAYPOINTS.length - 1 ? 0 : (r() - 0.5) * 0.5),
    y: p.y + (i === 0 || i === WAYPOINTS.length - 1 ? 0 : (r() - 0.5) * 0.35),
  }))
  const len = pathLength(wp)

  const totalFrames = Math.round(durationSec * HZ)
  const dt = 1 / HZ
  // stalls eat travel time, so pre-compute the stall budget and speed up the rest
  const stallSec = anomalies
    .filter((a) => STALL_KINDS.includes(a.kind))
    .reduce((acc, a) => acc + (a.endSec - a.tSec), 0)
  const nominalSpeed = len / Math.max(durationSec - stallSec - 4, 8)

  const frames: SimFrame[] = []
  let s = 0
  let prevTheta = atArcLength(wp, 0).theta

  for (let i = 0; i < totalFrames; i++) {
    const t = Number((i * dt).toFixed(2))
    const active = anomalies.find((a) => t >= a.tSec && t <= a.endSec) ?? null
    const kind = active?.kind ?? null

    const stalling = kind !== null && STALL_KINDS.includes(kind)
    const speed = stalling ? nominalSpeed * 0.06 : nominalSpeed * (0.94 + r() * 0.12)
    s = Math.min(len - 0.01, s + speed * dt)

    const p = atArcLength(wp, s)
    const thetaPrev = prevTheta
    // low-pass the heading so corners are not instantaneous
    const theta = thetaPrev + Math.atan2(Math.sin(p.theta - thetaPrev), Math.cos(p.theta - thetaPrev)) * 0.25
    prevTheta = theta

    let x = p.x
    let y = p.y
    if (kind === "localization_jump") {
      const nx = -Math.sin(theta)
      const ny = Math.cos(theta)
      x += nx * 0.84
      y += ny * 0.84
    }

    let scan: number[]
    if (kind === "lidar_dropout") {
      scan = new Array(SCAN_RAYS).fill(-1)
    } else {
      scan = new Array(SCAN_RAYS)
      for (let k = 0; k < SCAN_RAYS; k++) {
        const a = ANGLE_MIN + ((ANGLE_MAX - ANGLE_MIN) * k) / (SCAN_RAYS - 1)
        const dist = raycast(x, y, theta + a)
        scan[k] = dist < 0 ? -1 : Number((dist * (0.995 + r() * 0.01)).toFixed(2))
      }
      if (kind === "topic_hz_drop" || kind === "message_drop") {
        for (let k = 0; k < SCAN_RAYS; k += 3) scan[k] = -1
      }
    }

    frames.push({
      t,
      x: Number(x.toFixed(3)),
      y: Number(y.toFixed(3)),
      theta: Number(theta.toFixed(4)),
      v: Number((stalling ? 0.02 : speed).toFixed(3)),
      w: Number(((theta - thetaPrev) / dt).toFixed(3)),
      scan,
      cpu: Number((kind === "cpu_spike" ? 94 + r() * 5 : 38 + r() * 18).toFixed(1)),
      degraded: kind,
    })
  }

  return {
    runId,
    map: MAP,
    scanAngleMin: ANGLE_MIN,
    scanAngleMax: ANGLE_MAX,
    scanRangeMax: RANGE_MAX,
    frames,
    plannedPath: wp,
    referencePath: WAYPOINTS.map((p) => ({ x: p.x, y: p.y - 0.18 })),
  }
}
