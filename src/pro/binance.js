// Binance public market data: REST for history and multiplexed WebSockets for live streams.
// Spot, USDⓈ-M futures and options each have their own stream connection.

const REST = 'https://api.binance.com/api/v3';
const SPOT_WS = 'wss://stream.binance.com:9443/stream';
// Binance serves futures klines/trades/tickers/mark price on /market and book tickers on /public.
const FUTURES_WS = 'wss://fstream.binance.com/market/stream';
const FUTURES_BOOK_WS = 'wss://fstream.binance.com/public/stream';
// Options data (all contracts' mark price, bid/ask, IV and greeks) is served on the futures "market" path.
const OPTIONS_WS = 'wss://fstream.binance.com/market/stream';

export async function getJSONFrom(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.msg || body.message || '';
    } catch {
      // Non-JSON error body.
    }
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response.json();
}
const getJSON = (path) => getJSONFrom(`${REST}${path}`);

export function parseKline(row) {
  return {
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    quoteVolume: Number(row[7]),
    trades: Number(row[8]),
    takerBuy: Number(row[9]),
  };
}

// Spot klines (kept for existing callers); providers.js routes other markets.
export async function fetchKlines(symbol, interval, { limit = 1000, endTime } = {}) {
  const end = endTime ? `&endTime=${endTime}` : '';
  const rows = await getJSON(`/klines?symbol=${symbol}&interval=${interval}&limit=${limit}${end}`);
  return rows.map(parseKline);
}

export const fetchTicker = (symbol) => getJSON(`/ticker/24hr?symbol=${symbol}`);
export const fetchDepth = (symbol, limit = 50) => getJSON(`/depth?symbol=${symbol}&limit=${limit}`);
export const fetchTrades = (symbol, limit = 60) => getJSON(`/aggTrades?symbol=${symbol}&limit=${limit}`);

let symbolsPromise;
// Every trading spot pair, with base/quote assets and tick size.
export function fetchSymbols() {
  symbolsPromise ??= getJSON('/exchangeInfo?permissions=SPOT&symbolStatus=TRADING')
    .then((info) => info.symbols.map((s) => {
      const priceFilter = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      return {
        symbol: s.symbol,
        base: s.baseAsset,
        quote: s.quoteAsset,
        tick: priceFilter ? Number(priceFilter.tickSize) : 0.01,
        type: 'spot',
        provider: 'spot',
      };
    }))
    .catch((error) => {
      symbolsPromise = undefined;
      throw error;
    });
  return symbolsPromise;
}

// Decimal places implied by a tick size (0.5 → 1, 0.01 → 2, 5 → 0).
export function tickDigits(tick) {
  if (!tick) return 2;
  if (tick >= 1) return 2;
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(tick) - 1e-9)));
}

// Reference-counted multiplexed stream. subscribe() returns an unsubscribe function.
export class StreamHub {
  constructor(url, name) {
    this.url = url;
    this.name = name;
    this.handlers = new Map();
    this.ws = null;
    this.open = false;
    this.backoff = 1000;
    this.reqId = 1;
    this.pending = new Set();
    this.status = 'idle';
    this.statusListeners = new Set();
  }

  onStatus(fn) {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  setStatus(status) {
    this.status = status;
    this.statusListeners.forEach((fn) => fn(status));
  }

  connect() {
    if (this.ws) return;
    this.setStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.backoff = 1000;
      this.setStatus('live');
      const names = [...this.handlers.keys()];
      if (names.length) this.send('SUBSCRIBE', names);
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg.stream) return;
      this.handlers.get(msg.stream)?.forEach((fn) => fn(msg.data));
    };
    ws.onclose = () => {
      this.ws = null;
      this.open = false;
      if (!this.handlers.size) {
        this.setStatus('idle');
        return;
      }
      this.setStatus('reconnecting');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    ws.onerror = () => ws.close();
  }

  send(method, params) {
    if (!this.open || !params.length) return;
    for (let i = 0; i < params.length; i += 200) {
      this.ws.send(JSON.stringify({ method, params: params.slice(i, i + 200), id: this.reqId++ }));
    }
  }

  subscribe(stream, fn) {
    this.connect();
    let set = this.handlers.get(stream);
    if (!set) {
      set = new Set();
      this.handlers.set(stream, set);
      this.queue('SUBSCRIBE', stream);
    }
    set.add(fn);
    return () => {
      const current = this.handlers.get(stream);
      if (!current) return;
      current.delete(fn);
      if (current.size === 0) {
        this.handlers.delete(stream);
        this.queue('UNSUBSCRIBE', stream);
      }
    };
  }

  // Batch subscribe/unsubscribe calls made in the same tick into one message each.
  queue(method, stream) {
    this.pending.add(`${method}|${stream}`);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const subs = [];
      const unsubs = [];
      for (const entry of this.pending) {
        const [m, s] = entry.split('|');
        const wanted = this.handlers.has(s);
        if (m === 'SUBSCRIBE' && wanted) subs.push(s);
        if (m === 'UNSUBSCRIBE' && !wanted) unsubs.push(s);
      }
      this.pending.clear();
      this.send('UNSUBSCRIBE', unsubs);
      this.send('SUBSCRIBE', subs);
    }, 30);
  }
}

export const hub = new StreamHub(SPOT_WS, 'spot');
export const futuresHub = new StreamHub(FUTURES_WS, 'futures');
export const futuresBookHub = new StreamHub(FUTURES_BOOK_WS, 'futures-book');
export const optionsHub = new StreamHub(OPTIONS_WS, 'options');

// Live last-price cache shared by watchlist, alerts and paper trading.
// Spot and perpetuals come from the all-market mini tickers; options/Deribit push via pushPrice.
export const tickers = new Map();
const tickerListeners = new Set();
export function onTickers(fn) {
  tickerListeners.add(fn);
  return () => tickerListeners.delete(fn);
}

function toTicker(symbol, last, open, high, low, volume, quoteVolume) {
  return { symbol, last, open, high, low, volume, quoteVolume };
}

function ingestMini(rows, suffix) {
  const changed = [];
  for (const r of rows) {
    const t = toTicker(r.s + suffix, Number(r.c), Number(r.o), Number(r.h), Number(r.l), Number(r.v), Number(r.q));
    const prev = tickers.get(t.symbol);
    // Keep a fresher trade-level price if one arrived after this 1s snapshot.
    if (prev?.liveAt && Date.now() - prev.liveAt < 1500) t.last = prev.last;
    tickers.set(t.symbol, { ...prev, ...t });
    changed.push(t);
  }
  tickerListeners.forEach((fn) => fn(changed));
}

export function startTickerFeed() {
  getJSON('/ticker/24hr?type=MINI').then((rows) => {
    for (const r of rows) {
      if (tickers.has(r.symbol)) continue;
      tickers.set(r.symbol, toTicker(r.symbol, Number(r.lastPrice), Number(r.openPrice), Number(r.highPrice), Number(r.lowPrice), Number(r.volume), Number(r.quoteVolume)));
    }
    tickerListeners.forEach((fn) => fn(null));
  }).catch((error) => console.warn('Ticker snapshot failed', error));
  getJSONFrom('https://fapi.binance.com/fapi/v1/ticker/24hr').then((rows) => {
    for (const r of rows) {
      const sym = `${r.symbol}.P`;
      if (tickers.has(sym)) continue;
      tickers.set(sym, toTicker(sym, Number(r.lastPrice), Number(r.openPrice), Number(r.highPrice), Number(r.lowPrice), Number(r.volume), Number(r.quoteVolume)));
    }
    tickerListeners.forEach((fn) => fn(null));
  }).catch((error) => console.warn('Futures ticker snapshot failed', error));
  hub.subscribe('!miniTicker@arr', (rows) => ingestMini(rows, ''));
  futuresHub.subscribe('!miniTicker@arr', (rows) => ingestMini(rows, '.P'));
}

// Trade-level price push (charts, option quotes). Creates the entry for symbols with no 24h feed.
export function pushPrice(symbol, price) {
  if (!Number.isFinite(price)) return;
  let t = tickers.get(symbol);
  if (!t) {
    t = toTicker(symbol, price, price, price, price, 0, 0);
    tickers.set(symbol, t);
  } else if (t.last === price) {
    t.liveAt = Date.now();
    return;
  }
  t.last = price;
  t.liveAt = Date.now();
  tickerListeners.forEach((fn) => fn([t]));
}
