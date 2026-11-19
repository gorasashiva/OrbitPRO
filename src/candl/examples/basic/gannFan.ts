// "Auto Gann Fan" — Gann fans anchored at swing highs / lows whose leg is at least 45°, with the
// 8/1, 2/1, 1/1, 1/2 and 1/8 lines only. Math: src/overlays/gannFanModel.ts. Drawn through the
// canvas-indicator hook (CanvasSource in custom-indicators.ts).
//
// Scale: the 1/1 line moves (scale × ATR 14) per bar, so the 45° test does not depend on zoom.
// Each fan is dashed from its anchor until the leg's end swing is confirmed (when it became known),
// solid afterwards, and stops 4 × the leg length later (at least 60 bars) or at the last bar.
// Research on gold 5m / 15m (research/gann-fan-study.ts): price held at these lines about as often
// as at decoy ratios, and trading touches lost after costs — use as reference lines.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { computeGannFans, gannLine, GANN_RATIOS } from '../../src/overlays/gannFanModel'
import { nyOffsetMinutes } from '../../src/overlays/nyClock'
import { type Rect } from './canvasPlot'
import type { CanvasIndicatorContext } from './shankyCombo'

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })

export const gannFan: IndicatorDef = {
  id: 'gann_fan_auto',
  label: 'Auto Gann Fan — fans from ≥45° swings (8/1, 2/1, 1/1, 1/2, 1/8)',
  shortLabel: 'Gann Fan',
  placement: 'overlay',
  params: [
    { key: 'pivotBars', label: 'Swing strength (bars each side)', default: 5, min: 2, max: 30, step: 1, group: 'Swings' },
    { key: 'minAngle', label: 'Minimum leg angle (°)', default: 45, min: 10, max: 85, step: 5, group: 'Swings' },
    { key: 'unitAtr', label: 'Scale: 1/1 = this × ATR(14) per bar', default: 0.5, min: 0.05, max: 3, step: 0.05, group: 'Swings' },
    { key: 'maxFans', label: 'Fans shown (most recent)', default: 3, min: 1, max: 20, step: 1, group: 'Display' },
    {
      key: 'side',
      label: 'Fans from',
      default: 0,
      options: [
        { value: 0, label: 'Swing lows and highs' },
        { value: 1, label: 'Swing lows only (rising)' },
        { value: -1, label: 'Swing highs only (falling)' },
      ],
      group: 'Display',
    },
    toggle('showLabels', 'Show line labels', true, 'Display'),
    toggle('skipWeekend', 'Gold: ignore weekend bars (Fri 17:00 – Sun 18:00 New York)', true, 'Swings'),
  ],
  compute: () => [],
}

/** A fan resolved to times and prices, so it can be drawn on a chart that still shows weekend bars. */
interface DrawnFan {
  dir: 1 | -1
  angle: number
  anchorTime: number
  price: number
  knownTime: number
  endTime: number
  /** Per ratio: price at the known point and at the end. */
  lines: { r: number; pK: number; pE: number }[]
}

export interface GannFanModel {
  fans: DrawnFan[]
  showLabels: boolean
}

const GOLD = /XAU|PAXG|GOLD/i
const MIN = 60_000
function goldWeekend(t: number): boolean {
  const d = new Date(t + nyOffsetMinutes(t) * MIN)
  const wd = d.getUTCDay()
  const m = d.getUTCHours() * 60 + d.getUTCMinutes()
  return (wd === 5 && m >= 17 * 60) || wd === 6 || (wd === 0 && m < 18 * 60)
}

export function computeGannFanModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): GannFanModel {
  // gold: swings, ATR and bar counts use weekday bars only
  const bars = GOLD.test(ctx.symbol) && (p.skipWeekend ?? 1) !== 0 ? candles.filter((c) => !goldWeekend(c.time)) : candles
  const all = computeGannFans(bars, {
    pivotBars: Math.max(2, Math.round(p.pivotBars ?? 5)),
    minAngle: p.minAngle ?? 45,
    unitAtr: Math.max(0.01, p.unitAtr ?? 0.5),
  })
  const side = Math.round(p.side ?? 0)
  const last = bars.length - 1
  const fans = all
    .filter((f) => f.fromIndex < bars.length && (side === 0 || f.dir === side))
    .slice(-Math.max(1, Math.round(p.maxFans ?? 3)))
    .map((f) => {
      const end = Math.min(f.toIndex, last)
      const known = Math.min(f.fromIndex, end)
      return {
        dir: f.dir,
        angle: f.angle,
        anchorTime: f.anchorTime,
        price: f.price,
        knownTime: bars[known].time,
        endTime: bars[end].time,
        lines: GANN_RATIOS.map((r) => ({ r, pK: gannLine(f, r, known - f.anchorIndex), pE: gannLine(f, r, end - f.anchorIndex) })),
      }
    })
  return { fans, showLabels: (p.showLabels ?? 1) !== 0 }
}

const STYLE: Record<number, { c: string; w: number; name: string }> = {
  8: { c: 'rgba(171, 71, 188, 0.85)', w: 1, name: '8/1' },
  2: { c: 'rgba(66, 165, 245, 0.9)', w: 1, name: '2/1' },
  1: { c: 'rgba(255, 193, 7, 1)', w: 2, name: '1/1' },
  0.5: { c: 'rgba(38, 198, 218, 0.9)', w: 1, name: '1/2' },
  0.125: { c: 'rgba(239, 83, 80, 0.85)', w: 1, name: '1/8' },
}
const FONT = "500 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

export function drawGannFan(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: GannFanModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  g.font = FONT
  g.textBaseline = 'middle'
  g.textAlign = 'left'
  for (const f of m.fans) {
    const xA = conv.timeToX(f.anchorTime)
    const xK = conv.timeToX(f.knownTime)
    const xE = conv.timeToX(f.endTime)
    if (xE < rect.x || xA > rect.x + rect.width) continue
    const yA = conv.priceToY(f.price)
    for (const ln of f.lines) {
      const s = STYLE[ln.r]
      const yK = conv.priceToY(ln.pK)
      const yE = conv.priceToY(ln.pE)
      g.strokeStyle = s.c
      g.lineWidth = s.w
      g.setLineDash([3, 3])
      g.beginPath()
      g.moveTo(xA, yA)
      g.lineTo(xK, yK)
      g.stroke()
      g.setLineDash([])
      g.beginPath()
      g.moveTo(xK, yK)
      g.lineTo(xE, yE)
      g.stroke()
      if (m.showLabels && yE > rect.y && yE < rect.y + rect.height) {
        g.fillStyle = s.c
        g.fillText(s.name, xE + 3, yE)
      }
    }
    // anchor marker with the leg angle
    g.fillStyle = f.dir === 1 ? 'rgba(76, 175, 80, 1)' : 'rgba(244, 67, 54, 1)'
    g.beginPath()
    g.arc(xA, yA, 3, 0, Math.PI * 2)
    g.fill()
    if (m.showLabels) {
      g.textBaseline = f.dir === 1 ? 'top' : 'bottom'
      g.fillText(`${f.angle.toFixed(0)}°`, xA + 4, yA + (f.dir === 1 ? 4 : -4))
      g.textBaseline = 'middle'
    }
  }
  g.restore()
}
