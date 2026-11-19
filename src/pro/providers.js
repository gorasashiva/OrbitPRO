// Market data providers. Symbols follow TradingView-style conventions:
//   BTCUSDT                       Binance spot
//   BTCUSDT.P                     Binance USDⓈ-M perpetual
//   BTC-261225-85000-C            Binance option (USDT-quoted)
//   DERIBIT:BTC-27NOV26-64000-C   Deribit option (BTC-quoted) / DERIBIT:BTC-PERPETUAL
// Each provider exposes history, live bars/trades/quotes, extra info (funding, greeks) and symbols.

import {
  fetchSymbols, futuresBookHub, futuresHub, getJSONFrom, hub, optionsHub, parseKline, pushPrice,
} from './binance.js';
import { intervalSec } from './util.js';

const FAPI = 'https://fapi.binance.com/fapi/v1';
const EAPI = '/eapi/v1'; // proxied by the dev server (Binance options REST has no CORS headers)
const DERIBIT = '/deribit/api/v2/public'; // proxied by the dev server (chart data has no CORS headers)
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export const PROVIDER_INFO = {
  spot: { id: 'spot', exchange: 'Binance', market: 'Spot', short: 'Binance' },
  perp: { id: 'perp', exchange: 'Binance', market: 'USDⓈ-M Perpetual', short: 'Binance Perp' },
  bopt: { id: 'bopt', exchange: 'Binance', market: 'Options', short: 'Binance Options' },
  deribit: { id: 'deribit', exchange: 'Deribit', market: 'Options & Futures', short: 'Deribit' },
};

export function parseSymbol(sym) {
  if (sym.startsWith('DERIBIT:')) return { provider: 'deribit', raw: sym.slice(8) };
  if (sym.endsWith('.P')) return { provider: 'perp', raw: sym.slice(0, -2) };
  if (/^[A-Z0-9]+-\d{6}-[\d.]+-[CP]$/.test(sym)) return { provider: 'bopt', raw: sym };
  return { provider: 'spot', raw: sym };
}

// Option contract details from either naming scheme.
export function parseOption(sym) {
  const { provider, raw } = parseSymbol(sym);
  let m = raw.match(/^([A-Z0-9]+)-(\d{2})(\d{2})(\d{2})-([\d.]+)-([CP])$/);
  if (provider === 'bopt' && m) {
    return { base: m[1], expiry: Date.UTC(2000 + Number(m[2]), Number(m[3]) - 1, Number(m[4]), 8), strike: Number(m[5]), side: m[6] };
  }
  m = raw.match(/^([A-Z0-9_]+)-(\d{1,2})([A-Z]{3})(\d{2})-([\dd.]+)-([CP])$/);
  if (provider === 'deribit' && m) {
    return { base: m[1].replace('_USDC', ''), expiry: Date.UTC(2000 + Number(m[4]), MONTHS.indexOf(m[3]), Number(m[2]), 8), strike: Number(m[5].replace('d', '.')), side: m[6] };
  }
  return null;
}

export function optionTitle(sym) {
  const o = parseOption(sym);
  if (!o) return null;
  const d = new Date(o.expiry);
  const mon = MONTHS[d.getUTCMonth()];
  return `${o.base} ${d.getUTCDate()} ${mon[0]}${mon.slice(1).toLowerCase()} '${String(d.getUTCFullYear()).slice(2)} ${o.strike.toLocaleString('en-US')} ${o.side === 'C' ? 'Call' : 'Put'}`;
}

// ---------------------------------------------------------------- shared helpers
// Bucket start for an interval (weeks start Monday 00:00 UTC, months on the 1st, like Binance).
export function bucketStart(t, interval) {
  if (interval === '1M') {
    const d = new Date(t * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  }
  if (interval === '1w') return Math.floor((t - 345600) / 604800) * 604800 + 345600;
  const sec = intervalSec(interval);
  return Math.floor(t / sec) * sec;
}

export function aggregate(bars, interval) {
  const out = [];
  for (const b of bars) {
    const t = bucketStart(b.time, interval);
    const last = out.at(-1);
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else {
      out.push({ ...b, time: t });
    }
  }
  return out;
}

const binanceTrade = (t) => ({ id: t.a, price: Number(t.p), qty: Number(t.q), time: t.T, buyerMaker: Boolean(t.m) });
const binanceKlineBar = (k) => parseKline([k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q, k.n, k.V]);

// ---------------------------------------------------------------- Binance spot & perpetuals
function binanceMarket(id, restBase, streamHub, klinePath, bookHub = streamHub) {
  return {
    id,
    footprint: true,
    supports: () => true,
    async fetchKlines(raw, interval, { limit = 1000, endTime, startTime } = {}) {
      const end = `${startTime ? `&startTime=${startTime}` : ''}${endTime ? `&endTime=${endTime}` : ''}`;
      const rows = await getJSONFrom(`${restBase}${klinePath}?symbol=${raw}&interval=${interval}&limit=${limit}${end}`);
      return rows.map(parseKline);
    },
    // Historical aggregated trades (exact price, size and aggressor side) for the footprint.
    // Query by time window (Binance caps it at 1 hour) or page forward with fromId.
    async fetchAggTrades(raw, { startTime, endTime, fromId, limit = 1000 } = {}) {
      const q = fromId !== undefined ? `&fromId=${fromId}` : `&startTime=${startTime}&endTime=${endTime}`;
      const rows = await getJSONFrom(`${restBase}${klinePath.replace('klines', 'aggTrades')}?symbol=${raw}&limit=${limit}${q}`);
      return rows.map(binanceTrade);
    },
    // Finest kline interval this market serves (spot has 1s, futures start at 1m).
    minKlineSec: id === 'spot' ? 1 : 60,
    streamBars(raw, interval, onBar) {
      return streamHub.subscribe(`${raw.toLowerCase()}@kline_${interval}`, (m) => onBar(binanceKlineBar(m.k), m.E));
    },
    streamTrades(raw, onTrade) {
      return streamHub.subscribe(`${raw.toLowerCase()}@aggTrade`, (t) => onTrade(binanceTrade(t)));
    },
    streamQuote(raw, onQuote) {
      return bookHub.subscribe(`${raw.toLowerCase()}@bookTicker`, (q) => onQuote({ bid: Number(q.b), ask: Number(q.a) }));
    },
  };
}

const spot = { ...binanceMarket('spot', 'https://api.binance.com', hub, '/api/v3/klines'), symbols: () => fetchSymbols() };

let perpSymbols;
const perp = {
  ...binanceMarket('perp', 'https://fapi.binance.com', futuresHub, '/fapi/v1/klines', futuresBookHub),
  symbols() {
    perpSymbols ??= getJSONFrom(`${FAPI}/exchangeInfo`).then((info) => info.symbols
      .filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING')
      .map((s) => ({
        symbol: `${s.symbol}.P`, base: s.baseAsset, quote: s.quoteAsset, type: 'perp', provider: 'perp',
        tick: Number(s.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize ?? 0.01),
      })))
      .catch((e) => { perpSymbols = undefined; throw e; });
    return perpSymbols;
  },
  // Mark price, index and funding (TradingView shows these for perpetuals).
  streamInfo(raw, onInfo) {
    return futuresHub.subscribe(`${raw.toLowerCase()}@markPrice@1s`, (m) => onInfo({
      mark: Number(m.p), index: Number(m.i), funding: Number(m.r), nextFunding: m.T,
    }));
  },
};

// ---------------------------------------------------------------- Binance options
let boptSymbols;
const markListeners = new Map(); // underlying (btcusdt) -> { unsub, handlers: Map(symbol | '*' -> Set(fn)) }

function boptMark(underlying, symbol, fn) {
  const key = underlying.toLowerCase();
  let entry = markListeners.get(key);
  if (!entry) {
    entry = { handlers: new Map() };
    entry.unsub = optionsHub.subscribe(`${key}@optionMarkPrice`, (rows) => {
      for (const r of rows) entry.handlers.get(r.s)?.forEach((h) => h(r));
      entry.handlers.get('*')?.forEach((h) => h(rows));
    });
    markListeners.set(key, entry);
  }
  if (!entry.handlers.has(symbol)) entry.handlers.set(symbol, new Set());
  entry.handlers.get(symbol).add(fn);
  return () => {
    entry.handlers.get(symbol)?.delete(fn);
    if (!entry.handlers.get(symbol)?.size) entry.handlers.delete(symbol);
    if (!entry.handlers.size) {
      entry.unsub();
      markListeners.delete(key);
    }
  };
}

export function boptQuoteFrom(r) {
  const bid = Number(r.bo);
  const ask = Number(r.ao);
  const mark = Number(r.mp);
  return {
    bid: bid > 0 ? bid : mark, ask: ask > 0 ? ask : mark, mark, index: Number(r.i), option: true,
    iv: Number(r.vo), bidIv: Number(r.b), askIv: Number(r.a),
    delta: Number(r.d), gamma: Number(r.g), theta: Number(r.t), vega: Number(r.v),
  };
}

const bopt = {
  id: 'bopt',
  supports: (iv) => iv !== '1M' && iv !== '8h',
  async fetchKlines(raw, interval, { limit = 500, endTime } = {}) {
    const end = endTime ? `&endTime=${endTime}` : '';
    const rows = await getJSONFrom(`${EAPI}/klines?symbol=${raw}&interval=${interval}&limit=${Math.min(limit, 500)}${end}`);
    return rows.map(parseKline);
  },
  // Option contracts trade rarely and have no public kline/trade stream: poll the latest bars.
  streamBars(raw, interval, onBar) {
    let stopped = false;
    let timer;
    const poll = async () => {
      if (stopped) return;
      try {
        const rows = await getJSONFrom(`${EAPI}/klines?symbol=${raw}&interval=${interval}&limit=2`);
        if (!stopped) for (const r of rows) onBar(parseKline(r), Date.now());
      } catch { /* transient; the next poll retries */ }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  },
  streamQuote(raw, onQuote) {
    const o = parseOption(raw);
    return boptMark(`${o.base}USDT`, raw, (r) => {
      const q = boptQuoteFrom(r);
      onQuote(q);
      pushPrice(raw, q.mark);
    });
  },
  streamInfo(raw, onInfo) {
    return bopt.streamQuote(raw, onInfo);
  },
  symbols() {
    boptSymbols ??= getJSONFrom(`${EAPI}/exchangeInfo`).then((info) => info.optionSymbols
      .filter((s) => s.status === 'TRADING' && s.contractType === 'CRYPTO_OPTIONS')
      .map((s) => ({
        symbol: s.symbol, base: s.underlying.replace('USDT', ''), quote: 'USDT', type: 'option', provider: 'bopt',
        underlying: s.underlying, strike: Number(s.strikePrice), side: s.side === 'CALL' ? 'C' : 'P', expiry: s.expiryDate,
        tick: Number(s.filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize ?? 0.1),
      })))
      .catch((e) => { boptSymbols = undefined; throw e; });
    return boptSymbols;
  },
  subscribeChain: (underlying, fn) => boptMark(underlying, '*', fn),
  markSnapshot: () => getJSONFrom(`${EAPI}/mark`),
  tickerSnapshot: () => getJSONFrom(`${EAPI}/ticker`),
};

// ---------------------------------------------------------------- Deribit (JSON-RPC WebSocket)
class DeribitHub {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.open = false;
    this.id = 1;
    this.backoff = 1000;
  }

  connect() {
    if (this.ws) return;
    const ws = new WebSocket('wss://www.deribit.com/ws/api/v2');
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.backoff = 1000;
      this.rpc('public/set_heartbeat', { interval: 30 });
      if (this.handlers.size) this.rpc('public/subscribe', { channels: [...this.handlers.keys()] });
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.method === 'heartbeat' && m.params?.type === 'test_request') this.rpc('public/test', {});
      if (m.method === 'subscription') this.handlers.get(m.params.channel)?.forEach((fn) => fn(m.params.data));
    };
    ws.onclose = () => {
      this.ws = null;
      this.open = false;
      if (!this.handlers.size) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    ws.onerror = () => ws.close();
  }

  rpc(method, params) {
    if (this.open) this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }));
  }

  subscribe(channel, fn) {
    this.connect();
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      this.rpc('public/subscribe', { channels: [channel] });
    }
    this.handlers.get(channel).add(fn);
    return () => {
      const set = this.handlers.get(channel);
      set?.delete(fn);
      if (set && !set.size) {
        this.handlers.delete(channel);
        this.rpc('public/unsubscribe', { channels: [channel] });
      }
    };
  }
}
export const deribitHub = new DeribitHub();

// Native Deribit resolutions; other intervals are aggregated from the nearest smaller one.
const DERIBIT_RES = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '6h': '360', '12h': '720', '1d': '1D' };
const DERIBIT_BASE = { '4h': '2h', '8h': '2h', '3d': '1d', '1w': '1d', '1M': '1d' };
let deribitSymbols;

const deribit = {
  id: 'deribit',
  supports: () => true,
  async fetchKlines(raw, interval, { limit = 1000, endTime } = {}) {
    const baseIv = DERIBIT_RES[interval] ? interval : DERIBIT_BASE[interval] ?? '1d';
    const ratio = Math.max(1, Math.round(intervalSec(interval) / intervalSec(baseIv)));
    const end = endTime ?? Date.now();
    const start = end - Math.min(5000, limit * ratio) * intervalSec(baseIv) * 1000;
    const res = await getJSONFrom(`${DERIBIT}/get_tradingview_chart_data?instrument_name=${raw}&start_timestamp=${start}&end_timestamp=${end}&resolution=${DERIBIT_RES[baseIv]}`);
    const r = res.result;
    if (!r?.ticks?.length) return [];
    const bars = r.ticks.map((t, i) => ({ time: Math.floor(t / 1000), open: r.open[i], high: r.high[i], low: r.low[i], close: r.close[i], volume: r.volume[i], quoteVolume: r.cost?.[i] ?? 0 }));
    return baseIv === interval ? bars : aggregate(bars, interval);
  },
  streamBars(raw, interval, onBar) {
    const baseIv = DERIBIT_RES[interval] ? interval : DERIBIT_BASE[interval] ?? '1d';
    const parts = new Map();
    return deribitHub.subscribe(`chart.trades.${raw}.${DERIBIT_RES[baseIv]}`, (d) => {
      const base = { time: Math.floor(d.tick / 1000), open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume };
      if (baseIv === interval) {
        onBar(base, Date.now());
        return;
      }
      // Rebuild the aggregated bar from its base bars so live updates stay exact.
      const bucket = bucketStart(base.time, interval);
      for (const k of parts.keys()) if (bucketStart(k, interval) !== bucket) parts.delete(k);
      parts.set(base.time, base);
      onBar(aggregate([...parts.values()].sort((a, b) => a.time - b.time), interval)[0], Date.now());
    });
  },
  streamTrades(raw, onTrade) {
    return deribitHub.subscribe(`trades.${raw}.100ms`, (list) => {
      for (const t of list) onTrade({ price: t.price, qty: t.amount, time: t.timestamp, buyerMaker: t.direction === 'sell' });
    });
  },
  streamQuote(raw, onQuote) {
    return deribitHub.subscribe(`ticker.${raw}.100ms`, (t) => {
      onQuote({
        bid: t.best_bid_price || t.mark_price, ask: t.best_ask_price || t.mark_price, mark: t.mark_price, index: t.index_price,
        underlying: t.underlying_price, iv: t.mark_iv !== undefined ? t.mark_iv / 100 : undefined,
        delta: t.greeks?.delta, gamma: t.greeks?.gamma, theta: t.greeks?.theta, vega: t.greeks?.vega,
        funding: t.current_funding, option: Boolean(t.greeks),
      });
      pushPrice(`DERIBIT:${raw}`, t.last_price ?? t.mark_price);
    });
  },
  streamInfo(raw, onInfo) {
    return deribit.streamQuote(raw, onInfo);
  },
  symbols() {
    deribitSymbols ??= Promise.all(['BTC', 'ETH'].map((cur) => getJSONFrom(`${DERIBIT}/get_instruments?currency=${cur}&expired=false`)))
      .then((lists) => lists.flatMap((l) => l.result).filter((i) => i.kind === 'option' || i.kind === 'future').map((i) => ({
        symbol: `DERIBIT:${i.instrument_name}`, base: i.base_currency, quote: i.counter_currency ?? i.quote_currency, provider: 'deribit',
        type: i.kind === 'option' ? 'option' : i.settlement_period === 'perpetual' ? 'perp' : 'future',
        tick: i.tick_size, strike: i.strike, side: i.option_type === 'call' ? 'C' : i.option_type === 'put' ? 'P' : undefined, expiry: i.expiration_timestamp,
      })))
      .catch((e) => { deribitSymbols = undefined; throw e; });
    return deribitSymbols;
  },
  // Whole option chain for a currency in one request (bid/ask/mark/IV/OI/underlying).
  chainSnapshot: (currency) => getJSONFrom(`${DERIBIT}/get_book_summary_by_currency?currency=${currency}&kind=option`).then((r) => r.result),
};

export const PROVIDERS = { spot, perp, bopt, deribit };
export const providerFor = (sym) => PROVIDERS[parseSymbol(sym).provider];

// USD value of one unit of price for paper trading: Deribit options are priced in the coin.
export function usdPerUnit(sym, quote) {
  if (parseSymbol(sym).provider === 'deribit' && parseOption(sym)) return quote?.index || quote?.underlying || 1;
  return 1;
}

// ---------------------------------------------------------------- Black–Scholes delta (Deribit chain)
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
export function bsDelta(side, spotPx, strike, years, vol) {
  if (!(spotPx > 0 && strike > 0 && years > 0 && vol > 0)) return NaN;
  const d1 = (Math.log(spotPx / strike) + ((vol * vol) / 2) * years) / (vol * Math.sqrt(years));
  return side === 'C' ? normCdf(d1) : normCdf(d1) - 1;
}

// ---------------------------------------------------------------- option mark-price candles
// Exchanges build option klines from trades only, and most contracts trade a few times a day, so
// those candles are flat dashes at scattered prices with gaps between them. Neither Binance nor
// Deribit publishes mark-price history. Mark candles here are:
//   • history: Black–Scholes value of the contract on each bar of the underlying's real candles
//     (open/high/low/close map through the price, since the value is monotonic in the underlying),
//     with the exchange's current mark IV and the time to expiry at that bar, scaled so the model
//     matches the exchange's actual mark price now; volume is the option's real traded volume;
//   • live: the exchange's real mark-price stream (Binance ~1s, Deribit 100ms).
// Deribit options are priced in the coin, so the model value is divided by the underlying price.
export function bsPrice(side, s, k, years, vol, rate = 0) {
  if (!(s > 0 && k > 0)) return NaN;
  if (!(years > 0 && vol > 0)) return Math.max(0, side === 'C' ? s - k : k - s);
  const sd = vol * Math.sqrt(years);
  const d1 = (Math.log(s / k) + rate * years + (sd * sd) / 2) / sd;
  const d2 = d1 - sd;
  const kd = k * Math.exp(-rate * years);
  return side === 'C' ? s * normCdf(d1) - kd * normCdf(d2) : kd * normCdf(-d2) - s * normCdf(-d1);
}

const YEAR_MS = 365 * 24 * 3600 * 1000;

async function optionSnapshot(sym) {
  const { provider, raw } = parseSymbol(sym);
  if (provider === 'bopt') {
    const [m] = await getJSONFrom(`${EAPI}/mark?symbol=${raw}`);
    return { mark: Number(m.markPrice), iv: Number(m.markIV), index: 0, rate: Number(m.riskFreeInterest ?? 0) };
  }
  const t = (await getJSONFrom(`${DERIBIT}/ticker?instrument_name=${raw}`)).result;
  return { mark: t.mark_price, iv: t.mark_iv / 100, index: t.underlying_price || t.index_price };
}

export function markProvider(sym) {
  const o = parseOption(sym);
  const { provider, raw } = parseSymbol(sym);
  const base = PROVIDERS[provider];
  const coin = provider === 'deribit';
  const under = `${o.base}USDT`;
  let snap = null;
  let scale = 1;
  let lastHist = null;
  const value = (s, timeMs, iv) => {
    const v = bsPrice(o.side, s, o.strike, (o.expiry - timeMs) / YEAR_MS, iv, snap?.rate ?? 0);
    return coin ? v / s : v;
  };
  const model = (bar, iv) => {
    const t = bar.time * 1000;
    const vals = [bar.open, bar.high, bar.low, bar.close].map((s) => value(s, t, iv) * scale);
    return { time: bar.time, open: vals[0], high: Math.max(...vals), low: Math.min(...vals), close: vals[3], volume: 0 };
  };
  return {
    id: `${provider}-mark`,
    mark: true,
    async fetchKlines(_raw, interval, opts = {}) {
      snap ??= await optionSnapshot(sym);
      const [underBars, tradeBars] = await Promise.all([
        PROVIDERS.spot.fetchKlines(under, interval, opts),
        base.fetchKlines(raw, interval, opts).catch(() => []),
      ]);
      // Anchor: the model at the latest underlying price must equal the exchange's mark now.
      const last = underBars.at(-1);
      if (last && opts.endTime === undefined) {
        const now = value(snap.index || last.close, Date.now(), snap.iv);
        const k = snap.mark > 0 && now > 0 ? snap.mark / now : 1;
        scale = k > 0.5 && k < 2 ? k : 1;
      }
      const vol = new Map(tradeBars.map((b) => [b.time, b.volume]));
      const bars = underBars.filter((b) => b.time * 1000 < o.expiry).map((b) => ({ ...model(b, snap.iv), volume: vol.get(b.time) ?? 0 }));
      if (opts.endTime === undefined) lastHist = bars.at(-1) ?? null;
      return bars;
    },
    // Live bar: the exchange's mark price, bucketed into the chart interval.
    streamBars(_raw, interval, onBar) {
      let bar = null;
      return base.streamQuote(raw, (q) => {
        if (!(q.mark > 0)) return;
        const t = bucketStart(Math.floor(Date.now() / 1000), interval);
        if (!bar || bar.time !== t) {
          // Continue the modelled bar the chart already shows, so the live bar does not jump.
          const seed = lastHist?.time === t ? lastHist : null;
          bar = seed ? { ...seed } : { time: t, open: bar?.close ?? lastHist?.close ?? q.mark, high: q.mark, low: q.mark, close: q.mark, volume: 0 };
        }
        bar.high = Math.max(bar.high, q.mark);
        bar.low = Math.min(bar.low, q.mark);
        bar.close = q.mark;
        onBar({ ...bar }, Date.now());
      });
    },
    streamQuote: base.streamQuote,
    streamInfo: base.streamInfo,
    symbols: base.symbols,
  };
}
