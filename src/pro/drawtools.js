// Drawing tool registry: geometry renderers, default properties and settings schemas.
// Tool groups/sections mirror the TradingView Desktop drawing toolbar (inspected via the tv CLI).
// Every tool draws through `G`, which also records hit geometry, so hit-testing always matches
// exactly what is painted.

import { formatCompact, formatPrice } from './util.js';

// ---------------------------------------------------------------- colors & styles
export const TV = {
  blue: '#2962FF', red: '#F23645', green: '#089981', orange: '#FF9800', yellow: '#FFEB3B', teal: '#00BCD4',
  purple: '#9C27B0', pink: '#E91E63', gray: '#787B86', lime: '#4CAF50', indigo: '#673AB7', white: '#FFFFFF',
};

export function parseColor(c) {
  if (!c) return [41, 98, 255, 1];
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((x) => x + x).join('');
    const n = parseInt(hex.slice(0, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((s) => Number(s.trim()));
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  return [41, 98, 255, 1];
}
export const toRgba = ([r, g, b, a]) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+a.toFixed(3)})`;
export const withAlpha = (c, a) => { const p = parseColor(c); return toRgba([p[0], p[1], p[2], a]); };
export const colorAlpha = (c) => parseColor(c)[3];
export const toHex = (c) => `#${parseColor(c).slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// TradingView line styles: 0 solid, 1 dotted, 2 dashed, 3 large dashed.
export const LINE_STYLES = [
  { v: 0, label: 'Solid', icon: '━━' },
  { v: 1, label: 'Dotted', icon: '┈┈' },
  { v: 2, label: 'Dashed', icon: '╍╍' },
  { v: 3, label: 'Large dashed', icon: '‒ ‒' },
];
export function dashFor(style, w = 1) {
  switch (style) {
    case 1: return [Math.max(1, w), Math.max(2, w * 2)];
    case 2: return [w * 3 + 3, w * 2 + 2];
    case 3: return [w * 6 + 6, w * 3 + 4];
    default: return [];
  }
}

export const FONT_SIZES = [10, 11, 12, 14, 16, 20, 24, 28, 32, 40];

// ---------------------------------------------------------------- formatting
export function fmtDuration(sec) {
  const s = Math.abs(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${h ? ` ${h}h` : ''}`;
  if (h) return `${h}h${m ? ` ${m}m` : ''}`;
  return `${m}m`;
}

// ---------------------------------------------------------------- geometry helpers
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const add = (a, v, k = 1) => ({ x: a.x + v.x * k, y: a.y + v.y * k });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });

export function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  let t = len ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Clip the infinite line through a→b to the pane, extending left (before a) and/or right (after b).
export function extendSegment(a, b, w, h, left, right) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return [a, b];
  const ts = [];
  if (Math.abs(dx) > 1e-9) ts.push(-a.x / dx, (w - a.x) / dx);
  if (Math.abs(dy) > 1e-9) ts.push(-a.y / dy, (h - a.y) / dy);
  const inside = ts.filter((t) => {
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    return x >= -2 && x <= w + 2 && y >= -2 && y <= h + 2;
  });
  const tMax = right ? Math.max(1, ...inside) : 1;
  const tMin = left ? Math.min(0, ...inside) : 0;
  return [{ x: a.x + tMin * dx, y: a.y + tMin * dy }, { x: a.x + tMax * dx, y: a.y + tMax * dy }];
}

// Ray from a in direction v, clipped at the pane edge.
function rayToEdge(a, v, w, h) {
  return extendSegment(a, add(a, v), w, h, false, true)[1];
}

function circleFrom3(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

// ---------------------------------------------------------------- canvas painter with hit recording
export class G {
  constructor(ctx, w, h, hits, env) {
    this.ctx = ctx;
    this.w = w;
    this.h = h;
    this.hits = hits;
    Object.assign(this, env);
  }

  stroke(color, width = 1, style = 0) {
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.setLineDash(dashFor(style, width));
  }

  // Straight segment with optional extensions and arrow ends (TradingView leftEnd/rightEnd: 0 normal, 1 arrow).
  seg(a, b, o = {}) {
    const [p, q] = o.extendLeft || o.extendRight ? extendSegment(a, b, this.w, this.h, o.extendLeft, o.extendRight) : [a, b];
    const c = this.ctx;
    this.stroke(o.color ?? TV.blue, o.width ?? 1, o.style ?? 0);
    c.beginPath();
    c.moveTo(p.x, p.y);
    c.lineTo(q.x, q.y);
    c.stroke();
    if (o.leftEnd === 1) this.arrowHead(q, p, o.color, o.width);
    if (o.rightEnd === 1) this.arrowHead(p, q, o.color, o.width);
    if (o.hit !== false) this.hits.push({ k: 'seg', a: p, b: q });
    return [p, q];
  }

  arrowHead(from, to, color = TV.blue, width = 1) {
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    const size = 6 + width * 2.5;
    const c = this.ctx;
    c.save();
    c.setLineDash([]);
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(to.x - size * Math.cos(ang - 0.5), to.y - size * Math.sin(ang - 0.5));
    c.lineTo(to.x, to.y);
    c.lineTo(to.x - size * Math.cos(ang + 0.5), to.y - size * Math.sin(ang + 0.5));
    c.stroke();
    c.restore();
  }

  poly(pts, o = {}) {
    if (pts.length < 2) return;
    const c = this.ctx;
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    if (o.closed) c.closePath();
    if (o.fill) {
      c.fillStyle = o.fill;
      c.fill();
      if (o.hit !== false) this.hits.push({ k: 'poly', pts });
    }
    if (o.color && o.width !== 0) {
      this.stroke(o.color, o.width ?? 1, o.style ?? 0);
      if (o.round) { c.lineJoin = 'round'; c.lineCap = 'round'; }
      c.stroke();
    }
    if (o.hit !== false) {
      for (let i = 1; i < pts.length; i++) this.hits.push({ k: 'seg', a: pts[i - 1], b: pts[i], tol: o.tol });
      if (o.closed) this.hits.push({ k: 'seg', a: pts.at(-1), b: pts[0] });
    }
  }

  area(pts, fill) {
    this.poly(pts, { fill, closed: true, width: 0 });
  }

  rect(x, y, w, h, o = {}) {
    const pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    this.poly(pts, { ...o, closed: true });
  }

  ellipse(cx, cy, rx, ry, o = {}) {
    const c = this.ctx;
    const rot = o.rotation ?? 0;
    const start = o.start ?? 0;
    const end = o.end ?? Math.PI * 2;
    c.beginPath();
    c.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), rot, start, end, o.ccw ?? false);
    if (o.fill) {
      if (o.sector) { c.lineTo(cx, cy); c.closePath(); }
      c.fillStyle = o.fill;
      c.fill();
    }
    if (o.color) {
      this.stroke(o.color, o.width ?? 1, o.style ?? 0);
      c.stroke();
    }
    if (o.hit !== false) this.hits.push({ k: 'ellipse', cx, cy, rx: Math.abs(rx), ry: Math.abs(ry), rot, start, end, filled: Boolean(o.fill), ccw: o.ccw ?? false });
  }

  // Text box. Returns its bounds. align: left|center|right, baseline: top|middle|bottom.
  text(str, x, y, o = {}) {
    if (str === undefined || str === null || str === '') return null;
    const c = this.ctx;
    const size = o.size ?? 12;
    c.font = `${o.italic ? 'italic ' : ''}${o.bold ? '600 ' : ''}${size}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
    const lines = String(str).split('\n');
    const pad = o.pad ?? (o.bg ? 5 : 0);
    const lh = size * 1.3;
    const tw = Math.max(...lines.map((l) => c.measureText(l).width));
    const bw = tw + pad * 2;
    const bh = lines.length * lh + pad * 2 - (lh - size);
    let left = o.align === 'right' ? x - bw : o.align === 'center' ? x - bw / 2 : x;
    let top = o.baseline === 'bottom' ? y - bh : o.baseline === 'middle' ? y - bh / 2 : y;
    if (o.clamp) {
      left = Math.max(2, Math.min(left, this.w - bw - 2));
      top = Math.max(2, Math.min(top, this.h - bh - 2));
    }
    c.save();
    c.setLineDash([]);
    if (o.angle) {
      c.translate(x, y);
      c.rotate(o.angle);
      c.translate(-x, -y);
    }
    if (o.bg || o.border) {
      c.beginPath();
      c.roundRect(left, top, bw, bh, o.radius ?? 3);
      if (o.bg) { c.fillStyle = o.bg; c.fill(); }
      if (o.border) { c.strokeStyle = o.border; c.lineWidth = 1; c.stroke(); }
    }
    c.fillStyle = o.color ?? '#fff';
    c.textBaseline = 'top';
    c.textAlign = 'left';
    lines.forEach((l, i) => {
      const lw = c.measureText(l).width;
      const lx = o.textAlign === 'center' ? left + (bw - lw) / 2 : o.textAlign === 'right' ? left + bw - pad - lw : left + pad;
      c.fillText(l, lx, top + pad + i * lh);
    });
    c.restore();
    const box = { x: left, y: top, w: bw, h: bh };
    if (o.hit && !o.angle) this.hits.push({ k: 'box', ...box });
    return box;
  }

  pill(str, x, y, bg, o = {}) {
    return this.text(str, x, y, { bg, color: o.color ?? '#fff', size: o.size ?? 11, pad: 4, align: o.align ?? 'center', baseline: o.baseline ?? 'middle', radius: 3, clamp: true, hit: o.hit });
  }

  dot(p, color, r = 3) {
    const c = this.ctx;
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.fillStyle = color;
    c.fill();
  }
}

export function hitPrim(prim, p, tol = 6) {
  switch (prim.k) {
    case 'seg': return distToSegment(p, prim.a, prim.b) <= (prim.tol ?? tol);
    case 'poly': return pointInPolygon(p, prim.pts);
    case 'box': return p.x >= prim.x - 2 && p.x <= prim.x + prim.w + 2 && p.y >= prim.y - 2 && p.y <= prim.y + prim.h + 2;
    case 'ellipse': {
      if (!prim.rx || !prim.ry) return false;
      const cos = Math.cos(-prim.rot);
      const sin = Math.sin(-prim.rot);
      const dx = p.x - prim.cx;
      const dy = p.y - prim.cy;
      const x = dx * cos - dy * sin;
      const y = dx * sin + dy * cos;
      const r = Math.hypot(x / prim.rx, y / prim.ry);
      const full = Math.abs(prim.end - prim.start) >= Math.PI * 2 - 1e-6;
      if (!full) {
        const norm = (v) => ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        let s = norm(prim.start);
        let e = norm(prim.end);
        if (prim.ccw) [s, e] = [e, s];
        const ang = norm(Math.atan2(y / prim.ry, x / prim.rx));
        const within = s <= e ? ang >= s && ang <= e : ang >= s || ang <= e;
        if (!within) return false;
      }
      if (prim.filled && r <= 1) return true;
      return Math.abs(r - 1) * Math.min(prim.rx, prim.ry) <= tol;
    }
    default: return false;
  }
}

// ---------------------------------------------------------------- settings schema helpers
const S = {
  section: (label) => ({ t: 'section', label }),
  line: (label = 'Line', c = 'lineColor', w = 'lineWidth', s = 'lineStyle') => ({ t: 'line', label, c, w, s }),
  color: (key, label) => ({ t: 'color', key, label }),
  fill: (label = 'Background', on = 'fill', c = 'fillColor') => ({ t: 'fill', label, on, c }),
  check: (key, label) => ({ t: 'check', key, label }),
  select: (key, label, options) => ({ t: 'select', key, label, options }),
  num: (key, label, min = 0, max = 1e9, step = 1) => ({ t: 'num', key, label, min, max, step }),
  levels: (key = 'levels', label = 'Levels') => ({ t: 'levels', key, label }),
  font: () => ({ t: 'font' }),
  textarea: (key = 'text') => ({ t: 'textarea', key }),
  align: () => ({ t: 'align' }),
};
const ENDS = [[0, 'Normal'], [1, 'Arrow']];
const STATS_POS = [[0, 'Left'], [1, 'Center'], [2, 'Right']];
const TEXT_TAB = [S.textarea(), S.font(), S.align()];
const LINE_DEF = { lineColor: TV.blue, lineWidth: 2, lineStyle: 0 };
const TEXT_DEF = { text: '', textColor: TV.blue, fontSize: 14, bold: false, italic: false, hAlign: 'center', vAlign: 'bottom' };
const STATS_DEF = {
  showPriceRange: false, showPercent: false, showTicks: false, showBars: false, showDateRange: false,
  showDistance: false, showAngle: false, alwaysShowStats: false, statsPos: 2, showMiddlePoint: false, showPriceLabels: false,
};
const LINE_STYLE_TAB = [
  S.line(),
  S.select('leftEnd', 'Left end', ENDS),
  S.select('rightEnd', 'Right end', ENDS),
  S.check('extendLeft', 'Extend left'),
  S.check('extendRight', 'Extend right'),
  S.check('showMiddlePoint', 'Middle point'),
  S.check('showPriceLabels', 'Price labels'),
  S.section('Stats'),
  S.check('showPriceRange', 'Price range'),
  S.check('showPercent', 'Percent change'),
  S.check('showTicks', 'Change in ticks'),
  S.check('showBars', 'Bars range'),
  S.check('showDateRange', 'Date/time range'),
  S.check('showDistance', 'Distance'),
  S.check('showAngle', 'Angle'),
  S.select('statsPos', 'Stats position', STATS_POS),
  S.check('alwaysShowStats', 'Always show stats'),
];

function fibLevels(values, colors, onSet) {
  return values.map((v, i) => ({ v, color: colors[i % colors.length], on: onSet ? onSet.includes(v) : true }));
}
const FIB_COLORS = [TV.gray, TV.red, TV.orange, TV.lime, TV.green, TV.teal, TV.gray, TV.blue, TV.red, TV.purple, TV.pink, TV.orange, TV.indigo, TV.teal, TV.green];
const FIB_RET_VALUES = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236, 1.272, 1.414, 2, 2.272];
const FIB_RET_ON = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236];
const FIB_TAB = [
  S.check('showTrend', 'Trend line'),
  S.line('Trend line style', 'lineColor', 'lineWidth', 'lineStyle'),
  S.levels(),
  S.num('levelsWidth', 'Levels line width', 1, 4),
  S.select('levelsStyle', 'Levels line style', LINE_STYLES.map((l) => [l.v, l.label])),
  S.select('extend', 'Extend lines', [['none', "Don't extend"], ['left', 'Left'], ['right', 'Right'], ['both', 'Both']]),
  S.check('reverse', 'Reverse'),
  S.check('showPrices', 'Prices'),
  S.select('showLevels', 'Levels', [['values', 'Values'], ['percent', 'Percents'], ['none', 'Hidden']]),
  S.select('labelsH', 'Labels', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]),
  S.select('labelsV', 'Labels position', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]),
  S.check('fill', 'Background'),
  S.num('fillOpacity', 'Background transparency %', 0, 100),
  S.num('fontSize', 'Font size', 8, 40),
];
const FIB_DEF = {
  showTrend: true, lineColor: TV.gray, lineWidth: 1, lineStyle: 2, levelsWidth: 1, levelsStyle: 0, extend: 'none', reverse: false,
  showPrices: true, showLevels: 'values', labelsH: 'left', labelsV: 'bottom', fill: true, fillOpacity: 85, fontSize: 12,
};

// ---------------------------------------------------------------- shared renderers
function lineStats(g, a, b, d) {
  const p = d.props;
  const [pa, pb] = d.points;
  const out = [];
  const dp = pb.price - pa.price;
  if (p.showPriceRange || p.showPercent || p.showTicks) {
    const parts = [];
    if (p.showPriceRange) parts.push(`${dp >= 0 ? '+' : ''}${g.fmt(dp)}`);
    if (p.showPercent) parts.push(`(${((dp / pa.price) * 100).toFixed(2)}%)`);
    if (p.showTicks) parts.push(`${Math.round(dp / g.tick).toLocaleString()} ticks`);
    out.push(parts.join(' '));
  }
  if (p.showBars || p.showDateRange) {
    const bars = Math.round(g.L.timeToLogical(pb.time) - g.L.timeToLogical(pa.time));
    const parts = [];
    if (p.showBars) parts.push(`${bars} bars`);
    if (p.showDateRange) parts.push(fmtDuration(pb.time - pa.time));
    out.push(parts.join(', '));
  }
  if (p.showDistance) out.push(`Distance: ${Math.round(dist(a, b))} px`);
  if (p.showAngle) out.push(`∠ ${((-Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI).toFixed(2)}°`);
  return out;
}

function drawLineText(g, a, b, p) {
  if (!p.text) return;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const flip = Math.abs(ang) > Math.PI / 2;
  const angle = flip ? ang + Math.PI : ang;
  const t = p.hAlign === 'left' ? 0 : p.hAlign === 'right' ? 1 : 0.5;
  const pos = lerp(a, b, t);
  const align = p.hAlign === 'left' ? (flip ? 'right' : 'left') : p.hAlign === 'right' ? (flip ? 'left' : 'right') : 'center';
  const baseline = p.vAlign === 'top' ? 'bottom' : p.vAlign === 'middle' ? 'middle' : 'top';
  const off = p.vAlign === 'top' ? -4 : p.vAlign === 'bottom' ? 4 : 0;
  g.text(p.text, pos.x, pos.y + off, { color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, align, baseline, angle });
}

function drawLineTool(g) {
  const { d, P } = g;
  const p = d.props;
  const [a, b] = P;
  g.seg(a, b, {
    color: p.lineColor, width: p.lineWidth, style: p.lineStyle,
    extendLeft: p.extendLeft, extendRight: p.extendRight, leftEnd: p.leftEnd, rightEnd: p.rightEnd,
  });
  if (p.showMiddlePoint) g.dot(mid(a, b), p.lineColor, 3);
  if (p.showPriceLabels) {
    g.pill(g.fmt(d.points[0].price), a.x, a.y + (a.y <= b.y ? -14 : 14), p.lineColor);
    g.pill(g.fmt(d.points[1].price), b.x, b.y + (b.y < a.y ? -14 : 14), p.lineColor);
  }
  drawLineText(g, a, b, p);
  if (p.alwaysShowStats || g.selected) {
    const lines = lineStats(g, a, b, d);
    if (lines.length) {
      const anchor = p.statsPos === 0 ? a : p.statsPos === 1 ? mid(a, b) : b;
      g.text(lines.join('\n'), anchor.x + 10, anchor.y + 10, { bg: 'rgba(19,23,34,.85)', color: '#d1d4dc', size: 12, pad: 6, radius: 4, clamp: true });
    }
  }
}

function drawHorizontalText(g, y, x0, x1, p) {
  if (!p.text) return;
  const x = p.hAlign === 'left' ? x0 + 6 : p.hAlign === 'right' ? x1 - 70 : (x0 + x1) / 2;
  const align = p.hAlign === 'left' ? 'left' : p.hAlign === 'right' ? 'right' : 'center';
  const baseline = p.vAlign === 'top' ? 'bottom' : p.vAlign === 'middle' ? 'middle' : 'top';
  g.text(p.text, x, y + (p.vAlign === 'top' ? -3 : p.vAlign === 'bottom' ? 3 : 0), {
    color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, align, baseline,
    bg: p.vAlign === 'middle' ? g.bg : undefined, pad: p.vAlign === 'middle' ? 3 : 0,
  });
}

function levelLabel(g, lvl, price, p) {
  const coeff = p.showLevels === 'percent' ? `${(lvl * 100).toFixed(1)}%` : p.showLevels === 'none' ? '' : `${lvl}`;
  const pr = p.showPrices ? g.fmt(price) : '';
  if (!coeff && !pr) return '';
  return coeff && pr ? `${coeff} (${pr})` : coeff || pr;
}

function fibHorizontalLevels(g, levels, priceAt, xLeft, xRight, p) {
  const ext = p.extend;
  const L = ext === 'left' || ext === 'both' ? 0 : xLeft;
  const R = ext === 'right' || ext === 'both' ? g.w : xRight;
  const visible = levels.filter((l) => l.on).sort((x, y) => x.v - y.v);
  let prevY = null;
  for (const lvl of visible) {
    const price = priceAt(lvl.v);
    const y = g.y(price);
    if (y === null) continue;
    if (p.fill && prevY !== null) g.area([{ x: L, y: prevY }, { x: R, y: prevY }, { x: R, y }, { x: L, y }], withAlpha(lvl.color, 1 - p.fillOpacity / 100));
    g.seg({ x: L, y }, { x: R, y }, { color: lvl.color, width: p.levelsWidth, style: p.levelsStyle });
    const text = levelLabel(g, lvl.v, price, p);
    if (text) {
      const tx = p.labelsH === 'left' ? L + 4 : p.labelsH === 'right' ? R - 4 : (L + R) / 2;
      const baseline = p.labelsV === 'top' ? 'bottom' : p.labelsV === 'middle' ? 'middle' : 'top';
      g.text(text, tx, y + (p.labelsV === 'top' ? -2 : p.labelsV === 'bottom' ? 2 : 0), {
        color: lvl.color, size: p.fontSize, align: p.labelsH, baseline,
        bg: p.labelsV === 'middle' ? g.bg : undefined, pad: p.labelsV === 'middle' ? 2 : 0,
      });
    }
    prevY = y;
  }
}

function patternLabel(g, P, i, label, p) {
  const pt = P[i];
  const prev = P[i - 1] ?? P[i + 1] ?? pt;
  const next = P[i + 1] ?? P[i - 1] ?? pt;
  const isHigh = pt.y <= Math.min(prev.y, next.y);
  g.text(label, pt.x, pt.y + (isHigh ? -6 : 6), { color: p.textColor, size: p.fontSize, bold: p.bold, align: 'center', baseline: isHigh ? 'bottom' : 'top', bg: withAlpha(p.lineColor, 0.85), pad: 4, radius: 3 });
}

function ratioLabel(g, a, b, value, p) {
  if (!Number.isFinite(value)) return;
  g.seg(a, b, { color: p.lineColor, width: 1, style: 2, hit: false });
  const m = mid(a, b);
  g.text(value.toFixed(3), m.x, m.y, { color: p.textColor, size: Math.max(10, p.fontSize - 2), align: 'center', baseline: 'middle', bg: withAlpha(p.lineColor, 0.85), pad: 3 });
}

function drawZigzag(g, labels, fills = []) {
  const { P, d } = g;
  const p = d.props;
  if (p.fill) for (const tri of fills) { const pts = tri.map((i) => P[i]).filter(Boolean); if (pts.length === 3) g.area(pts, p.fillColor); }
  g.poly(P, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
  labels.forEach((label, i) => { if (label && P[i]) patternLabel(g, P, i, label, p); });
}

const PATTERN_DEF = { lineColor: TV.blue, lineWidth: 2, lineStyle: 0, fill: true, fillColor: 'rgba(41, 98, 255, 0.2)', textColor: '#FFFFFF', fontSize: 12, bold: false };
const PATTERN_TAB = [S.line(), S.fill(), S.color('textColor', 'Text color'), S.num('fontSize', 'Font size', 8, 40), S.check('bold', 'Bold')];
const WAVE_DEF = { lineColor: TV.blue, lineWidth: 2, lineStyle: 0, fill: false, fillColor: 'rgba(41,98,255,0.1)', textColor: '#FFFFFF', fontSize: 12, bold: true };
const WAVE_TAB = [S.line(), S.color('textColor', 'Labels color'), S.num('fontSize', 'Font size', 8, 40)];
const SHAPE_DEF = { lineColor: TV.blue, lineWidth: 2, lineStyle: 0, fill: true, fillColor: 'rgba(41, 98, 255, 0.2)', ...TEXT_DEF, textColor: '#FFFFFF', vAlign: 'middle' };
const SHAPE_TAB = [S.line('Border'), S.fill()];

function priceRangeLabel(g, d) {
  const [a, b] = d.points;
  const dp = b.price - a.price;
  return `${dp >= 0 ? '+' : ''}${g.fmt(dp)} (${((dp / a.price) * 100).toFixed(2)}%) ${Math.round(dp / g.tick).toLocaleString()}`;
}
function dateRangeLabel(g, d) {
  const [a, b] = d.points;
  const la = g.L.timeToLogical(a.time);
  const lb = g.L.timeToLogical(b.time);
  let vol = 0;
  const i0 = Math.max(0, Math.round(Math.min(la, lb)));
  const i1 = Math.min(g.candles.length - 1, Math.round(Math.max(la, lb)));
  for (let i = i0; i <= i1; i++) vol += g.candles[i]?.volume ?? 0;
  return { bars: Math.round(lb - la), dur: fmtDuration(b.time - a.time), vol };
}

// Volume profile rows for a bar range (volume spread evenly across the rows each bar spans).
export function volumeProfile(candles, i0, i1, rows, vaPct) {
  const slice = candles.slice(Math.max(0, i0), Math.min(candles.length, i1 + 1));
  if (!slice.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of slice) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); }
  const step = (hi - lo) / rows || 1;
  const up = new Array(rows).fill(0);
  const down = new Array(rows).fill(0);
  for (const c of slice) {
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor((c.low - lo) / step)));
    const r1 = Math.max(0, Math.min(rows - 1, Math.floor((c.high - lo) / step)));
    const share = c.volume / (r1 - r0 + 1);
    for (let r = r0; r <= r1; r++) (c.close >= c.open ? up : down)[r] += share;
  }
  const total = up.map((u, i) => u + down[i]);
  let poc = 0;
  total.forEach((v, i) => { if (v > total[poc]) poc = i; });
  const sum = total.reduce((s, v) => s + v, 0);
  let vaLo = poc;
  let vaHi = poc;
  let acc = total[poc];
  while (acc < sum * vaPct && (vaLo > 0 || vaHi < rows - 1)) {
    const below = vaLo > 0 ? total[vaLo - 1] : -1;
    const above = vaHi < rows - 1 ? total[vaHi + 1] : -1;
    if (above >= below) { vaHi++; acc += total[vaHi]; } else { vaLo--; acc += total[vaLo]; }
  }
  return { lo, hi, step, up, down, total, poc, vaLo, vaHi, max: Math.max(...total) || 1 };
}

function drawProfile(g, i0, i1, x0, x1) {
  const p = g.d.props;
  const vp = volumeProfile(g.candles, i0, i1, Math.max(4, Math.round(p.rows)), p.valueArea / 100);
  if (!vp) return;
  const width = Math.max(20, Math.abs(x1 - x0) * (p.widthPct / 100));
  const right = p.placement === 'right';
  const edge = right ? Math.max(x0, x1) : Math.min(x0, x1);
  const c = g.ctx;
  for (let r = 0; r < vp.total.length; r++) {
    const yTop = g.y(vp.lo + (r + 1) * vp.step);
    const yBot = g.y(vp.lo + r * vp.step);
    if (yTop === null || yBot === null) continue;
    const hgt = Math.max(1, Math.abs(yBot - yTop) - 1);
    const inVA = r >= vp.vaLo && r <= vp.vaHi;
    const upW = (vp.up[r] / vp.max) * width;
    const dnW = (vp.down[r] / vp.max) * width;
    c.fillStyle = withAlpha(p.upColor, inVA ? p.vaOpacity : p.outOpacity);
    c.fillRect(right ? edge - upW : edge, Math.min(yTop, yBot), upW, hgt);
    c.fillStyle = withAlpha(p.downColor, inVA ? p.vaOpacity : p.outOpacity);
    c.fillRect(right ? edge - upW - dnW : edge + upW, Math.min(yTop, yBot), dnW, hgt);
  }
  const yHi = g.y(vp.hi);
  const yLo = g.y(vp.lo);
  if (yHi !== null && yLo !== null) g.hits.push({ k: 'box', x: Math.min(x0, x1), y: yHi, w: Math.max(Math.abs(x1 - x0), width), h: yLo - yHi });
  if (p.showPoc) {
    const yPoc = g.y(vp.lo + (vp.poc + 0.5) * vp.step);
    if (yPoc !== null) g.seg({ x: Math.min(x0, x1), y: yPoc }, { x: p.extendPoc ? g.w : Math.max(x0, x1), y: yPoc }, { color: p.pocColor, width: 2 });
  }
}

// ---------------------------------------------------------------- the registry
const T = [];
const def = (tool) => { T.push(tool); return tool; };

// ===== Cursors (modes, not drawings)
for (const [id, label, icon] of [['cross', 'Cross', '✛'], ['dot', 'Dot', '•'], ['arrow', 'Arrow', '➚'], ['demo', 'Demonstration', '✺'], ['eraser', 'Eraser', '⌫']]) {
  def({ id, label, icon, group: 'cursors', section: 'Cursors', cursor: true });
}

// ===== Trend tools: Lines
def({
  id: 'trend', label: 'Trendline', icon: '╱', group: 'lines', section: 'Lines', n: 2, key: 'Alt+T', alertable: true,
  defaults: { ...LINE_DEF, extendLeft: false, extendRight: false, leftEnd: 0, rightEnd: 0, ...STATS_DEF, ...TEXT_DEF },
  style: LINE_STYLE_TAB, textTab: TEXT_TAB, draw: (g) => drawLineTool(g),
});
def({
  id: 'ray', label: 'Ray', icon: '↗', group: 'lines', section: 'Lines', n: 2,
  defaults: { ...LINE_DEF, extendLeft: false, extendRight: true, leftEnd: 0, rightEnd: 0, ...STATS_DEF, ...TEXT_DEF },
  style: LINE_STYLE_TAB, textTab: TEXT_TAB, draw: (g) => drawLineTool(g),
});
def({
  id: 'infoline', label: 'Info line', icon: 'ⓘ', group: 'lines', section: 'Lines', n: 2,
  defaults: {
    ...LINE_DEF, extendLeft: false, extendRight: false, leftEnd: 0, rightEnd: 0, ...STATS_DEF,
    showPriceRange: true, showPercent: true, showTicks: true, showBars: true, showDateRange: true, showDistance: true, showAngle: true, alwaysShowStats: true, statsPos: 1, ...TEXT_DEF,
  },
  style: LINE_STYLE_TAB, textTab: TEXT_TAB, draw: (g) => drawLineTool(g),
});
def({
  id: 'extended', label: 'Extended line', icon: '⟋', group: 'lines', section: 'Lines', n: 2,
  defaults: { ...LINE_DEF, extendLeft: true, extendRight: true, leftEnd: 0, rightEnd: 0, ...STATS_DEF, ...TEXT_DEF },
  style: LINE_STYLE_TAB, textTab: TEXT_TAB, draw: (g) => drawLineTool(g),
});
def({
  id: 'trendangle', label: 'Trend angle', icon: '∠', group: 'lines', section: 'Lines', n: 2,
  defaults: { ...LINE_DEF, extendLeft: false, extendRight: false, leftEnd: 0, rightEnd: 0, ...STATS_DEF, ...TEXT_DEF },
  style: LINE_STYLE_TAB.slice(0, 5), textTab: TEXT_TAB,
  draw: (g) => {
    drawLineTool(g);
    const [a, b] = g.P;
    const p = g.d.props;
    const r = Math.min(60, dist(a, b));
    g.seg(a, { x: a.x + r * 1.3, y: a.y }, { color: p.lineColor, width: 1, style: 2, hit: false });
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    g.ellipse(a.x, a.y, r, r, { color: p.lineColor, width: 1, start: Math.min(0, ang), end: Math.max(0, ang), hit: false });
    g.text(`${((-ang * 180) / Math.PI).toFixed(2)}°`, a.x + r + 6, a.y + (ang < 0 ? -10 : 10), { color: p.lineColor, size: 12, baseline: 'middle' });
  },
});
def({
  id: 'hline', label: 'Horizontal line', icon: '─', group: 'lines', section: 'Lines', n: 1, key: 'Alt+H', axis: 'price', alertable: true,
  defaults: { lineColor: TV.blue, lineWidth: 1, lineStyle: 0, showPrice: true, ...TEXT_DEF, hAlign: 'right', vAlign: 'top', fontSize: 12 },
  style: [S.line(), S.check('showPrice', 'Price label')], textTab: TEXT_TAB,
  draw: (g) => {
    const p = g.d.props;
    const y = g.P[0].y;
    g.seg({ x: 0, y }, { x: g.w, y }, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    drawHorizontalText(g, y, 0, g.w, p);
    if (p.showPrice) g.pill(g.fmt(g.d.points[0].price), g.w - 2, y, p.lineColor, { align: 'right' });
  },
});
def({
  id: 'hray', label: 'Horizontal ray', icon: '⟶', group: 'lines', section: 'Lines', n: 1, alertable: true,
  defaults: { lineColor: TV.blue, lineWidth: 1, lineStyle: 0, showPrice: true, ...TEXT_DEF, hAlign: 'right', vAlign: 'top', fontSize: 12 },
  style: [S.line(), S.check('showPrice', 'Price label')], textTab: TEXT_TAB,
  draw: (g) => {
    const p = g.d.props;
    const a = g.P[0];
    g.seg(a, { x: g.w, y: a.y }, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    drawHorizontalText(g, a.y, a.x, g.w, p);
    if (p.showPrice) g.pill(g.fmt(g.d.points[0].price), g.w - 2, a.y, p.lineColor, { align: 'right' });
  },
});
def({
  id: 'vline', label: 'Vertical line', icon: '│', group: 'lines', section: 'Lines', n: 1, key: 'Alt+V', axis: 'time',
  defaults: { lineColor: TV.blue, lineWidth: 1, lineStyle: 0, showTime: true, ...TEXT_DEF, hAlign: 'center', vAlign: 'middle' },
  style: [S.line(), S.check('showTime', 'Time label')], textTab: TEXT_TAB,
  draw: (g) => {
    const p = g.d.props;
    const x = g.P[0].x;
    g.seg({ x, y: 0 }, { x, y: g.h }, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    if (p.text) {
      const y = p.vAlign === 'top' ? 60 : p.vAlign === 'bottom' ? g.h - 60 : g.h / 2;
      g.text(p.text, x - 4, y, { color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, align: 'center', baseline: 'bottom', angle: -Math.PI / 2 });
    }
    if (p.showTime) g.pill(g.fmtTime(g.d.points[0].time), x, g.h - 10, p.lineColor);
  },
});
def({
  id: 'crossline', label: 'Crossline', icon: '┼', group: 'lines', section: 'Lines', n: 1,
  defaults: { lineColor: TV.blue, lineWidth: 1, lineStyle: 0, showPrice: true, showTime: true },
  style: [S.line(), S.check('showPrice', 'Price label'), S.check('showTime', 'Time label')],
  draw: (g) => {
    const p = g.d.props;
    const a = g.P[0];
    g.seg({ x: 0, y: a.y }, { x: g.w, y: a.y }, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    g.seg({ x: a.x, y: 0 }, { x: a.x, y: g.h }, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    if (p.showPrice) g.pill(g.fmt(g.d.points[0].price), g.w - 2, a.y, p.lineColor, { align: 'right' });
    if (p.showTime) g.pill(g.fmtTime(g.d.points[0].time), a.x, g.h - 10, p.lineColor);
  },
});

// ===== Trend tools: Channels
function channelOffset(a, b, c) {
  if (Math.abs(b.x - a.x) < 1e-9) return c.y - a.y;
  const t = (c.x - a.x) / (b.x - a.x);
  return c.y - (a.y + t * (b.y - a.y));
}
const CHANNEL_DEF = { ...LINE_DEF, fill: true, fillColor: 'rgba(41, 98, 255, 0.2)', showMiddle: true, midColor: TV.blue, midWidth: 1, midStyle: 2, extendLeft: false, extendRight: false };
const CHANNEL_TAB = [S.line(), S.check('showMiddle', 'Middle line'), S.line('Middle line style', 'midColor', 'midWidth', 'midStyle'), S.fill(), S.check('extendLeft', 'Extend left'), S.check('extendRight', 'Extend right')];
def({
  id: 'channel', label: 'Parallel channel', icon: '▱', group: 'lines', section: 'Channels', n: 3,
  defaults: CHANNEL_DEF, style: CHANNEL_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [a, b, c0] = g.P;
    const off = channelOffset(a, b, c0 ?? b);
    const a2 = { x: a.x, y: a.y + off };
    const b2 = { x: b.x, y: b.y + off };
    if (p.fill) {
      const [s1, e1] = extendSegment(a, b, g.w, g.h, p.extendLeft, p.extendRight);
      const [s2, e2] = extendSegment(a2, b2, g.w, g.h, p.extendLeft, p.extendRight);
      g.area([s1, e1, e2, s2], p.fillColor);
    }
    const o = { color: p.lineColor, width: p.lineWidth, style: p.lineStyle, extendLeft: p.extendLeft, extendRight: p.extendRight };
    g.seg(a, b, o);
    g.seg(a2, b2, o);
    if (p.showMiddle) g.seg({ x: a.x, y: a.y + off / 2 }, { x: b.x, y: b.y + off / 2 }, { color: p.midColor, width: p.midWidth, style: p.midStyle, extendLeft: p.extendLeft, extendRight: p.extendRight });
  },
  handles: (g) => {
    const [a, b, c] = g.P;
    if (!c) return g.P;
    const off = channelOffset(a, b, c);
    return [a, b, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + off }];
  },
});
def({
  id: 'regression', label: 'Regression trend', icon: '⫽', group: 'lines', section: 'Channels', n: 2, axis: 'time',
  defaults: { lineColor: TV.red, lineWidth: 1, lineStyle: 0, upColor: TV.blue, downColor: TV.red, deviation: 2, source: 'close', fill: true, extendRight: false, showPearson: true, upFill: 'rgba(41, 98, 255, 0.15)', downFill: 'rgba(242, 54, 69, 0.15)' },
  style: [
    S.line('Base line'), S.color('upColor', 'Upper deviation'), S.color('downColor', 'Lower deviation'), S.num('deviation', 'Deviation', 0.1, 10, 0.1),
    S.select('source', 'Source', [['close', 'Close'], ['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['hl2', '(H+L)/2'], ['hlc3', '(H+L+C)/3']]),
    S.check('fill', 'Background'), S.check('extendRight', 'Extend lines'), S.check('showPearson', "Pearson's R"),
  ],
  regression(g) {
    const d = g.d;
    const l0 = Math.round(g.L.timeToLogical(d.points[0].time));
    const l1 = Math.round(g.L.timeToLogical(d.points[1].time));
    const i0 = Math.max(0, Math.min(l0, l1));
    const i1 = Math.min(g.candles.length - 1, Math.max(l0, l1));
    if (i1 - i0 < 2) return null;
    const src = (c) => ({ open: c.open, high: c.high, low: c.low, hl2: (c.high + c.low) / 2, hlc3: (c.high + c.low + c.close) / 3 }[d.props.source] ?? c.close);
    const ys = [];
    for (let i = i0; i <= i1; i++) ys.push(src(g.candles[i]));
    const n = ys.length;
    const mx = (n - 1) / 2;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    ys.forEach((v, i) => { sxy += (i - mx) * (v - my); sxx += (i - mx) ** 2; syy += (v - my) ** 2; });
    const slope = sxy / sxx;
    const icpt = my - slope * mx;
    const sd = Math.sqrt(ys.reduce((s, v, i) => s + (v - (icpt + slope * i)) ** 2, 0) / n);
    const r = syy ? sxy / Math.sqrt(sxx * syy) : 0;
    return { i0, i1, at: (i) => icpt + slope * (i - i0), sd, r };
  },
  draw(g) {
    const p = g.d.props;
    const reg = this.regression(g);
    if (!reg) return;
    const iEnd = p.extendRight ? g.lx(g.w) : reg.i1;
    const at = (i, k) => ({ x: g.xl(i), y: g.y(reg.at(i) + k * p.deviation * reg.sd) });
    const base0 = at(reg.i0, 0);
    const base1 = at(iEnd, 0);
    const up0 = at(reg.i0, 1);
    const up1 = at(iEnd, 1);
    const dn0 = at(reg.i0, -1);
    const dn1 = at(iEnd, -1);
    if (p.fill) {
      g.area([up0, up1, base1, base0], p.upFill);
      g.area([base0, base1, dn1, dn0], p.downFill);
    }
    g.seg(up0, up1, { color: p.upColor, width: p.lineWidth });
    g.seg(dn0, dn1, { color: p.downColor, width: p.lineWidth });
    g.seg(base0, base1, { color: p.lineColor, width: p.lineWidth, style: 2 });
    if (p.showPearson) g.text(`R: ${reg.r.toFixed(4)}`, base0.x, Math.max(dn0.y, up0.y) + 6, { color: p.lineColor, size: 11, align: 'left', baseline: 'top' });
  },
  handles(g) {
    const reg = this.regression(g);
    if (!reg) return g.P;
    return [{ x: g.xl(reg.i0), y: g.y(reg.at(reg.i0)) }, { x: g.xl(reg.i1), y: g.y(reg.at(reg.i1)) }];
  },
});
def({
  id: 'flattop', label: 'Flat top/bottom', icon: '⏢', group: 'lines', section: 'Channels', n: 3,
  defaults: { ...LINE_DEF, fill: true, fillColor: 'rgba(41, 98, 255, 0.2)', extendLeft: false, extendRight: false },
  style: [S.line(), S.fill(), S.check('extendLeft', 'Extend left'), S.check('extendRight', 'Extend right')],
  draw: (g) => {
    const p = g.d.props;
    const [a, b, c] = g.P;
    const yf = (c ?? a).y;
    const o = { color: p.lineColor, width: p.lineWidth, style: p.lineStyle, extendLeft: p.extendLeft, extendRight: p.extendRight };
    if (p.fill) g.area([a, b, { x: b.x, y: yf }, { x: a.x, y: yf }], p.fillColor);
    g.seg(a, b, o);
    g.seg({ x: a.x, y: yf }, { x: b.x, y: yf }, o);
  },
  handles: (g) => { const [a, b, c] = g.P; return c ? [a, b, { x: b.x, y: c.y }] : g.P; },
  moveHandle: (d, i, pt) => {
    if (i <= 1) d.points[i] = pt;
    else d.points[2] = { time: d.points[1].time, price: pt.price };
  },
});
def({
  id: 'disjoint', label: 'Disjoint channel', icon: '⋎', group: 'lines', section: 'Channels', n: 3,
  defaults: { ...LINE_DEF, fill: true, fillColor: 'rgba(41, 98, 255, 0.2)', extendLeft: false, extendRight: false },
  style: [S.line(), S.fill(), S.check('extendLeft', 'Extend left'), S.check('extendRight', 'Extend right')],
  draw: (g) => {
    const p = g.d.props;
    const [a, b, c0] = g.P;
    const c = c0 ?? a;
    const e = { x: b.x, y: c.y - (b.y - a.y) };
    const o = { color: p.lineColor, width: p.lineWidth, style: p.lineStyle, extendLeft: p.extendLeft, extendRight: p.extendRight };
    if (p.fill) g.area([a, b, e, c], p.fillColor);
    g.seg(a, b, o);
    g.seg(c, e, o);
  },
});

// ===== Trend tools: Pitchforks
const PF_LEVELS = [0.25, 0.382, 0.5, 0.618, 0.75, 1, 1.5, 1.75, 2];
const PF_DEF = { lineWidth: 1, lineStyle: 0, medianColor: TV.red, levels: fibLevels(PF_LEVELS, [TV.teal, TV.lime, TV.green, TV.teal, TV.blue, TV.blue, TV.purple, TV.pink, TV.orange], [0.5, 1]), fill: true, fillOpacity: 85, levelsWidth: 1, extendLines: false };
const PF_TAB = [S.line('Median', 'medianColor', 'lineWidth', 'lineStyle'), S.levels(), S.num('levelsWidth', 'Levels line width', 1, 4), S.check('fill', 'Background'), S.num('fillOpacity', 'Background transparency %', 0, 100), S.check('extendLines', 'Extend lines')];
function pitchfork(g, variant) {
  const p = g.d.props;
  const [A, B, C] = g.P;
  if (!C) { g.seg(A, B, { color: p.medianColor, width: p.lineWidth }); return; }
  const M = mid(B, C);
  let O = A;
  if (variant === 'schiff') O = { x: A.x, y: (A.y + B.y) / 2 };
  if (variant === 'modschiff') O = mid(A, B);
  if (variant === 'inside') O = mid(A, M);
  const v = sub(M, O);
  if (Math.hypot(v.x, v.y) < 1e-6) return;
  const far = (start) => (p.extendLines ? rayToEdge(start, v, g.w, g.h) : add(start, v, 1));
  let prevUp = M;
  let prevDn = M;
  for (const lvl of p.levels.filter((l) => l.on).sort((x, y) => x.v - y.v)) {
    const up = lerp(M, B, lvl.v);
    const dn = lerp(M, C, lvl.v);
    if (p.fill) {
      const col = withAlpha(lvl.color, 1 - p.fillOpacity / 100);
      g.area([prevUp, far(prevUp), far(up), up], col);
      g.area([prevDn, far(prevDn), far(dn), dn], col);
    }
    g.seg(up, far(up), { color: lvl.color, width: p.levelsWidth });
    g.seg(dn, far(dn), { color: lvl.color, width: p.levelsWidth });
    prevUp = up;
    prevDn = dn;
  }
  g.seg(B, C, { color: p.medianColor, width: p.lineWidth });
  g.seg(O, far(M), { color: p.medianColor, width: p.lineWidth, style: p.lineStyle });
  if (variant !== 'standard') g.seg(A, O, { color: p.medianColor, width: 1, style: 2, hit: false });
}
for (const [id, label, variant] of [['pitchfork', 'Pitchfork', 'standard'], ['schiff', 'Schiff pitchfork', 'schiff'], ['modschiff', 'Modified Schiff pitchfork', 'modschiff'], ['insidepf', 'Inside pitchfork', 'inside']]) {
  def({ id, label, icon: 'Ψ', group: 'lines', section: 'Pitchforks', n: 3, defaults: PF_DEF, style: PF_TAB, draw: (g) => pitchfork(g, variant) });
}

// ===== Gann & Fibonacci
def({
  id: 'fib', label: 'Fib retracement', icon: '≣', group: 'fib', section: 'Fibonacci', n: 2, key: 'Alt+F',
  defaults: { ...FIB_DEF, levels: fibLevels(FIB_RET_VALUES, FIB_COLORS, FIB_RET_ON) },
  style: FIB_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [a, b] = g.P;
    let p0 = g.d.points[0].price;
    let p1 = g.d.points[1].price;
    if (p.reverse) [p0, p1] = [p1, p0];
    // Level 0 sits at the end point and level 1 at the start point (TradingView convention).
    fibHorizontalLevels(g, p.levels, (lvl) => p1 + (p0 - p1) * lvl, Math.min(a.x, b.x), Math.max(a.x, b.x), p);
    if (p.showTrend) g.seg(a, b, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
  },
});
def({
  id: 'fibext', label: 'Trend-based fib extension', icon: '⋰', group: 'fib', section: 'Fibonacci', n: 3,
  defaults: { ...FIB_DEF, levels: fibLevels(FIB_RET_VALUES, FIB_COLORS, FIB_RET_ON) },
  style: FIB_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [A, B, C0] = g.P;
    const C = C0 ?? B;
    const [pa, pb, pc] = g.d.points;
    const base = (pc ?? pb).price;
    const span = Math.max(40, Math.abs(B.x - A.x));
    const dir = p.reverse ? -1 : 1;
    // Extension levels project the A→B move from C.
    fibHorizontalLevels(g, p.levels, (lvl) => base + dir * (pb.price - pa.price) * lvl, C.x, C.x + span, p);
    if (p.showTrend) g.poly(C0 ? [A, B, C] : [A, B], { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
  },
});
def({
  id: 'fibchannel', label: 'Fib channel', icon: '▤', group: 'fib', section: 'Fibonacci', n: 3,
  defaults: { ...FIB_DEF, extend: 'right', levels: fibLevels([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236], FIB_COLORS, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618]) },
  style: FIB_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [A, B, C0] = g.P;
    const off = channelOffset(A, B, C0 ?? B);
    const left = p.extend === 'left' || p.extend === 'both';
    const right = p.extend === 'right' || p.extend === 'both';
    let prev = null;
    for (const lvl of p.levels.filter((l) => l.on).sort((x, y) => x.v - y.v)) {
      const a = { x: A.x, y: A.y + off * lvl.v };
      const b = { x: B.x, y: B.y + off * lvl.v };
      const [s, e] = extendSegment(a, b, g.w, g.h, left, right);
      if (p.fill && prev) g.area([prev[0], prev[1], e, s], withAlpha(lvl.color, 1 - p.fillOpacity / 100));
      g.seg(s, e, { color: lvl.color, width: p.levelsWidth, style: p.levelsStyle });
      if (p.showLevels !== 'none') g.text(p.showLevels === 'percent' ? `${(lvl.v * 100).toFixed(1)}%` : `${lvl.v}`, a.x + 4, a.y - 2, { color: lvl.color, size: p.fontSize, baseline: 'bottom' });
      prev = [s, e];
    }
  },
});
def({
  id: 'fibtimezone', label: 'Fib time zone', icon: '⦀', group: 'fib', section: 'Fibonacci', n: 2, axis: 'time',
  defaults: { ...FIB_DEF, fill: false, levels: fibLevels([0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233], FIB_COLORS) },
  style: [S.check('showTrend', 'Trend line'), S.line('Trend line style'), S.levels(), S.num('levelsWidth', 'Levels line width', 1, 4), S.check('fill', 'Background'), S.num('fillOpacity', 'Background transparency %', 0, 100), S.select('showLevels', 'Labels', [['values', 'Values'], ['none', 'Hidden']])],
  draw: (g) => {
    const p = g.d.props;
    const la = g.L.timeToLogical(g.d.points[0].time);
    const unit = g.L.timeToLogical(g.d.points[1].time) - la;
    let prevX = null;
    for (const lvl of p.levels.filter((l) => l.on).sort((x, y) => x.v - y.v)) {
      const x = g.xl(la + unit * lvl.v);
      if (x === null || x < -50 || x > g.w + 50) { prevX = x; continue; }
      if (p.fill && prevX !== null) g.area([{ x: prevX, y: 0 }, { x, y: 0 }, { x, y: g.h }, { x: prevX, y: g.h }], withAlpha(lvl.color, 1 - p.fillOpacity / 100));
      g.seg({ x, y: 0 }, { x, y: g.h }, { color: lvl.color, width: p.levelsWidth });
      if (p.showLevels !== 'none') g.text(String(lvl.v), x + 3, g.h - 4, { color: lvl.color, size: 11, baseline: 'bottom' });
      prevX = x;
    }
    if (p.showTrend) g.seg(g.P[0], g.P[1], { color: p.lineColor, width: p.lineWidth, style: 2 });
  },
});
const FAN_LEVELS = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];
def({
  id: 'fibfan', label: 'Fib speed resistance fan', icon: '⋌', group: 'fib', section: 'Fibonacci', n: 2,
  defaults: { ...FIB_DEF, levels: fibLevels(FAN_LEVELS, [TV.gray, TV.red, TV.orange, TV.lime, TV.green, TV.teal, TV.gray]), showGrid: true },
  style: [S.levels(), S.num('levelsWidth', 'Levels line width', 1, 4), S.check('showGrid', 'Grid'), S.check('fill', 'Background'), S.num('fillOpacity', 'Background transparency %', 0, 100), S.check('reverse', 'Reverse'), S.select('showLevels', 'Labels', [['values', 'Values'], ['none', 'Hidden']])],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = p.reverse ? [g.P[1], g.P[0]] : g.P;
    let prev = null;
    for (const lvl of p.levels.filter((l) => l.on).sort((x, y) => x.v - y.v)) {
      const priceTarget = { x: B.x, y: B.y + (A.y - B.y) * lvl.v };
      const end = rayToEdge(A, sub(priceTarget, A), g.w, g.h);
      if (p.fill && prev) g.area([A, prev, end], withAlpha(lvl.color, 1 - p.fillOpacity / 100));
      g.seg(A, end, { color: lvl.color, width: p.levelsWidth });
      if (p.showLevels !== 'none') g.text(String(lvl.v), B.x + 4, priceTarget.y, { color: lvl.color, size: 11, baseline: 'middle' });
      prev = end;
      const timeTarget = { x: A.x + (B.x - A.x) * lvl.v, y: B.y };
      if (lvl.v > 0 && lvl.v < 1) g.seg(A, rayToEdge(A, sub(timeTarget, A), g.w, g.h), { color: lvl.color, width: p.levelsWidth });
      if (p.showGrid) {
        g.seg({ x: Math.min(A.x, B.x), y: priceTarget.y }, { x: Math.max(A.x, B.x), y: priceTarget.y }, { color: withAlpha(lvl.color, 0.5), width: 1, style: 1, hit: false });
        g.seg({ x: timeTarget.x, y: Math.min(A.y, B.y) }, { x: timeTarget.x, y: Math.max(A.y, B.y) }, { color: withAlpha(lvl.color, 0.5), width: 1, style: 1, hit: false });
      }
    }
  },
});
def({
  id: 'fibtime', label: 'Trend-based fib time', icon: '⦙', group: 'fib', section: 'Fibonacci', n: 3, axis: 'time',
  defaults: { ...FIB_DEF, fill: false, levels: fibLevels([0, 0.382, 0.5, 0.618, 1, 1.382, 1.618, 2, 2.382, 2.618, 3, 3.618, 4.236], FIB_COLORS, [0, 0.382, 0.5, 0.618, 1, 1.382, 1.618, 2, 2.382, 2.618, 3]) },
  style: [S.check('showTrend', 'Trend line'), S.line('Trend line style'), S.levels(), S.num('levelsWidth', 'Levels line width', 1, 4), S.check('fill', 'Background'), S.num('fillOpacity', 'Background transparency %', 0, 100)],
  draw: (g) => {
    const p = g.d.props;
    const [pa, pb, pc] = g.d.points;
    const la = g.L.timeToLogical(pa.time);
    const lb = g.L.timeToLogical(pb.time);
    const lc = g.L.timeToLogical((pc ?? pb).time);
    let prevX = null;
    for (const lvl of p.levels.filter((l) => l.on).sort((x, y) => x.v - y.v)) {
      const x = g.xl(lc + (lb - la) * lvl.v);
      if (x === null) continue;
      if (p.fill && prevX !== null) g.area([{ x: prevX, y: 0 }, { x, y: 0 }, { x, y: g.h }, { x: prevX, y: g.h }], withAlpha(lvl.color, 1 - p.fillOpacity / 100));
      g.seg({ x, y: 0 }, { x, y: g.h }, { color: lvl.color, width: p.levelsWidth });
      g.text(String(lvl.v), x + 3, g.h - 4, { color: lvl.color, size: 11, baseline: 'bottom' });
      prevX = x;
    }
    if (p.showTrend) g.poly(g.P, { color: p.lineColor, width: p.lineWidth, style: 2 });
  },
});
const ROUND_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236];
def({
  id: 'fibcircles', label: 'Fib circles', icon: '◎', group: 'fib', section: 'Fibonacci', n: 2,
  defaults: { ...FIB_DEF, levels: fibLevels(ROUND_LEVELS, FIB_COLORS.slice(1), [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618]) },
  style: [S.check('showTrend', 'Trend line'), S.line('Trend line style'), S.levels(), S.num('levelsWidth', 'Levels line width', 1, 4), S.check('fill', 'Background'), S.num('fillOpacity', 'Background transparency %', 0, 100)],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = g.P;
    const c = mid(A, B);
    const r = dist(A, B) / 2;
    for (const lvl of p.levels.filter((l) => l.on).sort((x, y) => y.v - x.v)) {
      g.ellipse(c.x, c.y, r * lvl.v, r * lvl.v, { color: lvl.color, width: p.levelsWidth, fill: p.fill ? withAlpha(lvl.color, (1 - p.fillOpacity / 100) / 2) : undefined });
    }
    if (p.showTrend) g.seg(A, B, { color: p.lineColor, width: p.lineWidth, style: 2 });
  },
});
def({
  id: 'fibspiral', label: 'Fib spiral', icon: '@', group: 'fib', section: 'Fibonacci', n: 2,
  defaults: { lineColor: TV.red, lineWidth: 1, lineStyle: 0, counterclockwise: false },
  style: [S.line(), S.check('counterclockwise', 'Counterclockwise')],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = g.P;
    const R = dist(A, B);
    if (R < 2) return;
    const k = Math.log((1 + Math.sqrt(5)) / 2) / (Math.PI / 2);
    const base = Math.atan2(B.y - A.y, B.x - A.x);
    const dir = p.counterclockwise ? -1 : 1;
    const pts = [];
    for (let t = -6 * Math.PI; t <= 4 * Math.PI; t += 0.05) {
      const r = R * Math.exp(k * t);
      if (r > Math.max(g.w, g.h) * 3) break;
      pts.push({ x: A.x + r * Math.cos(base + dir * t), y: A.y + r * Math.sin(base + dir * t) });
    }
    g.poly(pts, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    g.seg(A, B, { color: p.lineColor, width: 1, style: 2, hit: false });
  },
});
def({
  id: 'fibarcs', label: 'Fib speed resistance arcs', icon: '◠', group: 'fib', section: 'Fibonacci', n: 2,
  defaults: { ...FIB_DEF, fullCircles: false, levels: fibLevels(ROUND_LEVELS, FIB_COLORS.slice(1), [0.236, 0.382, 0.5, 0.618, 0.786, 1]) },
  style: [S.check('showTrend', 'Trend line'), S.line('Trend line style'), S.levels(), S.num('levelsWidth', 'Levels line width', 1, 4), S.check('fullCircles', 'Full circles'), S.check('fill', 'Background'), S.num('fillOpacity', 'Background transparency %', 0, 100)],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = g.P;
    const R = dist(A, B);
    const ang = Math.atan2(B.y - A.y, B.x - A.x);
    for (const lvl of p.levels.filter((l) => l.on).sort((x, y) => y.v - x.v)) {
      const o = { color: lvl.color, width: p.levelsWidth, fill: p.fill ? withAlpha(lvl.color, (1 - p.fillOpacity / 100) / 2) : undefined, sector: true };
      if (p.fullCircles) g.ellipse(A.x, A.y, R * lvl.v, R * lvl.v, o);
      else g.ellipse(A.x, A.y, R * lvl.v, R * lvl.v, { ...o, start: ang - Math.PI / 2, end: ang + Math.PI / 2 });
      g.text(String(lvl.v), A.x + Math.cos(ang) * R * lvl.v, A.y + Math.sin(ang) * R * lvl.v, { color: lvl.color, size: 10, align: 'center', baseline: 'bottom' });
    }
    if (p.showTrend) g.seg(A, B, { color: p.lineColor, width: p.lineWidth, style: 2 });
  },
});
def({
  id: 'fibwedge', label: 'Fib wedge', icon: '◺', group: 'fib', section: 'Fibonacci', n: 3,
  defaults: { ...FIB_DEF, levels: fibLevels([0.236, 0.382, 0.5, 0.618, 0.786, 1], FIB_COLORS.slice(1)) },
  style: [S.line('Trend line style'), S.levels(), S.num('levelsWidth', 'Levels line width', 1, 4), S.check('fill', 'Background'), S.num('fillOpacity', 'Background transparency %', 0, 100)],
  draw: (g) => {
    const p = g.d.props;
    const [A, B, C0] = g.P;
    const C = C0 ?? B;
    const R = dist(A, B);
    const angB = Math.atan2(B.y - A.y, B.x - A.x);
    const angC = Math.atan2(C.y - A.y, C.x - A.x);
    let delta = angC - angB;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const start = delta >= 0 ? angB : angB + delta;
    const end = delta >= 0 ? angB + delta : angB;
    for (const lvl of p.levels.filter((l) => l.on).sort((x, y) => y.v - x.v)) {
      g.ellipse(A.x, A.y, R * lvl.v, R * lvl.v, { color: lvl.color, width: p.levelsWidth, start, end, sector: true, fill: p.fill ? withAlpha(lvl.color, (1 - p.fillOpacity / 100) / 2) : undefined });
    }
    g.seg(A, B, { color: p.lineColor, width: p.lineWidth });
    g.seg(A, { x: A.x + Math.cos(angC) * R, y: A.y + Math.sin(angC) * R }, { color: p.lineColor, width: p.lineWidth });
  },
});
def({
  id: 'pitchfan', label: 'Pitchfan', icon: '⋔', group: 'fib', section: 'Fibonacci', n: 3,
  defaults: { ...FIB_DEF, levels: fibLevels(FAN_LEVELS, [TV.gray, TV.red, TV.orange, TV.lime, TV.green, TV.teal, TV.gray]) },
  style: [S.line('Median'), S.levels(), S.num('levelsWidth', 'Levels line width', 1, 4), S.check('fill', 'Background'), S.num('fillOpacity', 'Background transparency %', 0, 100)],
  draw: (g) => {
    const p = g.d.props;
    const [A, B, C] = g.P;
    if (!C) { g.seg(A, B, { color: p.lineColor, width: 1 }); return; }
    let prev = null;
    for (const lvl of p.levels.filter((l) => l.on).sort((x, y) => x.v - y.v)) {
      const end = rayToEdge(A, sub(lerp(B, C, lvl.v), A), g.w, g.h);
      if (p.fill && prev) g.area([A, prev, end], withAlpha(lvl.color, 1 - p.fillOpacity / 100));
      g.seg(A, end, { color: lvl.color, width: p.levelsWidth });
      prev = end;
    }
    g.seg(B, C, { color: p.lineColor, width: p.lineWidth, style: 2 });
  },
});

const GANN_LEVELS = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];
const GANN_COLORS = [TV.gray, TV.orange, TV.lime, TV.green, TV.teal, TV.blue, TV.gray];
def({
  id: 'gannbox', label: 'Gann box', icon: '⊞', group: 'fib', section: 'Gann', n: 2,
  defaults: { lineColor: TV.gray, lineWidth: 1, priceLevels: fibLevels(GANN_LEVELS, GANN_COLORS), timeLevels: fibLevels(GANN_LEVELS, GANN_COLORS), fill: true, fillOpacity: 90, showLabels: true, showAngles: false, reverse: false },
  style: [S.line('Border'), S.levels('priceLevels', 'Price levels'), S.levels('timeLevels', 'Time levels'), S.check('fill', 'Background'), S.num('fillOpacity', 'Background transparency %', 0, 100), S.check('showLabels', 'Labels'), S.check('showAngles', 'Angles'), S.check('reverse', 'Reverse')],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = p.reverse ? [g.P[1], g.P[0]] : g.P;
    const x = (t) => A.x + (B.x - A.x) * t;
    const y = (t) => A.y + (B.y - A.y) * t;
    const tl = p.timeLevels.filter((l) => l.on).sort((a, b) => a.v - b.v);
    const pl = p.priceLevels.filter((l) => l.on).sort((a, b) => a.v - b.v);
    if (p.fill) {
      for (let i = 1; i < tl.length; i++) g.area([{ x: x(tl[i - 1].v), y: A.y }, { x: x(tl[i].v), y: A.y }, { x: x(tl[i].v), y: B.y }, { x: x(tl[i - 1].v), y: B.y }], withAlpha(tl[i].color, 1 - p.fillOpacity / 100));
      for (let i = 1; i < pl.length; i++) g.area([{ x: A.x, y: y(pl[i - 1].v) }, { x: B.x, y: y(pl[i - 1].v) }, { x: B.x, y: y(pl[i].v) }, { x: A.x, y: y(pl[i].v) }], withAlpha(pl[i].color, 1 - p.fillOpacity / 100));
    }
    for (const l of tl) {
      g.seg({ x: x(l.v), y: A.y }, { x: x(l.v), y: B.y }, { color: l.color, width: 1 });
      if (p.showLabels) g.text(String(l.v), x(l.v), Math.max(A.y, B.y) + 4, { color: l.color, size: 10, align: 'center' });
    }
    for (const l of pl) {
      g.seg({ x: A.x, y: y(l.v) }, { x: B.x, y: y(l.v) }, { color: l.color, width: 1 });
      if (p.showLabels) g.text(String(l.v), Math.min(A.x, B.x) - 4, y(l.v), { color: l.color, size: 10, align: 'right', baseline: 'middle' });
    }
    if (p.showAngles) {
      g.seg(A, B, { color: p.lineColor, width: 1, style: 2 });
      g.seg({ x: A.x, y: B.y }, { x: B.x, y: A.y }, { color: p.lineColor, width: 1, style: 2 });
    }
  },
});
function gannSquare(g, fixed) {
  const p = g.d.props;
  const [A, B0] = g.P;
  let B = B0;
  if (fixed) {
    const s = Math.max(Math.abs(B0.x - A.x), Math.abs(B0.y - A.y));
    B = { x: A.x + Math.sign(B0.x - A.x || 1) * s, y: A.y + Math.sign(B0.y - A.y || 1) * s };
  }
  if (p.fill) g.area([A, { x: B.x, y: A.y }, B, { x: A.x, y: B.y }], p.fillColor);
  for (const l of p.levels.filter((x) => x.on)) {
    g.seg({ x: A.x + (B.x - A.x) * l.v, y: A.y }, { x: A.x + (B.x - A.x) * l.v, y: B.y }, { color: withAlpha(l.color, 0.6), width: 1 });
    g.seg({ x: A.x, y: A.y + (B.y - A.y) * l.v }, { x: B.x, y: A.y + (B.y - A.y) * l.v }, { color: withAlpha(l.color, 0.6), width: 1 });
  }
  for (const t of [0.25, 0.5, 0.75]) {
    g.seg(A, { x: B.x, y: A.y + (B.y - A.y) * t }, { color: p.fanColor, width: 1 });
    g.seg(A, { x: A.x + (B.x - A.x) * t, y: B.y }, { color: p.fanColor, width: 1 });
  }
  g.seg(A, B, { color: p.fanColor, width: 1 });
  g.seg({ x: A.x, y: B.y }, { x: B.x, y: A.y }, { color: p.fanColor, width: 1, style: 2 });
  if (p.showArcs) for (const t of [0.5, 1]) g.ellipse(A.x, A.y, Math.abs(B.x - A.x) * t, Math.abs(B.y - A.y) * t, { color: p.arcColor, width: 1, hit: false });
  g.rect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y), { color: p.lineColor, width: p.lineWidth });
}
const GSQ_DEF = { lineColor: TV.gray, lineWidth: 1, fanColor: TV.blue, arcColor: TV.orange, fill: true, fillColor: 'rgba(41, 98, 255, 0.06)', showArcs: true, levels: fibLevels([0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875], [TV.gray]) };
const GSQ_TAB = [S.line('Border'), S.color('fanColor', 'Fan'), S.color('arcColor', 'Arcs'), S.check('showArcs', 'Show arcs'), S.levels(), S.fill()];
def({ id: 'gannfixed', label: 'Gann square fixed', icon: '⊠', group: 'fib', section: 'Gann', n: 2, defaults: GSQ_DEF, style: GSQ_TAB, draw: (g) => gannSquare(g, true) });
def({ id: 'gannsquare', label: 'Gann square', icon: '⊡', group: 'fib', section: 'Gann', n: 2, defaults: GSQ_DEF, style: GSQ_TAB, draw: (g) => gannSquare(g, false) });
const GANN_FAN = [[1, 8], [1, 4], [1, 3], [1, 2], [1, 1], [2, 1], [3, 1], [4, 1], [8, 1]];
def({
  id: 'gannfan', label: 'Gann fan', icon: '⋉', group: 'fib', section: 'Gann', n: 2,
  defaults: {
    levels: GANN_FAN.map(([a, b], i) => ({ v: a / b, label: `${a}/${b}`, color: [TV.orange, TV.lime, TV.green, TV.teal, TV.blue, TV.teal, TV.green, TV.lime, TV.orange][i], on: true })),
    levelsWidth: 1, fill: true, fillOpacity: 90, showLabels: true,
  },
  style: [S.levels(), S.num('levelsWidth', 'Levels line width', 1, 4), S.check('fill', 'Background'), S.num('fillOpacity', 'Background transparency %', 0, 100), S.check('showLabels', 'Labels')],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = g.P;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    let prev = null;
    for (const lvl of [...p.levels].filter((l) => l.on).sort((a, b) => a.v - b.v)) {
      // 1/1 passes through B; a/b scales the price move per unit of time.
      const end = rayToEdge(A, { x: dx, y: dy * lvl.v }, g.w, g.h);
      if (p.fill && prev) g.area([A, prev, end], withAlpha(lvl.color, 1 - p.fillOpacity / 100));
      g.seg(A, end, { color: lvl.color, width: p.levelsWidth });
      if (p.showLabels) g.text(lvl.label ?? String(lvl.v), end.x - 4, end.y, { color: lvl.color, size: 10, align: 'right', baseline: 'middle', clamp: true });
      prev = end;
    }
  },
});

// ===== Patterns
def({
  id: 'xabcd', label: 'XABCD pattern', icon: 'W', group: 'patterns', section: 'Chart patterns', n: 5, defaults: PATTERN_DEF, style: PATTERN_TAB,
  draw: (g) => {
    const { P, d } = g;
    const pr = d.points.map((x) => x.price);
    drawZigzag(g, ['X', 'A', 'B', 'C', 'D'], [[0, 1, 2], [2, 3, 4]]);
    if (P[2]) ratioLabel(g, P[0], P[2], Math.abs(pr[2] - pr[1]) / Math.abs(pr[1] - pr[0]), d.props);
    if (P[3]) ratioLabel(g, P[1], P[3], Math.abs(pr[3] - pr[2]) / Math.abs(pr[2] - pr[1]), d.props);
    if (P[4]) {
      ratioLabel(g, P[2], P[4], Math.abs(pr[4] - pr[3]) / Math.abs(pr[3] - pr[2]), d.props);
      ratioLabel(g, P[0], P[4], Math.abs(pr[4] - pr[1]) / Math.abs(pr[1] - pr[0]), d.props);
    }
  },
});
def({
  id: 'cypher', label: 'Cypher pattern', icon: 'ᗯ', group: 'patterns', section: 'Chart patterns', n: 5, defaults: PATTERN_DEF, style: PATTERN_TAB,
  draw: (g) => {
    const { P, d } = g;
    const pr = d.points.map((x) => x.price);
    drawZigzag(g, ['X', 'A', 'B', 'C', 'D'], [[0, 1, 2], [2, 3, 4]]);
    if (P[2]) ratioLabel(g, P[0], P[2], Math.abs(pr[2] - pr[1]) / Math.abs(pr[1] - pr[0]), d.props);
    if (P[3]) ratioLabel(g, P[0], P[3], Math.abs(pr[3] - pr[0]) / Math.abs(pr[1] - pr[0]), d.props);
    if (P[4]) ratioLabel(g, P[0], P[4], Math.abs(pr[3] - pr[4]) / Math.abs(pr[3] - pr[0]), d.props);
  },
});
def({
  id: 'hs', label: 'Head and shoulders', icon: '⩙', group: 'patterns', section: 'Chart patterns', n: 7, defaults: PATTERN_DEF, style: PATTERN_TAB,
  draw: (g) => {
    const { P, d } = g;
    const p = d.props;
    if (p.fill && P.length >= 7) {
      g.area([P[0], P[1], P[2]], p.fillColor);
      g.area([P[2], P[3], P[4]], p.fillColor);
      g.area([P[4], P[5], P[6]], p.fillColor);
    }
    g.poly(P, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    if (P[4]) {
      // Neckline through the two troughs, spanning the whole pattern.
      const slope = (P[4].y - P[2].y) / ((P[4].x - P[2].x) || 1);
      const xs = P[0].x;
      const xe = (P[6] ?? P[4]).x;
      g.seg({ x: xs, y: P[2].y + slope * (xs - P[2].x) }, { x: xe, y: P[2].y + slope * (xe - P[2].x) }, { color: p.lineColor, width: 1, style: 2 });
    }
    [['Left Shoulder', 1], ['Head', 3], ['Right Shoulder', 5]].forEach(([label, i]) => { if (P[i]) patternLabel(g, P, i, label, p); });
  },
});
def({
  id: 'abcd', label: 'ABCD pattern', icon: 'N', group: 'patterns', section: 'Chart patterns', n: 4, defaults: PATTERN_DEF, style: PATTERN_TAB,
  draw: (g) => {
    const { P, d } = g;
    const pr = d.points.map((x) => x.price);
    drawZigzag(g, ['A', 'B', 'C', 'D']);
    if (P[2]) ratioLabel(g, P[0], P[2], Math.abs(pr[2] - pr[1]) / Math.abs(pr[1] - pr[0]), d.props);
    if (P[3]) ratioLabel(g, P[1], P[3], Math.abs(pr[3] - pr[2]) / Math.abs(pr[2] - pr[1]), d.props);
  },
});
def({
  id: 'trianglepattern', label: 'Triangle pattern', icon: '◬', group: 'patterns', section: 'Chart patterns', n: 4, defaults: PATTERN_DEF, style: PATTERN_TAB,
  draw: (g) => {
    const { P, d } = g;
    const p = d.props;
    if (p.fill && P.length === 4) g.area(P, p.fillColor);
    drawZigzag(g, ['A', 'B', 'C', 'D']);
    if (P.length === 4) {
      g.seg(P[0], P[2], { color: p.lineColor, width: 1, style: 2, extendRight: true });
      g.seg(P[1], P[3], { color: p.lineColor, width: 1, style: 2, extendRight: true });
    }
  },
});
def({
  id: 'threedrives', label: 'Three drives pattern', icon: '⋀', group: 'patterns', section: 'Chart patterns', n: 7, defaults: PATTERN_DEF, style: PATTERN_TAB,
  draw: (g) => {
    const { P, d } = g;
    const pr = d.points.map((x) => x.price);
    drawZigzag(g, ['', 'Drive 1', '', 'Drive 2', '', 'Drive 3', '']);
    for (const [a, b, c] of [[1, 2, 3], [3, 4, 5]]) {
      if (P[c]) ratioLabel(g, P[a], P[c], Math.abs(pr[c] - pr[b]) / Math.abs(pr[a] - pr[b]), d.props);
    }
  },
});
for (const [id, label, n, labels] of [
  ['elliott5', 'Elliott impulse wave (1·2·3·4·5)', 6, ['(0)', '(1)', '(2)', '(3)', '(4)', '(5)']],
  ['elliott3', 'Elliott correction wave (A·B·C)', 4, ['(0)', '(A)', '(B)', '(C)']],
  ['elliotttri', 'Elliott triangle wave (A·B·C·D·E)', 6, ['(0)', '(A)', '(B)', '(C)', '(D)', '(E)']],
  ['elliottwxy', 'Elliott double combo wave (W·X·Y)', 4, ['(0)', '(W)', '(X)', '(Y)']],
  ['elliottwxyxz', 'Elliott triple combo wave (W·X·Y·X·Z)', 6, ['(0)', '(W)', '(X)', '(Y)', '(X)', '(Z)']],
]) {
  def({ id, label, icon: '∿', group: 'patterns', section: 'Elliott waves', n, defaults: WAVE_DEF, style: WAVE_TAB, draw: (g) => drawZigzag(g, labels) });
}
def({
  id: 'cycliclines', label: 'Cyclic lines', icon: '‖', group: 'patterns', section: 'Cycles', n: 2, axis: 'time',
  defaults: { ...LINE_DEF, lineWidth: 1 }, style: [S.line()],
  draw: (g) => {
    const p = g.d.props;
    const la = g.L.timeToLogical(g.d.points[0].time);
    const step = g.L.timeToLogical(g.d.points[1].time) - la;
    if (Math.abs(step) < 0.5) { g.seg(g.P[0], g.P[1], { color: p.lineColor, width: 1 }); return; }
    for (let k = 0; k < 500; k++) {
      const x = g.xl(la + step * k);
      if (x === null || (step > 0 ? x > g.w + 5 : x < -5)) break;
      g.seg({ x, y: 0 }, { x, y: g.h }, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    }
  },
});
def({
  id: 'timecycles', label: 'Time cycles', icon: '⌒', group: 'patterns', section: 'Cycles', n: 2,
  defaults: { ...LINE_DEF, lineWidth: 1, fill: true, fillColor: 'rgba(41, 98, 255, 0.1)' }, style: [S.line(), S.fill()],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = g.P;
    const diam = B.x - A.x;
    if (Math.abs(diam) < 4) { g.seg(A, B, { color: p.lineColor, width: 1 }); return; }
    const ry = Math.max(10, Math.abs(B.y - A.y));
    for (let k = 0; k < 300; k++) {
      const cx = A.x + diam * (k + 0.5);
      if ((diam > 0 && cx - Math.abs(diam) / 2 > g.w) || (diam < 0 && cx + Math.abs(diam) / 2 < 0)) break;
      g.ellipse(cx, A.y, Math.abs(diam) / 2, ry, { color: p.lineColor, width: p.lineWidth, start: Math.PI, end: Math.PI * 2, fill: p.fill ? p.fillColor : undefined });
    }
  },
});
def({
  id: 'sineline', label: 'Sine line', icon: '∼', group: 'patterns', section: 'Cycles', n: 2,
  defaults: { ...LINE_DEF, lineWidth: 1 }, style: [S.line()],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = g.P;
    const half = B.x - A.x;
    if (Math.abs(half) < 2) { g.seg(A, B, { color: p.lineColor, width: 1 }); return; }
    const amp = (A.y - B.y) / 2;
    const midY = (A.y + B.y) / 2;
    const pts = [];
    for (let x = 0; x <= g.w; x += 2) pts.push({ x, y: midY + amp * Math.cos((Math.PI * (x - A.x)) / half) });
    g.poly(pts, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
  },
});

// ===== Forecasting & measurement
const POS_DEF = {
  accountSize: 1000, lotSize: 1, risk: 1, riskMode: 'percent', lineColor: TV.gray, textColor: '#FFFFFF', fontSize: 12,
  profitColor: 'rgba(8, 153, 129, 0.2)', stopColor: 'rgba(242, 54, 69, 0.2)', compact: false, showPriceLabels: true, alwaysShowStats: true,
};
const POS_INPUTS = [S.num('accountSize', 'Account size', 0, 1e12, 1), S.num('lotSize', 'Lot size', 0, 1e9, 0.0001), S.num('risk', 'Risk', 0, 1e9, 0.01), S.select('riskMode', 'Risk unit', [['percent', '%'], ['cash', 'Cash']]), { t: 'positionPrices' }];
const POS_STYLE = [S.color('lineColor', 'Lines'), S.color('profitColor', 'Profit background'), S.color('stopColor', 'Stop background'), S.color('textColor', 'Text'), S.num('fontSize', 'Font size', 8, 40), S.check('compact', 'Compact stats mode'), S.check('showPriceLabels', 'Price labels'), S.check('alwaysShowStats', 'Always show stats')];
export function positionStats(d, lastClose, candlesLen, entryLogical) {
  const p = d.props;
  const side = d.type === 'short' ? -1 : 1;
  const entry = d.points[0].price;
  const target = d.points[1].price;
  const stop = d.points[2]?.price ?? entry;
  const riskAmt = p.riskMode === 'percent' ? (p.accountSize * p.risk) / 100 : p.risk;
  const perUnit = Math.abs(entry - stop) || 1e-12;
  const lot = p.lotSize || 1;
  const qty = Math.max(0, Math.floor((riskAmt / perUnit / lot) * 1e6) / 1e6);
  const reward = Math.abs(target - entry);
  const live = lastClose !== undefined && entryLogical <= candlesLen - 1;
  return { side, entry, target, stop, qty, reward, risk: perUnit, rr: reward / perUnit, pnl: live ? (lastClose - entry) * side * qty * lot : null, lot };
}
function positionTool(id, label, icon, side) {
  def({
    id, label, icon, group: 'forecast', section: 'Forecasting', n: 2, defaults: POS_DEF, style: POS_STYLE, inputs: POS_INPUTS,
    create: (d) => {
      const entry = d.points[0].price;
      let target = d.points[1].price;
      if ((side > 0 && target <= entry) || (side < 0 && target >= entry)) target = entry + Math.abs(entry - target || entry * 0.02) * side;
      d.points[1] = { time: d.points[1].time, price: target };
      d.points[2] = { time: d.points[1].time, price: entry - (target - entry) / 2 };
    },
    draw: (g) => {
      const d = g.d;
      const p = d.props;
      const [E, T] = g.P;
      const st = positionStats(d, g.candles.at(-1)?.close, g.candles.length, g.L.timeToLogical(d.points[0].time));
      const yS = g.y(st.stop);
      if (yS === null) return;
      const left = Math.min(E.x, T.x);
      const right = Math.max(E.x, T.x, E.x + 30);
      g.area([{ x: left, y: E.y }, { x: right, y: E.y }, { x: right, y: T.y }, { x: left, y: T.y }], p.profitColor);
      g.area([{ x: left, y: E.y }, { x: right, y: E.y }, { x: right, y: yS }, { x: left, y: yS }], p.stopColor);
      g.seg({ x: left, y: E.y }, { x: right, y: E.y }, { color: p.lineColor, width: 1 });
      if (p.showPriceLabels) {
        g.pill(g.fmt(st.entry), right + 3, E.y, TV.gray, { align: 'left' });
        g.pill(g.fmt(st.target), right + 3, T.y, TV.green, { align: 'left' });
        g.pill(g.fmt(st.stop), right + 3, yS, TV.red, { align: 'left' });
      }
      if (!(p.alwaysShowStats || g.selected)) return;
      const ticks = (v) => Math.round(Math.abs(v) / g.tick).toLocaleString();
      const pct = (v) => ((Math.abs(v - st.entry) / st.entry) * 100).toFixed(2);
      const cx = (left + right) / 2;
      const tLabel = p.compact ? `${g.fmt(st.reward)} (${pct(st.target)}%)` : `Target: ${g.fmt(st.reward)} (${pct(st.target)}%) ${ticks(st.target - st.entry)}, Amount: ${(st.reward * st.qty * st.lot).toFixed(2)}`;
      const sLabel = p.compact ? `${g.fmt(st.risk)} (${pct(st.stop)}%)` : `Stop: ${g.fmt(st.risk)} (${pct(st.stop)}%) ${ticks(st.stop - st.entry)}, Amount: ${(st.risk * st.qty * st.lot).toFixed(2)}`;
      const mLabel = p.compact ? `${st.rr.toFixed(2)}` : `${st.pnl !== null ? `Open P&L: ${st.pnl.toFixed(2)}, ` : ''}Qty: ${st.qty}\nRisk/Reward Ratio: ${st.rr.toFixed(2)}`;
      const up = T.y < E.y;
      g.text(tLabel, cx, T.y + (up ? -4 : 4), { bg: TV.green, color: p.textColor, size: p.fontSize, align: 'center', baseline: up ? 'bottom' : 'top', pad: 5 });
      g.text(sLabel, cx, yS + (up ? 4 : -4), { bg: TV.red, color: p.textColor, size: p.fontSize, align: 'center', baseline: up ? 'top' : 'bottom', pad: 5 });
      g.text(mLabel, cx, E.y, { bg: side > 0 ? 'rgba(8,153,129,.92)' : 'rgba(242,54,69,.92)', color: p.textColor, size: p.fontSize, align: 'center', baseline: 'middle', pad: 5, textAlign: 'center' });
    },
    handles: (g) => {
      const [E, T] = g.P;
      const yS = g.y(g.d.points[2]?.price ?? g.d.points[0].price);
      const right = Math.max(E.x, T.x, E.x + 30);
      return [E, { x: right, y: T.y }, { x: right, y: yS }, { x: right, y: E.y }];
    },
    moveHandle: (d, i, pt) => {
      if (i === 0) {
        d.points[0] = pt;
      } else if (i === 3) {
        d.points[1].time = pt.time;
        d.points[2].time = pt.time;
      } else {
        d.points[i].price = pt.price;
        d.points[1].time = pt.time;
        d.points[2].time = pt.time;
      }
    },
  });
}
positionTool('long', 'Long position', '⬆', 1);
positionTool('short', 'Short position', '⬇', -1);

def({
  id: 'avwap', label: 'Anchored VWAP', icon: '⚓', group: 'forecast', section: 'Volume-based', n: 1, axis: 'time',
  defaults: { lineColor: TV.blue, lineWidth: 2, lineStyle: 0, source: 'hlc3', bands: false, mult1: 1, mult2: 2, bandColor: TV.green, fill: true, fillColor: 'rgba(76, 175, 80, 0.1)' },
  style: [S.line('VWAP'), S.select('source', 'Source', [['hlc3', 'hlc3'], ['close', 'close'], ['hl2', 'hl2'], ['ohlc4', 'ohlc4']]), S.check('bands', 'Bands'), S.num('mult1', 'Bands multiplier #1', 0, 10, 0.1), S.num('mult2', 'Bands multiplier #2', 0, 10, 0.1), S.color('bandColor', 'Bands color'), S.fill()],
  draw: (g) => {
    const p = g.d.props;
    const i0 = Math.max(0, Math.round(g.L.timeToLogical(g.d.points[0].time)));
    const c = g.candles;
    let pv = 0;
    let v = 0;
    let pv2 = 0;
    const line = [];
    const bands = [[], [], [], []];
    for (let i = i0; i < c.length; i++) {
      const b = c[i];
      const src = p.source === 'close' ? b.close : p.source === 'hl2' ? (b.high + b.low) / 2 : p.source === 'ohlc4' ? (b.open + b.high + b.low + b.close) / 4 : (b.high + b.low + b.close) / 3;
      pv += src * b.volume;
      pv2 += src * src * b.volume;
      v += b.volume;
      const vw = v ? pv / v : src;
      const sd = v ? Math.sqrt(Math.max(0, pv2 / v - vw * vw)) : 0;
      const x = g.xl(i);
      line.push({ x, y: g.y(vw) });
      if (p.bands) {
        bands[0].push({ x, y: g.y(vw + sd * p.mult1) });
        bands[1].push({ x, y: g.y(vw - sd * p.mult1) });
        bands[2].push({ x, y: g.y(vw + sd * p.mult2) });
        bands[3].push({ x, y: g.y(vw - sd * p.mult2) });
      }
    }
    if (p.bands && bands[2].length > 1) {
      if (p.fill) g.area([...bands[2], ...bands[3].slice().reverse()], p.fillColor);
      for (const s of bands) g.poly(s, { color: p.bandColor, width: 1, hit: false });
    }
    if (line.length === 1) g.dot(line[0], p.lineColor, 3);
    g.poly(line, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
  },
});
const VP_DEF = { rows: 24, valueArea: 70, widthPct: 30, placement: 'left', upColor: 'rgba(41, 98, 255, 1)', downColor: 'rgba(251, 192, 45, 1)', vaOpacity: 0.7, outOpacity: 0.3, showPoc: true, pocColor: TV.red, extendPoc: false, lineColor: TV.blue };
const VP_TAB = [S.num('rows', 'Number of rows', 4, 200), S.num('valueArea', 'Value area volume %', 10, 100), S.num('widthPct', 'Width (% of range)', 5, 100), S.select('placement', 'Placement', [['left', 'Left'], ['right', 'Right']]), S.color('upColor', 'Up volume'), S.color('downColor', 'Down volume'), S.check('showPoc', 'POC'), S.color('pocColor', 'POC color'), S.check('extendPoc', 'Extend POC right')];
def({
  id: 'fixedvp', label: 'Fixed range volume profile', icon: '▦', group: 'forecast', section: 'Volume-based', n: 2, axis: 'time', defaults: VP_DEF, style: VP_TAB,
  draw: (g) => {
    const la = Math.round(g.L.timeToLogical(g.d.points[0].time));
    const lb = Math.round(g.L.timeToLogical(g.d.points[1].time));
    const x0 = g.xl(Math.min(la, lb));
    const x1 = g.xl(Math.max(la, lb));
    drawProfile(g, Math.min(la, lb), Math.max(la, lb), x0, x1);
    for (const x of [x0, x1]) g.seg({ x, y: 0 }, { x, y: g.h }, { color: withAlpha(g.d.props.lineColor, 0.35), width: 1, style: 2, hit: false });
  },
  handles: (g) => [{ x: g.P[0].x, y: g.h - 24 }, { x: g.P[1].x, y: g.h - 24 }],
});
def({
  id: 'anchoredvp', label: 'Anchored volume profile', icon: '▥', group: 'forecast', section: 'Volume-based', n: 1, axis: 'time', defaults: VP_DEF, style: VP_TAB,
  draw: (g) => {
    const la = Math.max(0, Math.round(g.L.timeToLogical(g.d.points[0].time)));
    const last = g.candles.length - 1;
    drawProfile(g, la, last, g.xl(la), g.xl(last));
    g.seg({ x: g.xl(la), y: 0 }, { x: g.xl(la), y: g.h }, { color: withAlpha(g.d.props.lineColor, 0.5), width: 1, style: 2 });
  },
});
const MEASURE_DEF = { lineColor: TV.blue, lineWidth: 1, fill: true, fillColor: 'rgba(41, 98, 255, 0.2)', textColor: '#FFFFFF', fontSize: 12, labelBg: 'rgba(41, 98, 255, 0.9)', showVolume: true };
const MEASURE_TAB = [S.line(), S.fill(), S.color('textColor', 'Text'), S.color('labelBg', 'Label background'), S.num('fontSize', 'Font size', 8, 40), S.check('showVolume', 'Volume')];
function measureColors(g) {
  const p = g.d.props;
  const neg = g.d.points[1].price < g.d.points[0].price;
  // TradingView switches the default blue to red for downward ranges.
  return neg && p.lineColor === TV.blue ? { line: TV.red, fill: 'rgba(242, 54, 69, 0.2)', bg: 'rgba(242, 54, 69, 0.9)' } : { line: p.lineColor, fill: p.fillColor, bg: p.labelBg };
}
def({
  id: 'pricerange', label: 'Price range', icon: '↕', group: 'forecast', section: 'Measurers', n: 2, defaults: MEASURE_DEF, style: MEASURE_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [a, b] = g.P;
    const col = measureColors(g);
    if (p.fill) g.area([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], col.fill);
    g.seg({ x: a.x, y: a.y }, { x: b.x, y: a.y }, { color: col.line, width: p.lineWidth });
    g.seg({ x: a.x, y: b.y }, { x: b.x, y: b.y }, { color: col.line, width: p.lineWidth });
    const mx = (a.x + b.x) / 2;
    g.seg({ x: mx, y: a.y }, { x: mx, y: b.y }, { color: col.line, width: p.lineWidth, rightEnd: 1 });
    g.text(priceRangeLabel(g, g.d), mx, b.y + (b.y < a.y ? -6 : 6), { bg: col.bg, color: p.textColor, size: p.fontSize, align: 'center', baseline: b.y < a.y ? 'bottom' : 'top', pad: 5, clamp: true });
  },
});
def({
  id: 'daterange', label: 'Date range', icon: '↔', group: 'forecast', section: 'Measurers', n: 2, defaults: MEASURE_DEF, style: MEASURE_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [a, b] = g.P;
    if (p.fill) g.area([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], p.fillColor);
    g.seg({ x: a.x, y: a.y }, { x: a.x, y: b.y }, { color: p.lineColor, width: p.lineWidth });
    g.seg({ x: b.x, y: a.y }, { x: b.x, y: b.y }, { color: p.lineColor, width: p.lineWidth });
    const my = (a.y + b.y) / 2;
    g.seg({ x: a.x, y: my }, { x: b.x, y: my }, { color: p.lineColor, width: p.lineWidth, rightEnd: 1 });
    const r = dateRangeLabel(g, g.d);
    g.text(`${r.bars} bars, ${r.dur}${p.showVolume ? `\nVol ${formatCompact(r.vol)}` : ''}`, (a.x + b.x) / 2, Math.max(a.y, b.y) + 6, { bg: p.labelBg, color: p.textColor, size: p.fontSize, align: 'center', pad: 5, textAlign: 'center', clamp: true });
  },
});
def({
  id: 'measure', label: 'Date and price range', icon: '⇔', group: 'forecast', section: 'Measurers', n: 2, defaults: MEASURE_DEF, style: MEASURE_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [a, b] = g.P;
    const col = measureColors(g);
    if (p.fill) g.area([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], col.fill);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    g.seg({ x: mx, y: a.y }, { x: mx, y: b.y }, { color: col.line, width: p.lineWidth, rightEnd: 1 });
    g.seg({ x: a.x, y: my }, { x: b.x, y: my }, { color: col.line, width: p.lineWidth, rightEnd: 1 });
    const r = dateRangeLabel(g, g.d);
    g.text(`${priceRangeLabel(g, g.d)}\n${r.bars} bars, ${r.dur}${p.showVolume ? `\nVol ${formatCompact(r.vol)}` : ''}`, mx, Math.max(a.y, b.y) + 6, { bg: col.bg, color: p.textColor, size: p.fontSize, align: 'center', pad: 6, textAlign: 'center', clamp: true });
  },
});
def({
  id: 'sector', label: 'Sector', icon: '◔', group: 'forecast', section: 'Forecasting', n: 3,
  defaults: { lineColor: TV.blue, lineWidth: 1, lineStyle: 0, fill: true, fillColor: 'rgba(41, 98, 255, 0.2)' }, style: SHAPE_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [A, B, C0] = g.P;
    const C = C0 ?? B;
    const r = dist(A, B);
    const a1 = Math.atan2(B.y - A.y, B.x - A.x);
    const a2 = Math.atan2(C.y - A.y, C.x - A.x);
    g.ellipse(A.x, A.y, r, r, { start: a1, end: a2, sector: true, fill: p.fill ? p.fillColor : undefined, color: p.lineColor, width: p.lineWidth });
    g.seg(A, B, { color: p.lineColor, width: p.lineWidth });
    g.seg(A, { x: A.x + Math.cos(a2) * r, y: A.y + Math.sin(a2) * r }, { color: p.lineColor, width: p.lineWidth });
  },
});

// ===== Geometric shapes: brushes & arrows
def({
  id: 'brush', label: 'Brush', icon: '✎', group: 'shapes', section: 'Brushes', n: -1,
  defaults: { lineColor: TV.blue, lineWidth: 2, lineStyle: 0, fill: false, fillColor: 'rgba(41, 98, 255, 0.2)' },
  style: [S.line(), S.fill()],
  draw: (g) => {
    const p = g.d.props;
    g.poly(g.P, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle, round: true, fill: p.fill ? p.fillColor : undefined, tol: Math.max(6, p.lineWidth) });
  },
});
def({
  id: 'highlighter', label: 'Highlighter', icon: '🖍', group: 'shapes', section: 'Brushes', n: -1,
  defaults: { lineColor: 'rgba(242, 54, 69, 0.15)', lineWidth: 20, lineStyle: 0 },
  style: [S.color('lineColor', 'Color'), S.num('lineWidth', 'Width', 1, 60)],
  draw: (g) => {
    const p = g.d.props;
    g.poly(g.P, { color: p.lineColor, width: p.lineWidth, round: true, tol: p.lineWidth / 2 + 2 });
  },
});
def({
  id: 'arrowmarker', label: 'Arrow marker', icon: '➤', group: 'shapes', section: 'Arrows', n: 2,
  defaults: { fillColor: TV.blue, ...TEXT_DEF, textColor: TV.blue, bold: true, fontSize: 16 }, style: [S.color('fillColor', 'Color')], textTab: [S.textarea(), S.font()],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = g.P;
    const L = dist(A, B);
    if (L < 2) return;
    const u = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
    const n = { x: -u.y, y: u.x };
    const head = Math.min(L * 0.45, 24);
    const shaft = Math.max(3, Math.min(8, L / 10));
    const hb = add(B, u, -head);
    g.poly([add(A, n, shaft / 2), add(hb, n, shaft / 2), add(hb, n, head * 0.6), B, add(hb, n, -head * 0.6), add(hb, n, -shaft / 2), add(A, n, -shaft / 2)], { fill: p.fillColor, closed: true });
    if (p.text) g.text(p.text, A.x, A.y + (u.y > 0 ? -6 : 6), { color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, align: 'center', baseline: u.y > 0 ? 'bottom' : 'top' });
  },
});
def({
  id: 'arrow', label: 'Arrow', icon: '➝', group: 'shapes', section: 'Arrows', n: 2,
  defaults: { ...LINE_DEF, extendLeft: false, extendRight: false, leftEnd: 0, rightEnd: 1, ...STATS_DEF, ...TEXT_DEF },
  style: LINE_STYLE_TAB, textTab: TEXT_TAB, draw: (g) => drawLineTool(g),
});
for (const [id, label, icon, up] of [['arrowup', 'Arrow mark up', '▲', true], ['arrowdown', 'Arrow mark down', '▼', false]]) {
  def({
    id, label, icon, group: 'shapes', section: 'Arrows', n: 1,
    defaults: { fillColor: up ? TV.green : TV.red, ...TEXT_DEF, textColor: up ? TV.green : TV.red, fontSize: 14 }, style: [S.color('fillColor', 'Color')], textTab: [S.textarea(), S.font()],
    draw: (g) => {
      const p = g.d.props;
      const a = g.P[0];
      const s = 10;
      const k = up ? 1 : -1;
      const pts = [a, { x: a.x + s, y: a.y + s * k }, { x: a.x + s / 2.5, y: a.y + s * k }, { x: a.x + s / 2.5, y: a.y + 2 * s * k }, { x: a.x - s / 2.5, y: a.y + 2 * s * k }, { x: a.x - s / 2.5, y: a.y + s * k }, { x: a.x - s, y: a.y + s * k }];
      g.poly(pts, { fill: p.fillColor, closed: true });
      if (p.text) g.text(p.text, a.x, a.y + (2 * s + 4) * k, { color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, align: 'center', baseline: up ? 'top' : 'bottom' });
    },
  });
}

// ===== Geometric shapes: shapes
def({
  id: 'rect', label: 'Rectangle', icon: '▭', group: 'shapes', section: 'Shapes', n: 2, key: 'Alt+R',
  defaults: { ...SHAPE_DEF, extendLeft: false, extendRight: false, showMiddle: false, midColor: TV.blue },
  style: [...SHAPE_TAB, S.check('showMiddle', 'Middle line'), S.color('midColor', 'Middle line color'), S.check('extendLeft', 'Extend left'), S.check('extendRight', 'Extend right')], textTab: TEXT_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [a, b] = g.P;
    const x0 = p.extendLeft ? 0 : Math.min(a.x, b.x);
    const x1 = p.extendRight ? g.w : Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    g.rect(x0, y0, x1 - x0, y1 - y0, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle, fill: p.fill ? p.fillColor : undefined });
    if (p.showMiddle) g.seg({ x: x0, y: (y0 + y1) / 2 }, { x: x1, y: (y0 + y1) / 2 }, { color: p.midColor, width: 1, style: 2 });
    if (p.text) {
      const tx = p.hAlign === 'left' ? x0 + 6 : p.hAlign === 'right' ? x1 - 6 : (x0 + x1) / 2;
      const ty = p.vAlign === 'top' ? y0 + 6 : p.vAlign === 'bottom' ? y1 - 6 : (y0 + y1) / 2;
      g.text(p.text, tx, ty, { color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, align: p.hAlign, baseline: p.vAlign === 'top' ? 'top' : p.vAlign === 'bottom' ? 'bottom' : 'middle' });
    }
  },
  // TradingView rectangles have 4 corner handles and 4 edge-midpoint handles.
  handles: (g) => {
    const [a, b] = g.P;
    return [a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }, { x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }, { x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }];
  },
  moveHandle: (d, i, pt) => {
    const [a, b] = d.points;
    switch (i) {
      case 0: d.points[0] = pt; break;
      case 1: d.points[1] = pt; break;
      case 2: d.points[0] = { time: pt.time, price: a.price }; d.points[1] = { time: b.time, price: pt.price }; break;
      case 3: d.points[1] = { time: pt.time, price: b.price }; d.points[0] = { time: a.time, price: pt.price }; break;
      case 4: d.points[0] = { time: a.time, price: pt.price }; break;
      case 5: d.points[1] = { time: b.time, price: pt.price }; break;
      case 6: d.points[0] = { time: pt.time, price: a.price }; break;
      default: d.points[1] = { time: pt.time, price: b.price };
    }
  },
});
def({
  id: 'rotrect', label: 'Rotated rectangle', icon: '◇', group: 'shapes', section: 'Shapes', n: 3, defaults: SHAPE_DEF, style: SHAPE_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [A, B, C0] = g.P;
    const C = C0 ?? B;
    const L = dist(A, B) || 1;
    const n = { x: -(B.y - A.y) / L, y: (B.x - A.x) / L };
    const w = (C.x - A.x) * n.x + (C.y - A.y) * n.y;
    g.poly([A, B, add(B, n, w), add(A, n, w)], { color: p.lineColor, width: p.lineWidth, style: p.lineStyle, fill: p.fill ? p.fillColor : undefined, closed: true });
  },
});
def({
  id: 'path', label: 'Path', icon: '⤳', group: 'shapes', section: 'Shapes', n: 'multi',
  defaults: { ...LINE_DEF, leftEnd: 0, rightEnd: 1 }, style: [S.line(), S.select('leftEnd', 'Left end', ENDS), S.select('rightEnd', 'Right end', ENDS)],
  draw: (g) => {
    const p = g.d.props;
    g.poly(g.P, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    const n = g.P.length;
    if (n >= 2 && p.rightEnd === 1) g.arrowHead(g.P[n - 2], g.P[n - 1], p.lineColor, p.lineWidth);
    if (n >= 2 && p.leftEnd === 1) g.arrowHead(g.P[1], g.P[0], p.lineColor, p.lineWidth);
  },
});
def({
  id: 'circle', label: 'Circle', icon: '◯', group: 'shapes', section: 'Shapes', n: 2, defaults: SHAPE_DEF, style: SHAPE_TAB, textTab: TEXT_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = g.P;
    const r = dist(A, B);
    g.ellipse(A.x, A.y, r, r, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle, fill: p.fill ? p.fillColor : undefined });
    if (p.text) g.text(p.text, A.x, A.y, { color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, align: 'center', baseline: 'middle' });
  },
});
def({
  id: 'ellipse', label: 'Ellipse', icon: '⬭', group: 'shapes', section: 'Shapes', n: 3, defaults: SHAPE_DEF, style: SHAPE_TAB, textTab: TEXT_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [A, B, C0] = g.P;
    const c = mid(A, B);
    const rx = dist(A, B) / 2;
    const L = dist(A, B) || 1;
    const n = { x: -(B.y - A.y) / L, y: (B.x - A.x) / L };
    const ry = C0 ? Math.max(2, Math.abs((C0.x - c.x) * n.x + (C0.y - c.y) * n.y)) : rx / 2;
    g.ellipse(c.x, c.y, rx, ry, { rotation: Math.atan2(B.y - A.y, B.x - A.x), color: p.lineColor, width: p.lineWidth, style: p.lineStyle, fill: p.fill ? p.fillColor : undefined });
    if (p.text) g.text(p.text, c.x, c.y, { color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, align: 'center', baseline: 'middle' });
  },
});
def({
  id: 'polyline', label: 'Polyline', icon: '⌇', group: 'shapes', section: 'Shapes', n: 'multi', defaults: { ...SHAPE_DEF, fill: false }, style: SHAPE_TAB,
  draw: (g) => {
    const p = g.d.props;
    const closed = g.P.length > 2 && dist(g.P[0], g.P.at(-1)) < 8;
    g.poly(g.P, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle, fill: p.fill || closed ? p.fillColor : undefined, closed });
  },
});
def({
  id: 'triangle', label: 'Triangle', icon: '△', group: 'shapes', section: 'Shapes', n: 3, defaults: SHAPE_DEF, style: SHAPE_TAB,
  draw: (g) => {
    const p = g.d.props;
    g.poly(g.P, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle, fill: p.fill && g.P.length === 3 ? p.fillColor : undefined, closed: g.P.length === 3 });
  },
});
def({
  id: 'arc', label: 'Arc', icon: '◡', group: 'shapes', section: 'Shapes', n: 3, defaults: SHAPE_DEF, style: SHAPE_TAB,
  draw: (g) => {
    const p = g.d.props;
    const [A, B, C] = g.P;
    if (!C) { g.seg(A, B, { color: p.lineColor, width: p.lineWidth }); return; }
    const circ = circleFrom3(A, C, B);
    if (!circ || circ.r > 1e5) { g.seg(A, B, { color: p.lineColor, width: p.lineWidth }); return; }
    const a1 = Math.atan2(A.y - circ.y, A.x - circ.x);
    const a2 = Math.atan2(B.y - circ.y, B.x - circ.x);
    const ac = Math.atan2(C.y - circ.y, C.x - circ.x);
    const norm = (v) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const ccw = !(norm(ac - a1) < norm(a2 - a1));
    if (p.fill) {
      g.ctx.beginPath();
      g.ctx.arc(circ.x, circ.y, circ.r, a1, a2, ccw);
      g.ctx.closePath();
      g.ctx.fillStyle = p.fillColor;
      g.ctx.fill();
    }
    g.ellipse(circ.x, circ.y, circ.r, circ.r, { start: a1, end: a2, ccw, color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
  },
});
// Control point so a quadratic Bézier from A to B passes through C at t = 0.5.
function quadThrough(A, B, C) {
  return { x: 2 * C.x - (A.x + B.x) / 2, y: 2 * C.y - (A.y + B.y) / 2 };
}
function quadPoints(A, K, B, step = 0.04) {
  const pts = [];
  for (let t = 0; t <= 1.0001; t += step) pts.push({ x: (1 - t) ** 2 * A.x + 2 * (1 - t) * t * K.x + t * t * B.x, y: (1 - t) ** 2 * A.y + 2 * (1 - t) * t * K.y + t * t * B.y });
  return pts;
}
def({
  id: 'curve', label: 'Curve', icon: '⌒', group: 'shapes', section: 'Shapes', n: 3, defaults: { ...LINE_DEF, leftEnd: 0, rightEnd: 0 }, style: [S.line(), S.select('leftEnd', 'Left end', ENDS), S.select('rightEnd', 'Right end', ENDS)],
  draw: (g) => {
    const p = g.d.props;
    const [A, B, C0] = g.P;
    const pts = quadPoints(A, quadThrough(A, B, C0 ?? mid(A, B)), B);
    g.poly(pts, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    if (p.rightEnd === 1) g.arrowHead(pts.at(-2), pts.at(-1), p.lineColor, p.lineWidth);
    if (p.leftEnd === 1) g.arrowHead(pts[1], pts[0], p.lineColor, p.lineWidth);
  },
});
def({
  id: 'doublecurve', label: 'Double curve', icon: '∽', group: 'shapes', section: 'Shapes', n: 3, defaults: { ...LINE_DEF, leftEnd: 0, rightEnd: 0 }, style: [S.line(), S.select('leftEnd', 'Left end', ENDS), S.select('rightEnd', 'Right end', ENDS)],
  draw: (g) => {
    const p = g.d.props;
    const [A, B, C0] = g.P;
    const C = C0 ?? lerp(A, B, 0.25);
    const M = mid(A, B);
    const C2 = { x: 2 * M.x - C.x, y: 2 * M.y - C.y };
    const pts = [...quadPoints(A, quadThrough(A, M, C), M, 0.05), ...quadPoints(M, quadThrough(M, B, C2), B, 0.05).slice(1)];
    g.poly(pts, { color: p.lineColor, width: p.lineWidth, style: p.lineStyle });
    if (p.rightEnd === 1) g.arrowHead(pts.at(-2), pts.at(-1), p.lineColor, p.lineWidth);
    if (p.leftEnd === 1) g.arrowHead(pts[1], pts[0], p.lineColor, p.lineWidth);
  },
});

// ===== Annotation
const TEXTBOX_TAB = [S.textarea(), S.font(), S.fill('Background', 'fill', 'fillColor'), S.check('border', 'Border'), S.color('borderColor', 'Border color'), S.check('wordWrap', 'Text wrap'), S.num('wrapWidth', 'Wrap width', 40, 1000)];
function wrapText(ctx, text, width, font) {
  ctx.font = font;
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > width && line) { out.push(line); line = word; } else line = test;
    }
    out.push(line);
  }
  return out.join('\n');
}
def({
  id: 'text', label: 'Text', icon: 'T', group: 'annotation', section: 'Text and notes', n: 1, editText: true,
  defaults: { text: '', textColor: TV.blue, fontSize: 14, bold: false, italic: false, fill: false, fillColor: 'rgba(41, 98, 255, 0.2)', border: false, borderColor: TV.blue, wordWrap: false, wrapWidth: 200 },
  style: [], textTab: TEXTBOX_TAB,
  draw: (g) => {
    const p = g.d.props;
    const a = g.P[0];
    const text = p.wordWrap ? wrapText(g.ctx, p.text, p.wrapWidth, `${p.fontSize}px Inter`) : p.text;
    g.text(text || 'Text', a.x, a.y, { color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, bg: p.fill ? p.fillColor : undefined, border: p.border ? p.borderColor : undefined, pad: p.fill || p.border ? 6 : 2, baseline: 'middle', hit: true });
  },
});
def({
  id: 'note', label: 'Note', icon: '🗒', group: 'annotation', section: 'Text and notes', n: 1, editText: true,
  defaults: { text: '', textColor: '#DBDBDB', fontSize: 14, bold: false, italic: false, markerColor: TV.blue, fillColor: 'rgba(34, 34, 34, 0.95)', borderColor: '#464646' },
  style: [S.color('markerColor', 'Label')], textTab: [S.textarea(), S.font(), S.color('fillColor', 'Background'), S.color('borderColor', 'Border')],
  draw: (g) => {
    const p = g.d.props;
    const a = g.P[0];
    g.ellipse(a.x, a.y - 12, 9, 9, { fill: p.markerColor, color: '#fff', width: 1.5 });
    g.text('✎', a.x, a.y - 12, { color: '#fff', size: 10, align: 'center', baseline: 'middle' });
    g.seg({ x: a.x, y: a.y - 3 }, a, { color: p.markerColor, width: 2 });
    if ((g.selected || g.hover) && p.text) g.text(p.text, a.x + 14, a.y - 26, { color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, bg: p.fillColor, border: p.borderColor, pad: 8, radius: 6, clamp: true });
  },
});
def({
  id: 'pricenote', label: 'Price note', icon: '⌁', group: 'annotation', section: 'Text and notes', n: 2,
  defaults: { lineColor: TV.blue, lineWidth: 1, lineStyle: 0, textColor: '#FFFFFF', fontSize: 12, labelBg: TV.blue },
  style: [S.line(), S.color('labelBg', 'Label background'), S.color('textColor', 'Text')],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = g.P;
    g.dot(A, p.lineColor, 3.5);
    g.seg(A, B, { color: p.lineColor, width: p.lineWidth });
    g.text(g.fmt(g.d.points[0].price), B.x, B.y, { bg: p.labelBg, color: p.textColor, size: p.fontSize, align: B.x >= A.x ? 'left' : 'right', baseline: 'middle', pad: 5, hit: true });
  },
});
def({
  id: 'callout', label: 'Callout', icon: '💬', group: 'annotation', section: 'Text and notes', n: 2, editText: true,
  defaults: { text: '', textColor: '#FFFFFF', fontSize: 14, bold: false, italic: false, fillColor: 'rgba(0, 151, 167, 0.7)', borderColor: '#0097A7', lineWidth: 1, wordWrap: false, wrapWidth: 200 },
  style: [S.color('fillColor', 'Background'), S.color('borderColor', 'Border')], textTab: [S.textarea(), S.font(), S.check('wordWrap', 'Text wrap'), S.num('wrapWidth', 'Wrap width', 40, 1000)],
  draw: (g) => {
    const p = g.d.props;
    const [A, B] = g.P;
    const raw = p.text || 'Callout';
    const text = p.wordWrap ? wrapText(g.ctx, raw, p.wrapWidth, `${p.fontSize}px Inter`) : raw;
    const box = g.text(text, B.x, B.y, { color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, bg: p.fillColor, border: p.borderColor, pad: 8, radius: 4, align: 'center', baseline: 'middle', hit: true });
    if (!box) return;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const half = Math.min(10, box.w / 4);
    const horizontal = Math.abs(A.x - cx) / box.w > Math.abs(A.y - cy) / box.h;
    const base = horizontal
      ? [{ x: A.x > cx ? box.x + box.w : box.x, y: cy - half }, { x: A.x > cx ? box.x + box.w : box.x, y: cy + half }]
      : [{ x: cx - half, y: A.y > cy ? box.y + box.h : box.y }, { x: cx + half, y: A.y > cy ? box.y + box.h : box.y }];
    g.poly([base[0], A, base[1]], { fill: p.fillColor, color: p.borderColor, width: p.lineWidth });
  },
});
def({
  id: 'pricelabel', label: 'Price label', icon: '🏷', group: 'annotation', section: 'Text and notes', n: 1,
  defaults: { fillColor: TV.blue, textColor: '#FFFFFF', fontSize: 12 },
  style: [S.color('fillColor', 'Background'), S.color('textColor', 'Text'), S.num('fontSize', 'Font size', 8, 40)],
  draw: (g) => {
    const p = g.d.props;
    const a = g.P[0];
    const box = g.text(g.fmt(g.d.points[0].price), a.x, a.y - 8, { bg: p.fillColor, color: p.textColor, size: p.fontSize, align: 'center', baseline: 'bottom', pad: 5, hit: true });
    if (box) g.poly([{ x: a.x - 6, y: box.y + box.h }, a, { x: a.x + 6, y: box.y + box.h }], { fill: p.fillColor, closed: true });
  },
});
def({
  id: 'signpost', label: 'Signpost', icon: '🪧', group: 'annotation', section: 'Text and notes', n: 1, editText: true,
  defaults: { text: '', plateColor: TV.blue, textColor: '#FFFFFF', fontSize: 12, bold: false, italic: false },
  style: [S.color('plateColor', 'Plate')], textTab: [S.textarea(), S.font()],
  draw: (g) => {
    const p = g.d.props;
    const a = g.P[0];
    const bar = g.candles[Math.round(g.L.timeToLogical(g.d.points[0].time))];
    const above = bar ? g.d.points[0].price >= bar.high : true;
    const anchorY = bar ? g.y(above ? bar.high : bar.low) : a.y;
    g.seg({ x: a.x, y: anchorY }, a, { color: p.plateColor, width: 1, style: 2 });
    g.dot({ x: a.x, y: anchorY }, p.plateColor, 2.5);
    g.text(p.text || 'Signpost', a.x, a.y, { bg: p.plateColor, color: p.textColor, size: p.fontSize, bold: p.bold, italic: p.italic, align: 'center', baseline: above ? 'bottom' : 'top', pad: 6, radius: 10, hit: true });
  },
});
def({
  id: 'flag', label: 'Flag mark', icon: '⚑', group: 'annotation', section: 'Text and notes', n: 1,
  defaults: { fillColor: TV.blue }, style: [S.color('fillColor', 'Color')],
  draw: (g) => {
    const p = g.d.props;
    const a = g.P[0];
    g.seg(a, { x: a.x, y: a.y - 24 }, { color: p.fillColor, width: 2 });
    g.poly([{ x: a.x, y: a.y - 24 }, { x: a.x + 16, y: a.y - 19 }, { x: a.x, y: a.y - 13 }], { fill: p.fillColor, closed: true });
    g.hits.push({ k: 'box', x: a.x - 4, y: a.y - 26, w: 22, h: 28 });
  },
});

export const TOOLS = T;
export const toolById = (id) => T.find((t) => t.id === id);

// Toolbar groups, in TradingView order.
export const GROUPS = [
  { id: 'cursors', label: 'Cursors', sections: ['Cursors'] },
  { id: 'lines', label: 'Trend line tools', sections: ['Lines', 'Channels', 'Pitchforks'] },
  { id: 'fib', label: 'Gann and Fibonacci tools', sections: ['Fibonacci', 'Gann'] },
  { id: 'patterns', label: 'Patterns', sections: ['Chart patterns', 'Elliott waves', 'Cycles'] },
  { id: 'forecast', label: 'Forecasting and measurement tools', sections: ['Forecasting', 'Volume-based', 'Measurers'] },
  { id: 'shapes', label: 'Geometric shapes', sections: ['Brushes', 'Arrows', 'Shapes'] },
  { id: 'annotation', label: 'Annotation tools', sections: ['Text and notes'] },
];

// Fresh props for a tool (deep-cloned so level arrays are never shared between drawings).
export function defaultProps(tool, overrides) {
  return JSON.parse(JSON.stringify({ ...(tool.defaults ?? {}), ...(overrides ?? {}) }));
}

// Visibility on timeframes (TradingView "Visibility" tab).
export const VIS_GROUPS = [
  { id: 'minutes', label: 'Minutes', min: 1, max: 59 },
  { id: 'hours', label: 'Hours', min: 1, max: 24 },
  { id: 'days', label: 'Days', min: 1, max: 366 },
  { id: 'weeks', label: 'Weeks', min: 1, max: 52 },
  { id: 'months', label: 'Months', min: 1, max: 12 },
];
export function defaultVisibility() {
  return Object.fromEntries(VIS_GROUPS.map((v) => [v.id, { on: true, from: v.min, to: v.max }]));
}
export function visibleOnInterval(vis, intervalId) {
  if (!vis) return true;
  const m = String(intervalId).match(/^(\d+)([mhdwM])$/);
  if (!m) return true;
  const key = { m: 'minutes', h: 'hours', d: 'days', w: 'weeks', M: 'months' }[m[2]];
  const v = vis[key];
  if (!v) return true;
  const n = Number(m[1]);
  return v.on && n >= v.from && n <= v.to;
}

export const makeFmt = (digits) => (v) => formatPrice(v, digits);
