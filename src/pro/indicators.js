// Technical indicator math + definitions. Every calc returns arrays aligned to the candle array,
// with NaN where the indicator has not warmed up yet.

import { CUSTOM_DEFS } from './customind.js';

const N = NaN;
const src = (c, s) => {
  switch (s) {
    case 'open': return c.map((b) => b.open);
    case 'high': return c.map((b) => b.high);
    case 'low': return c.map((b) => b.low);
    case 'hl2': return c.map((b) => (b.high + b.low) / 2);
    case 'hlc3': return c.map((b) => (b.high + b.low + b.close) / 3);
    case 'ohlc4': return c.map((b) => (b.open + b.high + b.low + b.close) / 4);
    default: return c.map((b) => b.close);
  }
};

export function sma(values, n) {
  const out = new Array(values.length).fill(N);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) { sum = 0; count = 0; continue; }
    sum += v;
    count++;
    if (count > n) { sum -= values[i - n]; count = n; }
    if (count === n) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(N);
  const k = 2 / (n + 1);
  let prev = N;
  let seed = 0;
  let seeded = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v;
      seeded++;
      if (seeded === n) { prev = seed / n; out[i] = prev; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rma(values, n) {
  const out = new Array(values.length).fill(N);
  let prev = N;
  let seed = 0;
  let seeded = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v;
      seeded++;
      if (seeded === n) { prev = seed / n; out[i] = prev; }
      continue;
    }
    prev = (prev * (n - 1) + v) / n;
    out[i] = prev;
  }
  return out;
}

export function wma(values, n) {
  const out = new Array(values.length).fill(N);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    let bad = false;
    for (let j = 0; j < n; j++) {
      const v = values[i - j];
      if (Number.isNaN(v)) { bad = true; break; }
      s += v * (n - j);
    }
    if (!bad) out[i] = s / denom;
  }
  return out;
}

export function stdev(values, n) {
  const mean = sma(values, n);
  return values.map((_, i) => {
    if (Number.isNaN(mean[i])) return N;
    let s = 0;
    for (let j = 0; j < n; j++) s += (values[i - j] - mean[i]) ** 2;
    return Math.sqrt(s / n);
  });
}

function windowExtreme(values, n, pickMax) {
  const out = new Array(values.length).fill(N);
  for (let i = n - 1; i < values.length; i++) {
    let m = values[i];
    for (let j = 1; j < n; j++) {
      const v = values[i - j];
      if (pickMax ? v > m : v < m) m = v;
    }
    out[i] = m;
  }
  return out;
}
const highest = (values, n) => windowExtreme(values, n, true);
const lowest = (values, n) => windowExtreme(values, n, false);

export function trueRange(c) {
  return c.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1].close), Math.abs(b.low - c[i - 1].close))));
}

export const atr = (c, n) => rma(trueRange(c), n);

export function rsi(values, n) {
  const gains = values.map((v, i) => (i === 0 ? N : Math.max(v - values[i - 1], 0)));
  const losses = values.map((v, i) => (i === 0 ? N : Math.max(values[i - 1] - v, 0)));
  const ag = rma(gains, n);
  const al = rma(losses, n);
  return ag.map((g, i) => (Number.isNaN(g) ? N : al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i])));
}

export function supertrend(c, period, mult) {
  const a = atr(c, period);
  const dir = new Array(c.length).fill(N);
  const line = new Array(c.length).fill(N);
  let upper = N;
  let lower = N;
  let d = 1;
  for (let i = 0; i < c.length; i++) {
    if (Number.isNaN(a[i])) continue;
    const mid = (c[i].high + c[i].low) / 2;
    let up = mid + mult * a[i];
    let lo = mid - mult * a[i];
    const prevClose = c[i - 1]?.close ?? c[i].close;
    if (!Number.isNaN(upper) && !(up < upper || prevClose > upper)) up = upper;
    if (!Number.isNaN(lower) && !(lo > lower || prevClose < lower)) lo = lower;
    if (!Number.isNaN(upper)) {
      if (d === -1 && c[i].close > upper) d = 1;
      else if (d === 1 && c[i].close < lower) d = -1;
    }
    upper = up;
    lower = lo;
    dir[i] = d;
    line[i] = d === 1 ? lo : up;
  }
  return { line, dir };
}

// ---------- Definitions ----------
const SOURCE = { type: 'select', options: ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'] };

export const INDICATORS = [
  {
    id: 'sma', name: 'Moving Average Simple', short: 'SMA', category: 'Trend', overlay: true,
    inputs: { length: 20, source: { ...SOURCE, default: 'close' } },
    plots: [{ key: 'v', title: 'SMA', color: '#f5a623' }],
    calc: (c, p) => ({ v: sma(src(c, p.source), p.length) }),
  },
  {
    id: 'ema', name: 'Moving Average Exponential', short: 'EMA', category: 'Trend', overlay: true,
    inputs: { length: 21, source: { ...SOURCE, default: 'close' } },
    plots: [{ key: 'v', title: 'EMA', color: '#2f80ed' }],
    calc: (c, p) => ({ v: ema(src(c, p.source), p.length) }),
  },
  {
    id: 'wma', name: 'Moving Average Weighted', short: 'WMA', category: 'Trend', overlay: true,
    inputs: { length: 20, source: { ...SOURCE, default: 'close' } },
    plots: [{ key: 'v', title: 'WMA', color: '#9b51e0' }],
    calc: (c, p) => ({ v: wma(src(c, p.source), p.length) }),
  },
  {
    id: 'hma', name: 'Hull Moving Average', short: 'HMA', category: 'Trend', overlay: true,
    inputs: { length: 31, source: { ...SOURCE, default: 'close' } },
    plots: [{ key: 'v', title: 'HMA', color: '#00b8d9' }],
    calc: (c, p) => {
      const s = src(c, p.source);
      const half = wma(s, Math.max(1, Math.round(p.length / 2)));
      const full = wma(s, p.length);
      return { v: wma(half.map((v, i) => 2 * v - full[i]), Math.max(1, Math.round(Math.sqrt(p.length)))) };
    },
  },
  {
    id: 'vwap', name: 'VWAP', short: 'VWAP', category: 'Volume', overlay: true,
    inputs: { anchor: { type: 'select', options: ['Session', 'Week'], default: 'Session' } },
    plots: [{ key: 'v', title: 'VWAP', color: '#eb5ea8', lineWidth: 2 }],
    calc: (c, p) => {
      let pv = 0;
      let vol = 0;
      let key = null;
      const v = c.map((b) => {
        const k = p.anchor === 'Week' ? Math.floor((b.time / 86400 + 3) / 7) : Math.floor(b.time / 86400);
        if (k !== key) { key = k; pv = 0; vol = 0; }
        pv += ((b.high + b.low + b.close) / 3) * b.volume;
        vol += b.volume;
        return vol ? pv / vol : N;
      });
      return { v };
    },
  },
  {
    id: 'bb', name: 'Bollinger Bands', short: 'BB', category: 'Volatility', overlay: true,
    inputs: { length: 20, mult: 2, source: { ...SOURCE, default: 'close' } },
    plots: [
      { key: 'basis', title: 'Basis', color: '#f5a623' },
      { key: 'upper', title: 'Upper', color: '#2f80ed' },
      { key: 'lower', title: 'Lower', color: '#2f80ed' },
    ],
    calc: (c, p) => {
      const s = src(c, p.source);
      const basis = sma(s, p.length);
      const dev = stdev(s, p.length);
      return { basis, upper: basis.map((b, i) => b + p.mult * dev[i]), lower: basis.map((b, i) => b - p.mult * dev[i]) };
    },
  },
  {
    id: 'kc', name: 'Keltner Channels', short: 'KC', category: 'Volatility', overlay: true,
    inputs: { length: 20, mult: 2, atrLength: 10 },
    plots: [
      { key: 'basis', title: 'Basis', color: '#27ae60' },
      { key: 'upper', title: 'Upper', color: '#27ae60' },
      { key: 'lower', title: 'Lower', color: '#27ae60' },
    ],
    calc: (c, p) => {
      const basis = ema(src(c, 'close'), p.length);
      const a = atr(c, p.atrLength);
      return { basis, upper: basis.map((b, i) => b + p.mult * a[i]), lower: basis.map((b, i) => b - p.mult * a[i]) };
    },
  },
  {
    id: 'dc', name: 'Donchian Channels', short: 'DC', category: 'Volatility', overlay: true,
    inputs: { length: 20 },
    plots: [
      { key: 'upper', title: 'Upper', color: '#00b8d9' },
      { key: 'basis', title: 'Basis', color: '#e8505b' },
      { key: 'lower', title: 'Lower', color: '#00b8d9' },
    ],
    calc: (c, p) => {
      const upper = highest(c.map((b) => b.high), p.length);
      const lower = lowest(c.map((b) => b.low), p.length);
      return { upper, lower, basis: upper.map((u, i) => (u + lower[i]) / 2) };
    },
  },
  {
    id: 'supertrend', name: 'Supertrend', short: 'ST', category: 'Trend', overlay: true,
    inputs: { period: 10, multiplier: 3 },
    plots: [{ key: 'line', title: 'Supertrend', color: '#27ae60', downColor: '#e8505b', lineWidth: 2, colorBy: 'dir' }],
    calc: (c, p) => supertrend(c, p.period, p.multiplier),
  },
  {
    id: 'psar', name: 'Parabolic SAR', short: 'SAR', category: 'Trend', overlay: true,
    inputs: { start: 0.02, increment: 0.02, maximum: 0.2 },
    plots: [{ key: 'v', title: 'SAR', color: '#2f80ed', dots: true }],
    calc: (c, p) => {
      const v = new Array(c.length).fill(N);
      if (c.length < 3) return { v };
      let long = c[1].close >= c[0].close;
      let af = p.start;
      let ep = long ? c[0].high : c[0].low;
      let sar = long ? c[0].low : c[0].high;
      for (let i = 1; i < c.length; i++) {
        sar += af * (ep - sar);
        const prev2 = c[i - 2] ?? c[i - 1];
        if (long) {
          sar = Math.min(sar, c[i - 1].low, prev2.low);
          if (c[i].low < sar) { long = false; sar = ep; ep = c[i].low; af = p.start; }
          else if (c[i].high > ep) { ep = c[i].high; af = Math.min(af + p.increment, p.maximum); }
        } else {
          sar = Math.max(sar, c[i - 1].high, prev2.high);
          if (c[i].high > sar) { long = true; sar = ep; ep = c[i].high; af = p.start; }
          else if (c[i].low < ep) { ep = c[i].low; af = Math.min(af + p.increment, p.maximum); }
        }
        v[i] = sar;
      }
      return { v };
    },
  },
  {
    id: 'ichimoku', name: 'Ichimoku Cloud', short: 'Ichimoku', category: 'Trend', overlay: true,
    inputs: { conversion: 9, base: 26, spanB: 52, displacement: 26 },
    plots: [
      { key: 'tenkan', title: 'Conversion', color: '#2f80ed' },
      { key: 'kijun', title: 'Base', color: '#e8505b' },
      { key: 'spanA', title: 'Lead A', color: '#27ae60' },
      { key: 'spanB', title: 'Lead B', color: '#e8505b' },
      { key: 'chikou', title: 'Lagging', color: '#9b51e0' },
    ],
    calc: (c, p) => {
      const hi = c.map((b) => b.high);
      const lo = c.map((b) => b.low);
      const mid = (n) => {
        const hh = highest(hi, n);
        const ll = lowest(lo, n);
        return hh.map((v, i) => (v + ll[i]) / 2);
      };
      const tenkan = mid(p.conversion);
      const kijun = mid(p.base);
      const a = tenkan.map((t, i) => (t + kijun[i]) / 2);
      const b = mid(p.spanB);
      const shift = (arr, k) => arr.map((_, i) => (i - k >= 0 ? arr[i - k] : N));
      return {
        tenkan,
        kijun,
        spanA: shift(a, p.displacement - 1),
        spanB: shift(b, p.displacement - 1),
        chikou: c.map((_, i) => c[i + p.displacement - 1]?.close ?? N),
      };
    },
  },
  {
    id: 'rsi', name: 'Relative Strength Index', short: 'RSI', category: 'Momentum', overlay: false,
    inputs: { length: 14, source: { ...SOURCE, default: 'close' } },
    plots: [{ key: 'v', title: 'RSI', color: '#9b51e0' }],
    levels: [70, 50, 30],
    calc: (c, p) => ({ v: rsi(src(c, p.source), p.length) }),
  },
  {
    id: 'macd', name: 'MACD', short: 'MACD', category: 'Momentum', overlay: false,
    inputs: { fast: 12, slow: 26, signal: 9, source: { ...SOURCE, default: 'close' } },
    plots: [
      { key: 'hist', title: 'Histogram', type: 'histogram', color: '#26a69a', downColor: '#ef5350', colorBy: 'sign' },
      { key: 'macd', title: 'MACD', color: '#2f80ed' },
      { key: 'signal', title: 'Signal', color: '#f5a623' },
    ],
    levels: [0],
    calc: (c, p) => {
      const s = src(c, p.source);
      const fast = ema(s, p.fast);
      const slow = ema(s, p.slow);
      const macd = fast.map((f, i) => f - slow[i]);
      const signal = ema(macd, p.signal);
      return { macd, signal, hist: macd.map((m, i) => m - signal[i]) };
    },
  },
  {
    id: 'stoch', name: 'Stochastic', short: 'Stoch', category: 'Momentum', overlay: false,
    inputs: { k: 14, kSmooth: 3, d: 3 },
    plots: [
      { key: 'k', title: '%K', color: '#2f80ed' },
      { key: 'd', title: '%D', color: '#f5a623' },
    ],
    levels: [80, 20],
    calc: (c, p) => {
      const hh = highest(c.map((b) => b.high), p.k);
      const ll = lowest(c.map((b) => b.low), p.k);
      const raw = c.map((b, i) => (Number.isNaN(hh[i]) ? N : hh[i] === ll[i] ? 50 : (100 * (b.close - ll[i])) / (hh[i] - ll[i])));
      const k = sma(raw, p.kSmooth);
      return { k, d: sma(k, p.d) };
    },
  },
  {
    id: 'stochrsi', name: 'Stochastic RSI', short: 'StochRSI', category: 'Momentum', overlay: false,
    inputs: { rsiLength: 14, stochLength: 14, k: 3, d: 3 },
    plots: [
      { key: 'k', title: 'K', color: '#2f80ed' },
      { key: 'd', title: 'D', color: '#f5a623' },
    ],
    levels: [80, 20],
    calc: (c, p) => {
      const r = rsi(src(c, 'close'), p.rsiLength);
      const hh = highest(r, p.stochLength);
      const ll = lowest(r, p.stochLength);
      const raw = r.map((v, i) => (Number.isNaN(hh[i]) || Number.isNaN(v) ? N : hh[i] === ll[i] ? 50 : (100 * (v - ll[i])) / (hh[i] - ll[i])));
      const k = sma(raw, p.k);
      return { k, d: sma(k, p.d) };
    },
  },
  {
    id: 'cci', name: 'Commodity Channel Index', short: 'CCI', category: 'Momentum', overlay: false,
    inputs: { length: 20 },
    plots: [{ key: 'v', title: 'CCI', color: '#00b8d9' }],
    levels: [100, 0, -100],
    calc: (c, p) => {
      const tp = src(c, 'hlc3');
      const m = sma(tp, p.length);
      return {
        v: tp.map((t, i) => {
          if (Number.isNaN(m[i])) return N;
          let md = 0;
          for (let j = 0; j < p.length; j++) md += Math.abs(tp[i - j] - m[i]);
          md /= p.length;
          return md === 0 ? 0 : (t - m[i]) / (0.015 * md);
        }),
      };
    },
  },
  {
    id: 'willr', name: 'Williams %R', short: '%R', category: 'Momentum', overlay: false,
    inputs: { length: 14 },
    plots: [{ key: 'v', title: '%R', color: '#eb5ea8' }],
    levels: [-20, -80],
    calc: (c, p) => {
      const hh = highest(c.map((b) => b.high), p.length);
      const ll = lowest(c.map((b) => b.low), p.length);
      return { v: c.map((b, i) => (Number.isNaN(hh[i]) ? N : hh[i] === ll[i] ? -50 : (-100 * (hh[i] - b.close)) / (hh[i] - ll[i]))) };
    },
  },
  {
    id: 'mom', name: 'Momentum', short: 'MOM', category: 'Momentum', overlay: false,
    inputs: { length: 10 },
    plots: [{ key: 'v', title: 'MOM', color: '#2f80ed' }],
    levels: [0],
    calc: (c, p) => ({ v: c.map((b, i) => (i < p.length ? N : b.close - c[i - p.length].close)) }),
  },
  {
    id: 'adx', name: 'ADX / DMI', short: 'ADX', category: 'Trend', overlay: false,
    inputs: { length: 14, smoothing: 14 },
    plots: [
      { key: 'adx', title: 'ADX', color: '#e8505b', lineWidth: 2 },
      { key: 'plus', title: '+DI', color: '#27ae60' },
      { key: 'minus', title: '-DI', color: '#f5a623' },
    ],
    levels: [25],
    calc: (c, p) => {
      const plusDM = c.map((b, i) => {
        if (i === 0) return N;
        const up = b.high - c[i - 1].high;
        const down = c[i - 1].low - b.low;
        return up > down && up > 0 ? up : 0;
      });
      const minusDM = c.map((b, i) => {
        if (i === 0) return N;
        const up = b.high - c[i - 1].high;
        const down = c[i - 1].low - b.low;
        return down > up && down > 0 ? down : 0;
      });
      const tr = rma(trueRange(c).map((v, i) => (i === 0 ? N : v)), p.length);
      const plus = rma(plusDM, p.length).map((v, i) => (100 * v) / tr[i]);
      const minus = rma(minusDM, p.length).map((v, i) => (100 * v) / tr[i]);
      const dx = plus.map((pl, i) => {
        const s = pl + minus[i];
        return Number.isNaN(s) ? N : s === 0 ? 0 : (100 * Math.abs(pl - minus[i])) / s;
      });
      return { adx: rma(dx, p.smoothing), plus, minus };
    },
  },
  {
    id: 'atr', name: 'Average True Range', short: 'ATR', category: 'Volatility', overlay: false,
    inputs: { length: 14 },
    plots: [{ key: 'v', title: 'ATR', color: '#e8505b' }],
    calc: (c, p) => ({ v: atr(c, p.length) }),
  },
  {
    id: 'obv', name: 'On Balance Volume', short: 'OBV', category: 'Volume', overlay: false,
    inputs: {},
    plots: [{ key: 'v', title: 'OBV', color: '#2f80ed' }],
    calc: (c) => {
      let total = 0;
      return {
        v: c.map((b, i) => {
          if (i > 0) total += b.close > c[i - 1].close ? b.volume : b.close < c[i - 1].close ? -b.volume : 0;
          return total;
        }),
      };
    },
  },
  {
    id: 'mfi', name: 'Money Flow Index', short: 'MFI', category: 'Volume', overlay: false,
    inputs: { length: 14 },
    plots: [{ key: 'v', title: 'MFI', color: '#27ae60' }],
    levels: [80, 20],
    calc: (c, p) => {
      const tp = src(c, 'hlc3');
      const flow = tp.map((t, i) => t * c[i].volume);
      return {
        v: tp.map((_, i) => {
          if (i < p.length) return N;
          let pos = 0;
          let neg = 0;
          for (let j = i - p.length + 1; j <= i; j++) {
            if (tp[j] > tp[j - 1]) pos += flow[j];
            else if (tp[j] < tp[j - 1]) neg += flow[j];
          }
          return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
        }),
      };
    },
  },
  {
    id: 'volma', name: 'Volume + MA', short: 'Vol', category: 'Volume', overlay: false,
    inputs: { length: 20 },
    plots: [
      { key: 'vol', title: 'Volume', type: 'histogram', color: 'rgba(38,166,154,.6)', downColor: 'rgba(239,83,80,.6)', colorBy: 'candle' },
      { key: 'ma', title: 'MA', color: '#f5a623' },
    ],
    calc: (c, p) => {
      const vol = c.map((b) => b.volume);
      return { vol, ma: sma(vol, p.length) };
    },
  },
];

// Custom indicators ported from the CandL platform (see customind.js) join the built-ins.
INDICATORS.push(...CUSTOM_DEFS);

export const indicatorById = (id) => INDICATORS.find((i) => i.id === id);

export function defaultParams(def) {
  const params = {};
  for (const [key, spec] of Object.entries(def.inputs)) {
    params[key] = typeof spec === 'object' ? spec.default : spec;
  }
  return params;
}
