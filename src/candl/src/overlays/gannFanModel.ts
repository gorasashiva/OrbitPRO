// Auto Gann fans from steep swings (the rules of research/gann-fan-study.ts).
// Pivots: fractal swings with L bars each side, alternating high / low.
// Scale: 1/1 = unitAtr × ATR(14) price per bar, measured at the anchor.
// A fan is anchored at a pivot when the leg from it to the next pivot is at least 45°
// (slope ≥ 1 unit per bar). Lines: anchor ± ratio × unit × (bars since anchor), ratios 8, 2, 1, 1/2, 1/8.
// The fan is drawn from the anchor; it is "known" only from `fromIndex` (the leg's end pivot confirmed).
// Research (gold 5m / 15m, Apr–Nov 2026): price held at these lines about as often as at decoy ratios —
// they are reference lines, not a tested edge.

import type { Candle } from '../core/types'

export const GANN_RATIOS = [8, 2, 1, 0.5, 0.125] as const

export interface GannFan {
  anchorTime: number
  anchorIndex: number
  price: number
  /** +1: from a swing low, lines rise; −1: from a swing high, lines fall. */
  dir: 1 | -1
  /** Price per bar of the 1/1 line. */
  unit: number
  /** Leg angle in degrees on the fan's own scale (≥ minAngle). */
  angle: number
  /** Index from which the fan is known (leg end pivot confirmed). */
  fromIndex: number
  /** Last index the fan is followed (4 × the leg length, at least 60 bars). */
  toIndex: number
}

export interface GannFanOptions {
  pivotBars: number
  unitAtr: number
  atrLength: number
  minAngle: number
}

export const GANN_FAN_DEFAULTS: GannFanOptions = { pivotBars: 5, unitAtr: 0.5, atrLength: 14, minAngle: 45 }

function atr(c: Candle[], n: number): number[] {
  const out: number[] = []
  let a = 0
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].high - c[i].low : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    a = i === 0 ? tr : (a * (n - 1) + tr) / n
    out.push(a)
  }
  return out
}

interface Pivot {
  i: number
  price: number
  hi: boolean
}

/** Fractal pivots (L bars each side), alternating high / low, keeping the more extreme of repeats. */
export function swingPivots(c: Candle[], L: number): Pivot[] {
  const raw: Pivot[] = []
  for (let i = L; i < c.length - L; i++) {
    let isH = true
    let isL = true
    for (let k = 1; k <= L; k++) {
      if (c[i - k].high >= c[i].high || c[i + k].high > c[i].high) isH = false
      if (c[i - k].low <= c[i].low || c[i + k].low < c[i].low) isL = false
    }
    if (isH) raw.push({ i, price: c[i].high, hi: true })
    if (isL) raw.push({ i, price: c[i].low, hi: false })
  }
  const out: Pivot[] = []
  for (const p of raw) {
    const last = out[out.length - 1]
    if (last && last.hi === p.hi) {
      if ((p.hi && p.price > last.price) || (!p.hi && p.price < last.price)) out[out.length - 1] = p
    } else out.push(p)
  }
  return out
}

export function computeGannFans(c: Candle[], opts: Partial<GannFanOptions> = {}): GannFan[] {
  const o = { ...GANN_FAN_DEFAULTS, ...opts }
  if (c.length < 2 * o.pivotBars + 2) return []
  const a = atr(c, o.atrLength)
  const ps = swingPivots(c, o.pivotBars)
  const minSlope = Math.tan((o.minAngle * Math.PI) / 180)
  const out: GannFan[] = []
  for (let k = 0; k + 1 < ps.length; k++) {
    const p0 = ps[k]
    const p1 = ps[k + 1]
    const bars = p1.i - p0.i
    const unit = o.unitAtr * a[p0.i]
    if (bars <= 0 || !(unit > 0)) continue
    const slope = Math.abs(p1.price - p0.price) / bars / unit
    if (slope < minSlope) continue
    const from = p1.i + o.pivotBars
    out.push({
      anchorTime: c[p0.i].time,
      anchorIndex: p0.i,
      price: p0.price,
      dir: p0.hi ? -1 : 1,
      unit,
      angle: (Math.atan(slope) * 180) / Math.PI,
      fromIndex: from,
      toIndex: from + Math.max(60, 4 * bars),
    })
  }
  return out
}

/** Price of a fan line `bars` after its anchor. */
export const gannLine = (f: GannFan, ratio: number, bars: number): number => f.price + f.dir * ratio * f.unit * bars
