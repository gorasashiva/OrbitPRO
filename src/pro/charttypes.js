// TradingView chart types beyond lightweight-charts' built-ins.
// - Non-time-based constructions (Renko, Line break, Kagi, Point & figure, Range) are computed
//   from candles following TradingView's rules; bars formed within the same candle get +1s offsets
//   so the time scale stays strictly increasing (the chart spaces bars by index, like TradingView).
// - Custom renderers (lightweight-charts custom series) draw Volume candles, HLC area, Columns,
//   High-low, Kagi, Point & figure, TPO, Session volume profile and Volume footprint.

import { customSeriesDefaultOptions } from 'lightweight-charts';

export const CHART_TYPES = [
  { id: 'bars', label: 'Bars', icon: '┤', section: 'Bars' },
  { id: 'candles', label: 'Candles', icon: '▮', section: 'Bars' },
  { id: 'hollow', label: 'Hollow candles', icon: '▯', section: 'Bars' },
  { id: 'volcandles', label: 'Volume candles', icon: '▉', section: 'Bars', custom: true },
  { id: 'line', label: 'Line', icon: '╱', section: 'Lines' },
  { id: 'linemarkers', label: 'Line with markers', icon: '⟋', section: 'Lines' },
  { id: 'step', label: 'Step line', icon: '⌐', section: 'Lines' },
  { id: 'area', label: 'Area', icon: '◭', section: 'Areas' },
  { id: 'hlcarea', label: 'HLC area', icon: '◬', section: 'Areas', custom: true },
  { id: 'baseline', label: 'Baseline', icon: '⫠', section: 'Areas' },
  { id: 'columns', label: 'Columns', icon: '▥', section: 'Columns', custom: true },
  { id: 'highlow', label: 'High-low', icon: '┃', section: 'Columns', custom: true },
  { id: 'footprint', label: 'Volume footprint', icon: '▦', section: 'Volume-based', custom: true },
  { id: 'tpo', label: 'Time price opportunity', icon: 'Ⓣ', section: 'Volume-based', custom: true },
  { id: 'svp', label: 'Session volume profile', icon: '▤', section: 'Volume-based', custom: true },
  { id: 'heikin', label: 'Heikin Ashi', icon: '◧', section: 'Alternative', derived: true },
  { id: 'renko', label: 'Renko', icon: '▞', section: 'Alternative', derived: true },
  { id: 'linebreak', label: 'Line break', icon: '▚', section: 'Alternative', derived: true },
  { id: 'kagi', label: 'Kagi', icon: '⎍', section: 'Alternative', derived: true, custom: true },
  { id: 'pnf', label: 'Point & figure', icon: '✕', section: 'Alternative', derived: true, custom: true },
  { id: 'range', label: 'Range', icon: '▬', section: 'Alternative', derived: true },
];
export const chartTypeById = (id) => CHART_TYPES.find((t) => t.id === id) ?? CHART_TYPES[1];

export const CHART_TYPE_DEFAULTS = {
  renkoMode: 'atr', renkoAtr: 14, renkoBox: 0, renkoSource: 'close',
  lbLines: 3,
  kagiMode: 'atr', kagiAtr: 14, kagiValue: 1,
  pnfMode: 'atr', pnfAtr: 14, pnfBox: 0, pnfReversal: 3, pnfSource: 'hl',
  rangeMode: 'atr', rangeAtr: 14, rangeValue: 0,
  tpoPeriod: 30, tpoRows: 0, tpoVA: 70,
  svpRows: 24, svpVA: 70, svpWidth: 70,
  fpBars: 200,
};

// ---------------------------------------------------------------- helpers
export function atrLast(candles, n = 14) {
  if (candles.length < 2) return candles[0] ? candles[0].high - candles[0].low : 0;
  let atr = null;
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    if (i <= n) {
      sum += tr;
      if (i === n) atr = sum / n;
    } else {
      atr = (atr * (n - 1) + tr) / n;
    }
  }
  return atr ?? sum / Math.max(1, candles.length - 1);
}

// Round a step to a "nice" 1/2/2.5/5 × 10^k value, never below the tick size.
export function niceStep(x, tick = 0) {
  if (!(x > 0)) return tick || 1;
  const k = 10 ** Math.floor(Math.log10(x));
  const m = x / k;
  const nice = m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10;
  return Math.max(nice * k, tick || 0);
}
const roundTo = (v, step) => Math.round(v / step) * step;

// TradingView box sizing: ATR(n) of the loaded data (constant), a fixed value, or a percentage.
export function boxSize(candles, mode, atrLen, fixed, tick) {
  if (mode === 'fixed' && fixed > 0) return fixed;
  if (mode === 'percent' && fixed > 0) return (candles.at(-1)?.close ?? 1) * (fixed / 100);
  return Math.max(tick || 0, roundTo(atrLast(candles, atrLen), tick || 1e-8) || tick || 1);
}

// Strictly increasing timestamps for bars formed inside the same source candle.
function stamper() {
  let last = -Infinity;
  return (t) => {
    last = Math.max(t, last + 1);
    return last;
  };
}

// ---------------------------------------------------------------- derived constructions
export function heikinAshi(candles) {
  const out = [];
  let prev = null;
  for (const c of candles) {
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
    const bar = { time: c.time, open, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close), close, volume: c.volume };
    out.push(bar);
    prev = bar;
  }
  return out;
}

// Traditional Renko: a new brick needs one box beyond the last brick, a reversal needs two.
export function renko(candles, s, tick) {
  if (!candles.length) return [];
  const box = boxSize(candles, s.renkoMode, s.renkoAtr, s.renkoBox, tick);
  const stamp = stamper();
  const out = [];
  let hi = candles[0].close;
  let lo = candles[0].close;
  let vol = 0;
  for (const c of candles) {
    vol += c.volume;
    const prices = s.renkoSource === 'hl' ? (c.close >= c.open ? [c.low, c.high] : [c.high, c.low]) : [c.close];
    for (const price of prices) {
      while (price >= hi + box) {
        out.push({ time: stamp(c.time), open: hi, close: hi + box, high: hi + box, low: hi, volume: vol, box });
        vol = 0;
        lo = hi;
        hi += box;
      }
      while (price <= lo - box) {
        out.push({ time: stamp(c.time), open: lo, close: lo - box, high: lo, low: lo - box, volume: vol, box });
        vol = 0;
        hi = lo;
        lo -= box;
      }
    }
  }
  return out;
}

// n-line break: continue on a new close beyond the last line; reverse only past the extreme
// of the last n lines.
export function lineBreak(candles, s) {
  if (!candles.length) return [];
  const n = Math.max(1, Math.round(s.lbLines || 3));
  const stamp = stamper();
  const first = candles[0];
  const lines = [{ time: stamp(first.time), open: first.open, close: first.close, high: Math.max(first.open, first.close), low: Math.min(first.open, first.close), volume: first.volume, up: first.close >= first.open }];
  let vol = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    vol += c.volume;
    const last = lines.at(-1);
    const recent = lines.slice(-n);
    const hi = Math.max(...recent.map((l) => l.high));
    const lo = Math.min(...recent.map((l) => l.low));
    let next = null;
    if (last.up) {
      if (c.close > last.close) next = { open: last.close, close: c.close, up: true };
      else if (c.close < lo) next = { open: last.open, close: c.close, up: false };
    } else if (c.close < last.close) next = { open: last.close, close: c.close, up: false };
    else if (c.close > hi) next = { open: last.open, close: c.close, up: true };
    if (next) {
      lines.push({ ...next, time: stamp(c.time), high: Math.max(next.open, next.close), low: Math.min(next.open, next.close), volume: vol });
      vol = 0;
    }
  }
  return lines;
}

// Range bars: every completed bar spans exactly `range`; the intrabar path is approximated as
// open → nearer extreme → farther extreme → close.
export function rangeBars(candles, s, tick) {
  if (!candles.length) return [];
  const R = boxSize(candles, s.rangeMode, s.rangeAtr, s.rangeValue, tick);
  const stamp = stamper();
  const out = [];
  const o0 = candles[0].open;
  let cur = { open: o0, high: o0, low: o0, close: o0, volume: 0 };
  const walk = (to, t) => {
    for (let guard = 0; guard < 100000 && cur.close !== to; guard++) {
      if (to > cur.close) {
        const cap = cur.low + R;
        if (to >= cap) {
          cur.high = cap;
          cur.close = cap;
          out.push({ ...cur, time: stamp(t) });
          cur = { open: cap, high: cap, low: cap, close: cap, volume: 0 };
        } else {
          cur.high = Math.max(cur.high, to);
          cur.close = to;
        }
      } else {
        const cap = cur.high - R;
        if (to <= cap) {
          cur.low = cap;
          cur.close = cap;
          out.push({ ...cur, time: stamp(t) });
          cur = { open: cap, high: cap, low: cap, close: cap, volume: 0 };
        } else {
          cur.low = Math.min(cur.low, to);
          cur.close = to;
        }
      }
    }
  };
  for (const c of candles) {
    cur.volume += c.volume;
    const path = Math.abs(c.high - c.open) < Math.abs(c.open - c.low) ? [c.open, c.high, c.low, c.close] : [c.open, c.low, c.high, c.close];
    for (const p of path) walk(p, c.time);
  }
  if (cur.high !== cur.low) out.push({ ...cur, time: stamp(candles.at(-1).time) });
  return out;
}

// Kagi: reverse when price retraces by the reversal amount. Yang (thick) after breaking the
// previous shoulder, yin (thin) after breaking the previous waist.
export function kagi(candles, s, tick) {
  if (candles.length < 2) return [];
  const rev = boxSize(candles, s.kagiMode, s.kagiAtr, s.kagiValue, tick);
  const stamp = stamper();
  const pts = [{ time: stamp(candles[0].time), value: candles[0].close, volume: candles[0].volume }];
  let dir = 0;
  let ext = candles[0].close;
  let extTime = candles[0].time;
  let vol = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = c.close;
    vol += c.volume;
    if (dir === 0) {
      if (Math.abs(p - ext) >= rev) { dir = p > ext ? 1 : -1; ext = p; extTime = c.time; }
      continue;
    }
    if ((dir === 1 && p > ext) || (dir === -1 && p < ext)) {
      ext = p;
      extTime = c.time;
    } else if (Math.abs(ext - p) >= rev) {
      pts.push({ time: stamp(extTime), value: ext, volume: vol });
      vol = 0;
      dir = -dir;
      ext = p;
      extTime = c.time;
    }
  }
  pts.push({ time: stamp(Math.max(extTime, candles.at(-1).time)), value: ext, volume: vol });
  // Thickness: walk the legs once, splitting a vertical leg where it crosses a shoulder or waist.
  let yang = pts.length > 1 && pts[1].value > pts[0].value;
  let shoulder = -Infinity;
  let waist = Infinity;
  pts.forEach((cur, i) => {
    const prev = pts[i - 1];
    cur.hYang = yang;
    cur.segs = [];
    if (prev) {
      const from = prev.value;
      const to = cur.value;
      if (to > from) {
        if (!yang && to > shoulder && shoulder > from) {
          cur.segs.push({ from, to: shoulder, yang: false }, { from: shoulder, to, yang: true });
          yang = true;
        } else {
          if (!yang && to > shoulder) yang = true;
          cur.segs.push({ from, to, yang });
        }
        shoulder = to;
      } else {
        if (yang && to < waist && waist < from) {
          cur.segs.push({ from, to: waist, yang: true }, { from: waist, to, yang: false });
          yang = false;
        } else {
          if (yang && to < waist) yang = false;
          cur.segs.push({ from, to, yang });
        }
        waist = to;
      }
    }
    cur.prevValue = prev?.value ?? cur.value;
    cur.open = cur.prevValue;
    cur.close = cur.value;
    cur.high = Math.max(cur.open, cur.close);
    cur.low = Math.min(cur.open, cur.close);
  });
  return pts;
}

// Point & figure: X columns rise, O columns fall; a new column needs `reversal` boxes.
export function pointFigure(candles, s, tick) {
  if (!candles.length) return [];
  const box = boxSize(candles, s.pnfMode, s.pnfAtr, s.pnfBox, tick);
  const rev = Math.max(1, Math.round(s.pnfReversal || 3));
  const stamp = stamper();
  const cols = [];
  let col = null;
  const start = Math.floor(candles[0].close / box) * box;
  let vol = 0;
  for (const c of candles) {
    vol += c.volume;
    const hiP = s.pnfSource === 'hl' ? c.high : c.close;
    const loP = s.pnfSource === 'hl' ? c.low : c.close;
    if (!col) {
      if (hiP >= start + box) col = { up: true, low: start + box, high: Math.floor(hiP / box) * box };
      else if (loP <= start - box) col = { up: false, high: start - box, low: Math.ceil(loP / box) * box };
      if (col) { col.time = stamp(c.time); col.volume = vol; vol = 0; cols.push(col); }
      continue;
    }
    if (col.up) {
      if (hiP >= col.high + box) {
        col.high = Math.floor(hiP / box) * box;
        col.volume += vol;
        vol = 0;
      } else if (loP <= col.high - rev * box) {
        col = { up: false, high: col.high - box, low: Math.ceil(loP / box) * box, time: stamp(c.time), volume: vol };
        vol = 0;
        cols.push(col);
      }
    } else if (loP <= col.low - box) {
      col.low = Math.ceil(loP / box) * box;
      col.volume += vol;
      vol = 0;
    } else if (hiP >= col.low + rev * box) {
      col = { up: true, low: col.low + box, high: Math.floor(hiP / box) * box, time: stamp(c.time), volume: vol };
      vol = 0;
      cols.push(col);
    }
  }
  return cols.map((k) => ({ ...k, box, open: k.up ? k.low : k.high, close: k.up ? k.high : k.low }));
}

export function deriveBars(type, candles, s, tick) {
  switch (type) {
    case 'heikin': return heikinAshi(candles);
    case 'renko': return renko(candles, s, tick);
    case 'linebreak': return lineBreak(candles, s);
    case 'range': return rangeBars(candles, s, tick);
    case 'kagi': return kagi(candles, s, tick);
    case 'pnf': return pointFigure(candles, s, tick);
    default: return candles;
  }
}

// ---------------------------------------------------------------- custom series views
const OHLC_VALUES = (r) => [r.low ?? r.close, r.high ?? r.close, r.close];
const isWS = (r) => r.close === undefined;

function makeView(defaults, render, values = OHLC_VALUES) {
  return {
    data: null,
    opts: null,
    renderer() {
      const view = this;
      return {
        draw(target, priceToY) {
          if (!view.data) return;
          target.useMediaCoordinateSpace(({ context, mediaSize }) => {
            context.save();
            try {
              render(context, view.data, view.opts, priceToY, mediaSize);
            } finally {
              context.restore();
            }
          });
        },
      };
    },
    update(data, opts) { this.data = data; this.opts = opts; },
    priceValueBuilder: values,
    isWhitespace: isWS,
    defaultOptions: () => ({ ...customSeriesDefaultOptions, ...defaults }),
  };
}

function visible(data, pad = 1) {
  const r = data.visibleRange;
  if (!r) return [0, -1];
  return [Math.max(0, r.from - pad), Math.min(data.bars.length - 1, r.to + pad)];
}

function candle(ctx, x, w, yO, yH, yL, yC, o, up) {
  const top = Math.min(yO, yC);
  const h = Math.max(1, Math.abs(yC - yO));
  if (o.wickVisible !== false) {
    ctx.fillStyle = up ? o.wickUpColor : o.wickDownColor;
    ctx.fillRect(Math.round(x) - 0.5, yH, 1, Math.max(1, yL - yH));
  }
  ctx.fillStyle = up ? o.upColor : o.downColor;
  ctx.fillRect(x - w / 2, top, w, h);
  if (o.borderVisible !== false && w > 3) {
    ctx.strokeStyle = up ? o.borderUpColor : o.borderDownColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - w / 2 + 0.5, top + 0.5, w - 1, Math.max(0, h - 1));
  }
}

const CANDLE_DEF = {
  upColor: '#089981', downColor: '#F23645', wickUpColor: '#089981', wickDownColor: '#F23645',
  borderUpColor: '#089981', borderDownColor: '#F23645', wickVisible: true, borderVisible: true,
};

// Volume candles: body width scales with the bar's volume relative to the visible maximum.
export const volumeCandlesView = () => makeView(CANDLE_DEF, (ctx, data, o, y) => {
  const [a, b] = visible(data);
  let max = 0;
  for (let i = a; i <= b; i++) max = Math.max(max, data.bars[i].originalData.volume ?? 0);
  const full = Math.max(1, data.barSpacing * 0.92);
  for (let i = a; i <= b; i++) {
    const d = data.bars[i].originalData;
    const x = xAt(data, i);
    const w = Math.max(1, full * (max ? 0.12 + 0.88 * ((d.volume ?? 0) / max) : 0.6));
    candle(ctx, x, w, y(d.open), y(d.high), y(d.low), y(d.close), o, d.close >= d.open);
  }
});

// HLC area: high and low lines with fills toward the close line.
export const hlcAreaView = () => makeView({
  highColor: '#089981', lowColor: '#F23645', closeColor: '#787B86', highFill: 'rgba(8, 153, 129, 0.2)', lowFill: 'rgba(242, 54, 69, 0.2)',
}, (ctx, data, o, y) => {
  const [a, b] = visible(data, 2);
  if (b < a) return;
  const pts = [];
  for (let i = a; i <= b; i++) {
    const d = data.bars[i].originalData;
    const x = xAt(data, i);
    pts.push({ x, h: y(d.high), l: y(d.low), c: y(d.close) });
  }
  const band = (key, fill) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p[key]) : ctx.moveTo(p.x, p[key])));
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].c);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  band('h', o.highFill);
  band('l', o.lowFill);
  const line = (key, color, width) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p[key]) : ctx.moveTo(p.x, p[key])));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  line('h', o.highColor, 1);
  line('l', o.lowColor, 1);
  line('c', o.closeColor, 2);
});

// Columns: from the bottom of the pane to the close, coloured against the previous close.
export const columnsView = () => makeView({ upColor: 'rgba(8, 153, 129, 0.5)', downColor: 'rgba(242, 54, 69, 0.5)' }, (ctx, data, o, y, size) => {
  const [a, b] = visible(data);
  const w = Math.max(1, data.barSpacing * 0.8);
  for (let i = a; i <= b; i++) {
    const d = data.bars[i].originalData;
    const x = xAt(data, i);
    const prev = data.bars[i - 1]?.originalData;
    const yc = y(d.close);
    ctx.fillStyle = !prev || d.close >= prev.close ? o.upColor : o.downColor;
    ctx.fillRect(x - w / 2, yc, w, size.height - yc);
  }
}, (r) => [r.close]);

// High-low: a solid bar from low to high, with high/low labels when there is room.
export const highLowView = () => makeView({ upColor: '#089981', downColor: '#F23645', labelColor: '#787B86', showLabels: true, precision: 2 }, (ctx, data, o, y) => {
  const [a, b] = visible(data);
  const w = Math.max(1, data.barSpacing * 0.6);
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'center';
  for (let i = a; i <= b; i++) {
    const d = data.bars[i].originalData;
    const x = xAt(data, i);
    const yh = y(d.high);
    const yl = y(d.low);
    ctx.fillStyle = d.close >= d.open ? o.upColor : o.downColor;
    ctx.fillRect(x - w / 2, yh, w, Math.max(1, yl - yh));
    if (o.showLabels && data.barSpacing > 42) {
      ctx.fillStyle = o.labelColor;
      ctx.textBaseline = 'bottom';
      ctx.fillText(d.high.toFixed(o.precision), x, yh - 2);
      ctx.textBaseline = 'top';
      ctx.fillText(d.low.toFixed(o.precision), x, yl + 2);
    }
  }
});

// Kagi lines: horizontal shoulders/waists plus vertical legs that thicken on yang.
export const kagiView = () => makeView({ upColor: '#089981', downColor: '#F23645', yangWidth: 3, yinWidth: 1 }, (ctx, data, o, y) => {
  const [a, b] = visible(data, 2);
  ctx.lineCap = 'square';
  const style = (yang) => {
    ctx.strokeStyle = yang ? o.upColor : o.downColor;
    ctx.lineWidth = yang ? o.yangWidth : o.yinWidth;
  };
  for (let i = Math.max(1, a); i <= b; i++) {
    const d = data.bars[i].originalData;
    style(d.hYang);
    ctx.beginPath();
    ctx.moveTo(xAt(data, i - 1), y(d.prevValue));
    ctx.lineTo(xAt(data, i), y(d.prevValue));
    ctx.stroke();
    for (const seg of d.segs ?? []) {
      style(seg.yang);
      ctx.beginPath();
      ctx.moveTo(xAt(data, i), y(seg.from));
      ctx.lineTo(xAt(data, i), y(seg.to));
      ctx.stroke();
    }
  }
});

// Point & figure: stacked X boxes for rising columns, O boxes for falling ones.
export const pnfView = () => makeView({ upColor: '#089981', downColor: '#F23645' }, (ctx, data, o, y) => {
  const [a, b] = visible(data);
  for (let i = a; i <= b; i++) {
    const d = data.bars[i].originalData;
    const x = xAt(data, i);
    const boxPx = Math.abs(y(d.low) - y(d.low + d.box));
    const s = Math.max(2, Math.min(data.barSpacing * 0.8, boxPx * 0.9)) / 2;
    ctx.strokeStyle = d.up ? o.upColor : o.downColor;
    ctx.lineWidth = Math.max(1, Math.min(2, s / 4));
    const n = Math.round((d.high - d.low) / d.box);
    for (let k = 0; k <= n; k++) {
      const cy = y(d.low + k * d.box);
      ctx.beginPath();
      if (d.up) {
        ctx.moveTo(x - s, cy - s);
        ctx.lineTo(x + s, cy + s);
        ctx.moveTo(x + s, cy - s);
        ctx.lineTo(x - s, cy + s);
      } else {
        ctx.ellipse(x, cy, s, s, 0, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
  }
});

// ---------------------------------------------------------------- session profiles (TPO, SVP)
// x of bar i; off-screen bars have no x, so extrapolate from the first visible bar.
function xAt(data, i) {
  const x = data.bars[i]?.x;
  if (x !== null && x !== undefined) return x;
  const ref = data.visibleRange ? Math.max(0, Math.min(data.bars.length - 1, data.visibleRange.from)) : 0;
  return (data.bars[ref].x ?? 0) + (i - ref) * data.barSpacing;
}

function sessions(data, sessionSec) {
  const out = [];
  let cur = null;
  data.bars.forEach((bar, i) => {
    // lightweight-charts strips `time` from originalData, so the series rows carry it as `t`.
    const key = Math.floor(bar.originalData.t / sessionSec);
    if (!cur || cur.key !== key) {
      cur = { key, from: i, to: i };
      out.push(cur);
    } else cur.to = i;
  });
  return out;
}

function valueArea(counts, poc, pct) {
  const total = counts.reduce((s, v) => s + v, 0);
  let lo = poc;
  let hi = poc;
  let acc = counts[poc];
  while (acc < total * pct && (lo > 0 || hi < counts.length - 1)) {
    const below = lo > 0 ? counts[lo - 1] : -1;
    const above = hi < counts.length - 1 ? counts[hi + 1] : -1;
    if (above >= below) acc += counts[++hi]; else acc += counts[--lo];
  }
  return [lo, hi];
}

const TPO_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// TPO (market profile): one letter per period per price row the period traded through;
// POC and the 70% value area are highlighted, with session open/close ticks.
export const tpoView = () => makeView({
  ...CANDLE_DEF, sessionSec: 86400, periodSec: 1800, barSec: 300, rowSize: 0, tick: 0.01, valueArea: 70,
  pocColor: '#F23645', vaColor: 'rgba(41, 98, 255, 0.95)', outColor: 'rgba(120, 123, 134, 0.8)',
}, (ctx, data, o, y) => {
  const [a, b] = visible(data, 0);
  if (b < a) return;
  const sess = sessions(data, o.sessionSec).filter((s) => s.to >= a && s.from <= b);
  const rangeOf = (s) => {
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = s.from; i <= s.to; i++) { const d = data.bars[i].originalData; hi = Math.max(hi, d.high); lo = Math.min(lo, d.low); }
    return [lo, hi];
  };
  let row = o.rowSize;
  if (!(row > 0)) {
    const avg = sess.reduce((x, s) => { const [lo, hi] = rangeOf(s); return x + (hi - lo); }, 0) / Math.max(1, sess.length);
    row = niceStep(avg / 24, o.tick);
  }
  const barsPerPeriod = Math.max(1, Math.round(o.periodSec / o.barSec));
  const cell = Math.max(2, data.barSpacing * barsPerPeriod);
  const rh = Math.abs(y(0) - y(row));
  const showText = cell >= 7 && rh >= 8;
  ctx.font = `600 ${Math.max(7, Math.min(12, Math.floor(rh * 0.85)))}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const s of sess) {
    const rows = new Map();
    let p = 0;
    for (let i = s.from; i <= s.to; i += barsPerPeriod, p++) {
      const [lo, hi] = rangeOf({ from: i, to: Math.min(s.to, i + barsPerPeriod - 1) });
      for (let r = Math.floor(lo / row); r <= Math.floor(hi / row); r++) {
        if (!rows.has(r)) rows.set(r, []);
        rows.get(r).push(p);
      }
    }
    const keys = [...rows.keys()].sort((x, z) => x - z);
    if (!keys.length) continue;
    const counts = keys.map((k) => rows.get(k).length);
    let poc = 0;
    counts.forEach((v, i) => { if (v > counts[poc]) poc = i; });
    const [vl, vh] = valueArea(counts, poc, o.valueArea / 100);
    const x0 = xAt(data, s.from) - data.barSpacing / 2;
    keys.forEach((k, idx) => {
      const yc = y((k + 0.5) * row);
      const color = idx === poc ? o.pocColor : idx >= vl && idx <= vh ? o.vaColor : o.outColor;
      ctx.fillStyle = color;
      rows.get(k).forEach((period, n) => {
        const cx = x0 + n * cell + cell / 2;
        if (showText) ctx.fillText(TPO_LETTERS[period % TPO_LETTERS.length], cx, yc);
        else ctx.fillRect(cx - cell / 2 + 0.5, yc - rh / 2 + 0.5, Math.max(1, cell - 1), Math.max(1, rh - 1));
      });
    });
    const first = data.bars[s.from].originalData;
    const last = data.bars[s.to].originalData;
    ctx.fillStyle = o.upColor;
    ctx.fillRect(x0 - 5, y(first.open) - 1, 5, 2);
    ctx.fillStyle = o.downColor;
    ctx.fillRect(x0 - 5, y(last.close) - 1, 5, 2);
  }
});

// Session volume profile: candles plus one volume histogram per session with POC and value area.
export const svpView = () => makeView({
  ...CANDLE_DEF, sessionSec: 86400, rows: 24, valueArea: 70, widthPct: 70, upVol: 'rgba(41, 98, 255, 1)', downVol: 'rgba(251, 192, 45, 1)', pocColor: '#F23645',
}, (ctx, data, o, y) => {
  const [a, b] = visible(data);
  const w = Math.max(1, data.barSpacing * 0.7);
  for (let i = a; i <= b; i++) {
    const d = data.bars[i].originalData;
    const x = xAt(data, i);
    candle(ctx, x, w, y(d.open), y(d.high), y(d.low), y(d.close), o, d.close >= d.open);
  }
  for (const s of sessions(data, o.sessionSec).filter((x) => x.to >= a && x.from <= b)) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = s.from; i <= s.to; i++) { const d = data.bars[i].originalData; hi = Math.max(hi, d.high); lo = Math.min(lo, d.low); }
    const rows = Math.max(4, Math.round(o.rows));
    const step = (hi - lo) / rows || 1;
    const up = new Array(rows).fill(0);
    const dn = new Array(rows).fill(0);
    for (let i = s.from; i <= s.to; i++) {
      const d = data.bars[i].originalData;
      const r0 = Math.max(0, Math.min(rows - 1, Math.floor((d.low - lo) / step)));
      const r1 = Math.max(0, Math.min(rows - 1, Math.floor((d.high - lo) / step)));
      const share = (d.volume ?? 0) / (r1 - r0 + 1);
      for (let r = r0; r <= r1; r++) (d.close >= d.open ? up : dn)[r] += share;
    }
    const tot = up.map((u, i) => u + dn[i]);
    const max = Math.max(...tot) || 1;
    let poc = 0;
    tot.forEach((v, i) => { if (v > tot[poc]) poc = i; });
    const [vl, vh] = valueArea(tot, poc, o.valueArea / 100);
    const x0 = xAt(data, s.from) - data.barSpacing / 2;
    const width = (xAt(data, s.to) - xAt(data, s.from) + data.barSpacing) * (o.widthPct / 100);
    for (let r = 0; r < rows; r++) {
      const yt = y(lo + (r + 1) * step);
      const yb = y(lo + r * step);
      const h = Math.max(1, Math.abs(yb - yt) - 1);
      const uw = (up[r] / max) * width;
      const dw = (dn[r] / max) * width;
      ctx.globalAlpha = r >= vl && r <= vh ? 0.55 : 0.25;
      ctx.fillStyle = o.upVol;
      ctx.fillRect(x0, Math.min(yt, yb), uw, h);
      ctx.fillStyle = o.downVol;
      ctx.fillRect(x0 + uw, Math.min(yt, yb), dw, h);
    }
    ctx.globalAlpha = 1;
    const yp = y(lo + (poc + 0.5) * step);
    ctx.strokeStyle = o.pocColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, yp);
    ctx.lineTo(xAt(data, s.to) + data.barSpacing / 2, yp);
    ctx.stroke();
  }
});

// ---------------------------------------------------------------- volume footprint
// Each bar carries rows [{p, buy, sell}] at a fixed row size. Wide bars show "sell × buy" per row
// with delta shading, POC outline and bar delta; narrow bars fall back to candles.
export const footprintView = () => makeView({
  ...CANDLE_DEF, textColor: '#D1D4DC', buyColor: 'rgba(8, 153, 129, 1)', sellColor: 'rgba(242, 54, 69, 1)', pocColor: '#FFEB3B',
}, (ctx, data, o, y) => {
  const [a, b] = visible(data);
  const spacing = data.barSpacing;
  const fmt = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  for (let i = a; i <= b; i++) {
    const d = data.bars[i].originalData;
    const x = xAt(data, i);
    const up = d.close >= d.open;
    if (!d.rows?.length || spacing < 36) {
      candle(ctx, x, Math.max(1, spacing * 0.7), y(d.open), y(d.high), y(d.low), y(d.close), o, up);
      continue;
    }
    const left = x - spacing / 2 + 2;
    const width = spacing - 4;
    const candleW = Math.min(6, width * 0.12);
    candle(ctx, left + candleW / 2, candleW, y(d.open), y(d.high), y(d.low), y(d.close), o, up);
    const maxRow = Math.max(...d.rows.map((r) => r.buy + r.sell)) || 1;
    let poc = d.rows[0];
    for (const r of d.rows) if (r.buy + r.sell > poc.buy + poc.sell) poc = r;
    const cellX = left + candleW + 2;
    const cellW = width - candleW - 2;
    const rh = Math.abs(y(d.rows[0].p) - y(d.rows[0].p + d.rowSize));
    ctx.font = `${Math.max(8, Math.min(11, rh * 0.8))}px Inter, sans-serif`;
    ctx.textBaseline = 'middle';
    let delta = 0;
    for (const r of d.rows) {
      delta += r.buy - r.sell;
      const yTop = y(r.p + d.rowSize);
      const yBot = y(r.p);
      const h = Math.max(1, yBot - yTop - 1);
      ctx.globalAlpha = 0.15 + 0.55 * ((r.buy + r.sell) / maxRow);
      ctx.fillStyle = r.buy >= r.sell ? o.buyColor : o.sellColor;
      ctx.fillRect(cellX, yTop, cellW, h);
      ctx.globalAlpha = 1;
      if (r === poc) {
        ctx.strokeStyle = o.pocColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(cellX + 0.5, yTop + 0.5, cellW - 1, Math.max(0, h - 1));
      }
      if (rh >= 9 && cellW >= 44) {
        ctx.fillStyle = o.textColor;
        ctx.textAlign = 'right';
        ctx.fillText(fmt(r.sell), cellX + cellW / 2 - 3, (yTop + yBot) / 2);
        ctx.textAlign = 'left';
        ctx.fillText(fmt(r.buy), cellX + cellW / 2 + 3, (yTop + yBot) / 2);
      }
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = delta >= 0 ? o.buyColor : o.sellColor;
    // "≈" marks bars estimated from sub-interval klines rather than built from trades.
    ctx.fillText(`${d.approx ? '≈ ' : ''}Δ ${delta >= 0 ? '+' : '-'}${fmt(Math.abs(delta))}`, x, y(d.low) + 4);
  }
});

// Footprint rows for one bar from sub-interval klines: each sub-bar's volume is spread over the
// rows it spans; taker-buy volume counts as aggressive buys, the rest as aggressive sells.
export function footprintRows(subBars, rowSize) {
  const rows = new Map();
  for (const s of subBars) {
    const r0 = Math.floor(s.low / rowSize);
    const r1 = Math.floor(s.high / rowSize);
    const n = r1 - r0 + 1;
    const buy = s.takerBuy ?? s.volume / 2;
    for (let r = r0; r <= r1; r++) {
      const row = rows.get(r) ?? { p: r * rowSize, buy: 0, sell: 0 };
      row.buy += buy / n;
      row.sell += (s.volume - buy) / n;
      rows.set(r, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.p - b.p);
}

// Live trades are exact: add each aggregated trade to its price row.
export function addTradeToRows(rows, price, qty, isBuy, rowSize) {
  const p = Math.floor(price / rowSize) * rowSize;
  let row = rows.find((r) => Math.abs(r.p - p) < rowSize / 2);
  if (!row) {
    row = { p, buy: 0, sell: 0 };
    rows.push(row);
    rows.sort((x, z) => x.p - z.p);
  }
  if (isBuy) row.buy += qty;
  else row.sell += qty;
}

export const VIEW_FACTORIES = {
  volcandles: volumeCandlesView,
  hlcarea: hlcAreaView,
  columns: columnsView,
  highlow: highLowView,
  kagi: kagiView,
  pnf: pnfView,
  tpo: tpoView,
  svp: svpView,
  footprint: footprintView,
};
