// Custom indicators ported from the CandL charting platform (~/Desktop/candl/prodserv).
// The original TypeScript sources live unchanged under src/candl/; this module adapts them to
// Orbit Pro:
//   • every CandL IndicatorDef becomes an Orbit indicator definition (category "Custom"),
//   • line / histogram / dashed / dots outputs become Lightweight Charts series,
//   • canvas models (boxes, labels, profiles, signals) are drawn by a series primitive that hands
//     the CandL draw functions the same converters, rect and context their own chart gives them,
//   • strategy-style indicators feed their simulated trades to Orbit's Strategy Tester.
// CandL times are epoch milliseconds; Orbit's are seconds, so candles are converted at the edge.

import { LineSeries, HistogramSeries, LineStyle } from 'lightweight-charts';
import {
  CUSTOM_INDICATORS, getCanvasSource, getSignalSource,
} from '../candl/examples/basic/custom-indicators.ts';
import { indicatorDescription, indicatorFamily } from '../candl/examples/basic/indicatorCatalog.ts';
import { computeDomHeatmapModel, drawDomHeatmap, ensureDomHeatFeed, onDomHeatUpdate } from '../candl/examples/basic/domHeatmap.ts';
import { publishFootprintBars } from '../candl/src/overlays/footprintBarStore.ts';
import { hub, futuresBookHub } from './binance.js';
import { parseSymbol } from './providers.js';

const DOM_HEATMAP = 'dom_heatmap';

// ---------------------------------------------------------------- definitions
// Orbit indicator definition for each CandL indicator. `inputs` holds the numeric defaults (so
// Orbit's defaultParams/templates/layout code works unchanged); `paramSpecs` keeps the full CandL
// parameter list (groups, toggles, dropdowns, ranges) for the settings dialog.
export const CUSTOM_DEFS = CUSTOM_INDICATORS.map((def) => ({
  id: def.id,
  name: def.label,
  short: def.shortLabel,
  category: 'Custom',
  family: indicatorFamily(def.id),
  description: indicatorDescription(def.id),
  overlay: def.placement === 'overlay',
  custom: true,
  candl: def,
  canvas: Boolean(getCanvasSource(def.id)),
  signals: Boolean(getSignalSource(def.id)),
  strategy: getCanvasSource(def.id)?.strategy ?? null,
  inputs: Object.fromEntries(def.params.map((p) => [p.key, p.default])),
  paramSpecs: def.params,
  range: def.range,
  plots: [],
  calc: () => ({}),
}));

// ---------------------------------------------------------------- context
// CandL indicators name markets the way Delta Exchange does (BTCUSD, XAUTUSD); Orbit uses Binance
// names (BTCUSDT, BTCUSDT.P, XAUTUSDT). Gold sessions, option chains (GEX / MAP) and the footprint
// store all key on this name.
export function candlSymbol(symbol) {
  const raw = parseSymbol(symbol).raw ?? symbol;
  return String(raw).replace(/^.*:/, '').replace(/\.P$/, '').replace(/(USDT|USDC|FDUSD)$/, 'USD');
}

export function toCandl(candles) {
  return candles.map((c) => ({
    time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0,
    buyVolume: c.takerBuy, tradeCount: c.trades,
  }));
}

// Converters in the CandL contract (times in ms, CSS pixels), built on the pane's time scale.
// Times between or beyond bars interpolate by bar index, like CandL's engine.
export function makeConverters(pane, series) {
  const ts = pane.chart.timeScale();
  const L = pane.drawings;
  return {
    timeToX: (ms) => ts.logicalToCoordinate(L.timeToLogical(ms / 1000)) ?? NaN,
    xToTime: (x) => L.logicalToTime(ts.coordinateToLogical(x) ?? 0) * 1000,
    priceToY: (p) => series.priceToCoordinate(p) ?? NaN,
    yToPrice: (y) => series.coordinateToPrice(y) ?? NaN,
  };
}

// ---------------------------------------------------------------- signals (CandL drawSignal)
function roundRect(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hgt, r);
  ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
  ctx.arcTo(x, y + hgt, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawSignal(ctx, x, y, s) {
  if (s.shape === 'dot') {
    ctx.beginPath();
    ctx.fillStyle = s.color ?? '#2962ff';
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const buy = s.kind === 'buy';
  const color = s.color ?? (buy ? '#089981' : s.kind === 'sell' ? '#f23645' : '#2962ff');
  ctx.font = "700 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const padX = 5;
  const bh = 16;
  const bw = ctx.measureText(s.text).width + padX * 2;
  const gap = 9;
  const cy = buy ? y + gap + bh / 2 : y - gap - bh / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (buy) {
    const ty = cy - bh / 2;
    ctx.moveTo(x, ty - 5); ctx.lineTo(x - 4, ty); ctx.lineTo(x + 4, ty);
  } else {
    const ty = cy + bh / 2;
    ctx.moveTo(x, ty + 5); ctx.lineTo(x - 4, ty); ctx.lineTo(x + 4, ty);
  }
  ctx.closePath();
  ctx.fill();
  roundRect(ctx, x - bw / 2, cy - bh / 2, bw, bh, 3);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(s.text, x - bw / 2 + padX, cy + 0.5);
}

// ---------------------------------------------------------------- canvas primitive
// One primitive per custom indicator instance, attached to the series whose pane it draws in
// (the main price series for overlays, a host series for pane indicators such as GEX Summary).
export class CandlPrimitive {
  constructor(pane, inst) {
    this.pane = pane;
    this.inst = inst;
    const renderer = { draw: (target) => target.useMediaCoordinateSpace((scope) => this.draw(scope)) };
    this.views = [{
      zOrder: () => (inst.def.id === DOM_HEATMAP ? 'bottom' : 'top'),
      renderer: () => renderer,
    }];
  }

  attached({ series, requestUpdate }) {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.series = null;
    this.requestUpdate = null;
  }

  update() { this.requestUpdate?.(); }

  updateAllViews() {}

  paneViews() { return this.inst.visible && this.inst.shown !== false ? this.views : []; }

  draw({ context: g, mediaSize }) {
    const { pane, inst } = this;
    if (!this.series || pane.destroyed) return;
    const src = getCanvasSource(inst.def.id);
    const candles = inst.candlCandles;
    if (!candles?.length) return;
    const conv = makeConverters(pane, this.series);
    const rect = { x: 0, y: 0, width: mediaSize.width, height: mediaSize.height };
    const ctx = pane.candlContext(true);
    g.save();
    g.beginPath();
    g.rect(0, 0, rect.width, rect.height);
    g.clip();
    try {
      if (inst.def.id === DOM_HEATMAP) {
        // Recomputed at every draw, as CandL does: the feed and recorder history land asynchronously.
        drawDomHeatmap(g, conv, rect, candles, computeDomHeatmapModel(candles, inst.params, ctx), ctx);
      } else if (src && inst.model !== undefined) {
        src.draw(g, conv, rect, candles, inst.model, ctx);
      }
      for (const s of inst.signalList ?? []) {
        const x = conv.timeToX(s.time);
        if (!(x >= -30 && x <= rect.width + 30)) continue;
        const y = conv.priceToY(s.price);
        if (Number.isFinite(y)) drawSignal(g, x, y, s);
      }
    } catch (error) {
      if (!inst.drawError) console.error(`Custom indicator ${inst.def.id} draw failed`, error);
      inst.drawError = true;
    }
    g.restore();
  }
}

// ---------------------------------------------------------------- plain outputs → series
const STYLE_LINE = { dashed: LineStyle.Dashed };

export function outputSeriesOptions(out, inst, onMainPane) {
  const st = inst.styles[out.name] ?? {};
  const color = st.color ?? out.color;
  const visible = inst.visible && st.visible !== false && inst.shown !== false;
  if (out.style === 'histogram') {
    return { color, visible, priceLineVisible: false, lastValueVisible: false };
  }
  const dots = out.style === 'dots';
  return {
    color,
    visible,
    lineWidth: st.lineWidth ?? (dots ? 1 : 1.5),
    lineStyle: st.lineStyle ?? STYLE_LINE[out.style] ?? LineStyle.Solid,
    lineVisible: !dots,
    pointMarkersVisible: dots,
    pointMarkersRadius: dots ? 1.8 : undefined,
    priceLineVisible: false,
    crosshairMarkerVisible: !dots,
    lastValueVisible: inst.showLabels !== false && !onMainPane,
  };
}

export function createOutputSeries(chart, out, paneIndex) {
  return out.style === 'histogram'
    ? chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 4, minMove: 0.0001 } }, paneIndex)
    : chart.addSeries(LineSeries, {}, paneIndex);
}

// Series data for one output: null values break the line (the point before a gap is drawn
// transparent, since Lightweight Charts colours each segment by its starting point), and CandL
// `breaks` start a fresh line at that bar.
export function outputData(out, candles, color) {
  const breaks = new Set(out.breaks ?? []);
  const data = [];
  const dots = out.style === 'dots';
  const hist = out.style === 'histogram';
  for (let k = 0; k < candles.length; k++) {
    const v = out.values[k];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      if (!dots && !hist && data.length && data.at(-1).time === candles[k - 1]?.time) data.at(-1).color = 'rgba(0,0,0,0)';
      continue;
    }
    if (!dots && !hist && breaks.has(k) && data.length) data.at(-1).color = 'rgba(0,0,0,0)';
    data.push({ time: candles[k].time, value: v, color });
  }
  return data;
}

// ---------------------------------------------------------------- data feeds
// Live order-book source for the DOM Heatmap (CandL's live fallback when its recorder is absent).
const depthUnsubs = new Map();
export function startDomFeed(orbitSymbol, onUpdate) {
  const sym = candlSymbol(orbitSymbol);
  const { raw, provider } = parseSymbol(orbitSymbol);
  onDomHeatUpdate(onUpdate);
  if (provider !== 'spot' && provider !== 'perp') return;
  ensureDomHeatFeed(sym, {
    subscribeDepth(_s, onDepth) {
      const key = `${provider}|${raw}`;
      depthUnsubs.get(key)?.();
      const bookHub = provider === 'perp' ? futuresBookHub : hub;
      const unsub = bookHub.subscribe(`${raw.toLowerCase()}@depth20@100ms`, (d) => {
        const bids = (d.bids ?? d.b ?? []).map(([p, q]) => [Number(p), Number(q)]);
        const asks = (d.asks ?? d.a ?? []).map(([p, q]) => [Number(p), Number(q)]);
        onDepth({ bids, asks });
      });
      depthUnsubs.set(key, unsub);
      return unsub;
    },
  });
}

// Publish Orbit's exact-trade footprint bars for CandL studies that confirm with order flow
// (Bullseye OF, MAP V3), keyed "<symbol>|<interval>" with bar times in ms.
export function publishFootprint(pane) {
  const fp = pane.footprint;
  if (!fp) return;
  const out = new Map();
  for (const [t, rows] of fp.bars) {
    if (fp.approx.has(t) || !rows.length) continue;
    let buy = 0;
    let sell = 0;
    const map = new Map();
    for (const r of rows) {
      buy += r.buy;
      sell += r.sell;
      map.set(Math.round(r.p / fp.rowSize), [r.buy, r.sell]);
    }
    const sorted = [...rows].sort((a, b) => a.p - b.p);
    const low2 = sorted.slice(0, 2).reduce((s, r) => s + r.sell, 0);
    const high2 = sorted.slice(-2).reduce((s, r) => s + r.buy, 0);
    out.set(t * 1000, {
      delta: buy - sell, vol: buy + sell, sellLowShare: sell ? low2 / sell : 0, buyHighShare: buy ? high2 / buy : 0, rowSize: fp.rowSize, rows: map,
    });
  }
  publishFootprintBars(`${candlSymbol(pane.symbol)}|${pane.interval}`, out);
}

// ---------------------------------------------------------------- strategy tester
// Strategy-style custom indicators, as Orbit strategies whose trades come from the indicator.
export const CUSTOM_STRATEGIES = CUSTOM_DEFS.filter((d) => d.strategy).map((d) => ({
  id: `custom:${d.id}`,
  name: `${d.strategy.name} (custom)`,
  inputs: { ...d.inputs },
  paramSpecs: d.paramSpecs,
  custom: true,
  async tradeList(candles, params, ctx) {
    const src = getCanvasSource(d.id);
    const model = await src.compute(toCandl(candles), params, ctx);
    return src.strategy.trades(model).map((t) => ({
      dir: t.side === 'short' ? -1 : 1,
      entryTime: t.entryTime / 1000,
      entryPrice: t.entryPrice,
      exitTime: t.exitTime === null ? null : t.exitTime / 1000,
      exitPrice: t.exitPrice,
      reason: t.exitReason ?? (t.exitTime === null ? 'Open' : 'Exit'),
      stop: t.stop,
      qty: t.qty,
    }));
  },
}));
