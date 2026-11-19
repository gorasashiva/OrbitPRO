// Non-visual services: price alerts, paper-trading broker, and the strategy backtester.

import { onTickers, tickers } from './binance.js';
import { parseSymbol, providerFor, usdPerUnit } from './providers.js';
import { atr, ema, rsi, sma, stdev, supertrend } from './indicators.js';
import { beep, Emitter, formatPrice, store, toast, uid } from './util.js';

// ---------------- Alerts ----------------
export const ALERT_CONDITIONS = [
  { id: 'crossing', label: 'Crossing' },
  { id: 'crossing_up', label: 'Crossing up' },
  { id: 'crossing_down', label: 'Crossing down' },
  { id: 'greater', label: 'Greater than' },
  { id: 'less', label: 'Less than' },
];

export class AlertManager extends Emitter {
  constructor() {
    super();
    this.alerts = store.get('alerts', []);
    this.log = store.get('alertLog', []);
    this.lastPrice = new Map();
    onTickers((changed) => this.evaluate(changed));
  }

  save() {
    store.set('alerts', this.alerts);
    store.set('alertLog', this.log.slice(0, 200));
    this.emit('change', this.alerts);
  }

  add(alert) {
    const item = { id: uid(), condition: 'crossing', message: '', once: true, active: true, created: Date.now(), ...alert };
    this.alerts.unshift(item);
    this.lastPrice.delete(item.symbol);
    this.save();
    const cond = ALERT_CONDITIONS.find((c) => c.id === item.condition)?.label.toLowerCase();
    toast(`Alert set: ${item.symbol} ${cond} ${formatPrice(item.price)}`, 'success');
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    return item;
  }

  update(id, patch) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return;
    Object.assign(a, patch);
    this.lastPrice.delete(a.symbol);
    this.save();
  }

  remove(id) {
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.save();
  }

  clearLog() {
    this.log = [];
    this.save();
  }

  evaluate(changed) {
    const active = this.alerts.filter((a) => a.active);
    if (!active.length) return;
    const symbols = new Set(active.map((a) => a.symbol));
    for (const t of changed ?? [...tickers.values()]) {
      if (!symbols.has(t.symbol)) continue;
      const prev = this.lastPrice.get(t.symbol);
      const price = t.last;
      this.lastPrice.set(t.symbol, price);
      for (const a of active) {
        if (a.symbol !== t.symbol || !a.active) continue;
        let hit;
        switch (a.condition) {
          case 'greater': hit = price > a.price; break;
          case 'less': hit = price < a.price; break;
          case 'crossing_up': hit = prev !== undefined && prev < a.price && price >= a.price; break;
          case 'crossing_down': hit = prev !== undefined && prev > a.price && price <= a.price; break;
          default: hit = prev !== undefined && ((prev < a.price && price >= a.price) || (prev > a.price && price <= a.price));
        }
        if (hit) this.fire(a, price);
      }
    }
  }

  fire(a, price) {
    const cond = ALERT_CONDITIONS.find((c) => c.id === a.condition)?.label ?? a.condition;
    const text = a.message || `${a.symbol} ${cond.toLowerCase()} ${formatPrice(a.price)}`;
    this.log.unshift({ id: uid(), alertId: a.id, symbol: a.symbol, price, time: Date.now(), message: text });
    // Non-repeating alerts deactivate; repeating "greater/less" alerts would fire every tick,
    // so they re-arm only after a 60s cool-down.
    if (a.once) a.active = false;
    else if (a.condition === 'greater' || a.condition === 'less') {
      a.active = false;
      setTimeout(() => { if (this.alerts.includes(a)) { a.active = true; this.save(); } }, 60_000);
    }
    this.save();
    toast(`⏰ ${text} (last ${formatPrice(price)})`, 'alert', 8000);
    if (this.soundEnabled !== false) {
      beep(988, 0.15);
      setTimeout(() => beep(1318, 0.2), 170);
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Orbit alert', { body: text }); } catch { /* notifications are optional */ }
    }
  }
}

// ---------------- Paper trading ----------------
// Models TradingView paper trading: one netted position per symbol, isolated margin with
// leverage, buying-power checks, market fills at bid/ask, stop-losses fill at market (slippage),
// take-profits fill at their limit, and liquidation before the margin is exhausted — so the
// balance can never go negative. Data persists to data/paper/ via the dev server (with a
// localStorage fallback) and every closed trade is appended to data/paper/trades.csv.
export const PAPER_FEE = 0.001;
const START_BALANCE = 100_000;
const MAINT_MARGIN = 0.005;
const EPS = 1e-12;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export class PaperBroker extends Emitter {
  constructor() {
    super();
    // ?sandbox: a throwaway account in this browser only (never touches data/paper/).
    this.sandbox = new URLSearchParams(location.search).has('sandbox');
    this.storeKey = this.sandbox ? 'paper.sandbox' : 'paper';
    this.state = this.sanitize(store.get(this.storeKey, null));
    this.pendingTrades = [];
    this.isLeader = false;
    this.quotes = new Map();
    this.quoteSubs = new Map();
    this.watchSymbols = new Set();
    this.serverOk = null;
    this.saveTimer = null;
    onTickers((changed) => this.onPrices(changed));
    this.setupTabs();
    if (this.sandbox) {
      this.serverOk = false;
      setTimeout(() => toast('Sandbox paper account: trades stay in this browser only.', 'info', 5000), 1000);
    } else {
      this.loadFromDisk();
    }
  }

  // Several tabs can share one account: only the tab holding the lock runs the matching engine
  // (fills, TP/SL, liquidation); every tab mirrors state changes over a BroadcastChannel.
  setupTabs() {
    try {
      this.channel = new BroadcastChannel(`orbit-${this.storeKey}`);
      this.channel.onmessage = (event) => {
        if (event.data?.type !== 'state') return;
        this.state = this.sanitize(event.data.state);
        this.syncQuotes();
        this.emit('change', this.state);
      };
    } catch {
      this.channel = null;
    }
    if (navigator.locks?.request) {
      navigator.locks.request(`orbit-${this.storeKey}-engine`, () => {
        this.isLeader = true;
        return new Promise(() => {});
      }).catch(() => { this.isLeader = true; });
    } else {
      this.isLeader = true;
    }
  }

  adopt(raw) {
    this.state = this.sanitize(raw);
    store.set(this.storeKey, this.state);
    this.syncQuotes();
    this.emit('change', this.state);
  }

  // ----- persistence
  sanitize(raw) {
    const fresh = { version: 2, rev: 0, balance: START_BALANCE, leverage: 1, positions: [], orders: [], history: [], createdAt: Date.now() };
    if (!raw || typeof raw !== 'object') return fresh;
    const s = { ...fresh, ...raw, version: 2 };
    if (!finite(s.balance)) s.balance = START_BALANCE;
    // Accounts from the first version had no margin checks and could go negative: start those
    // over (closed-trade history is kept) and say why.
    if (raw.version !== 2 && s.balance < 0) {
      s.balance = START_BALANCE;
      s.positions = [];
      s.orders = [];
      setTimeout(() => toast('Your old paper account had a negative balance (a bug in the previous version without margin checks). It was reset to 100,000 USDT; closed trades are kept.', 'info', 10000), 1500);
    }
    s.leverage = Math.min(125, Math.max(1, Math.round(s.leverage || 1)));
    s.positions = (s.positions ?? []).filter((p) => finite(p.entry) && finite(p.qty) && p.qty > 0).map((p) => ({
      leverage: s.leverage, margin: (p.entry * p.qty) / (p.leverage || s.leverage), fees: 0, mfe: 0, mae: 0, ...p,
    }));
    s.orders = (s.orders ?? []).filter((o) => finite(o.price) && finite(o.qty) && o.qty > 0);
    s.history = (s.history ?? []).filter((t) => finite(t.pnl) && finite(t.exit));
    return s;
  }

  async loadFromDisk() {
    try {
      const res = await fetch('/api/paper');
      if (res.status === 404) {
        this.serverOk = true;
        this.persist();
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      this.serverOk = true;
      this.adopt(await res.json());
    } catch {
      this.serverOk = false;
    }
  }

  persist() {
    store.set(this.storeKey, this.state);
    this.channel?.postMessage({ type: 'state', state: this.state });
    if (this.serverOk === false) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fetch('/api/paper', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...this.state, baseRev: this.state.rev }) })
        .then(async (r) => {
          if (r.status === 409) {
            // Another tab/browser saved first: take its account and drop our unsaved trade rows.
            this.pendingTrades = [];
            this.adopt(await r.json());
            toast('Paper account was updated elsewhere; reloaded the latest version.', 'info', 4000);
            return;
          }
          if (!r.ok) throw new Error(String(r.status));
          const { rev } = await r.json();
          this.state.rev = rev;
          store.set(this.storeKey, this.state);
          this.serverOk = true;
          this.flushTrades();
        })
        .catch(() => {
          if (this.serverOk !== false) toast('Paper account saved in this browser only (file storage needs `npm run chart`).', 'info', 6000);
          this.serverOk = false;
        });
    }, 300);
  }

  // Closed trades are written to trades.csv only after the account save that contains them succeeds.
  appendTrades(records) {
    if (this.serverOk === false || !records.length) return;
    this.pendingTrades.push(...records);
  }

  flushTrades() {
    if (!this.pendingTrades.length) return;
    const batch = this.pendingTrades;
    this.pendingTrades = [];
    fetch('/api/paper/trades', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) })
      .catch(() => { this.pendingTrades.unshift(...batch); });
  }

  save() {
    this.persist();
    this.syncQuotes();
    this.emit('change', this.state);
  }

  // ----- prices: last trade plus best bid/ask (book ticker) for every symbol we trade or show
  syncQuotes() {
    const wanted = new Set([...this.state.positions.map((p) => p.symbol), ...this.state.orders.map((o) => o.symbol), ...this.watchSymbols]);
    for (const sym of wanted) {
      if (this.quoteSubs.has(sym)) continue;
      // Each market's own bid/ask feed (spot/perp book ticker, option mark streams, Deribit ticker).
      this.quoteSubs.set(sym, providerFor(sym).streamQuote(parseSymbol(sym).raw, (q) => {
        this.quotes.set(sym, q);
        this.checkSymbol(sym);
        this.emit('quote', sym);
      }));
    }
    for (const [sym, unsub] of this.quoteSubs) {
      if (wanted.has(sym)) continue;
      unsub();
      this.quoteSubs.delete(sym);
      this.quotes.delete(sym);
    }
  }

  watch(symbols) {
    this.watchSymbols = new Set(symbols);
    this.syncQuotes();
  }

  price(symbol) {
    const q = this.quotes.get(symbol);
    return tickers.get(symbol)?.last ?? q?.mark ?? (q ? (q.bid + q.ask) / 2 : undefined);
  }

  // USD per unit of quoted price (Deribit options are quoted in BTC/ETH).
  mult(symbol) { return usdPerUnit(symbol, this.quotes.get(symbol)); }

  quote(symbol) {
    const last = this.price(symbol);
    const q = this.quotes.get(symbol);
    return { bid: q?.bid ?? last, ask: q?.ask ?? last, last };
  }

  // Price you would get trading now: buys pay the ask, sells hit the bid.
  fillPrice(symbol, side) {
    const q = this.quote(symbol);
    return side === 'buy' ? q.ask : q.bid;
  }

  // ----- account maths
  unrealized(p) {
    const q = this.quote(p.symbol);
    const mark = p.side === 'buy' ? q.bid : q.ask;
    if (!finite(mark)) return 0;
    return (p.side === 'buy' ? mark - p.entry : p.entry - mark) * p.qty * this.mult(p.symbol);
  }

  equity() { return this.state.balance + this.state.positions.reduce((s, p) => s + this.unrealized(p), 0); }

  usedMargin() { return this.state.positions.reduce((s, p) => s + p.margin, 0); }

  reservedMargin() {
    return this.state.orders.reduce((s, o) => s + (o.price * o.qty) / (o.leverage || this.state.leverage) + o.price * o.qty * PAPER_FEE, 0);
  }

  available() { return Math.max(0, this.equity() - this.usedMargin() - this.reservedMargin()); }

  liqPrice(p) {
    const lev = p.leverage || 1;
    return p.side === 'buy' ? p.entry * (1 - 1 / lev + MAINT_MARGIN) : p.entry * (1 + 1 / lev - MAINT_MARGIN);
  }

  setLeverage(n) {
    this.state.leverage = Math.min(125, Math.max(1, Math.round(n) || 1));
    this.save();
    return this.state.leverage;
  }

  // ----- validation: returns an error message, or null when the order is acceptable
  validate({ symbol, side, type, qty, price, tp, sl }, { skipMargin = false } = {}) {
    if (!symbol) return 'Choose a symbol';
    if (!(finite(qty) && qty > 0)) return 'Quantity must be greater than zero';
    const ref = type === 'market' ? this.fillPrice(symbol, side) : price;
    if (!(finite(ref) && ref > 0)) return type === 'market' ? `No live price for ${symbol} yet` : 'Enter a valid order price';
    const long = side === 'buy';
    if (finite(tp) && tp > 0 && (long ? tp <= ref : tp >= ref)) return `Take profit must be ${long ? 'above' : 'below'} the entry (${formatPrice(ref)}) for a ${long ? 'long' : 'short'}`;
    if (finite(sl) && sl > 0 && (long ? sl >= ref : sl <= ref)) return `Stop loss must be ${long ? 'below' : 'above'} the entry (${formatPrice(ref)}) for a ${long ? 'long' : 'short'}`;
    if (skipMargin) return null;
    // Only the part that opens or adds exposure needs margin; reducing an opposite position frees it.
    const pos = this.state.positions.find((p) => p.symbol === symbol);
    const opposite = pos && pos.side !== side;
    const opening = opposite ? Math.max(0, qty - pos.qty) : qty;
    const notional = ref * opening * this.mult(symbol);
    const need = notional / this.state.leverage + notional * PAPER_FEE;
    const freed = opposite ? pos.margin * (Math.min(qty, pos.qty) / pos.qty) : 0;
    const avail = this.available() + freed;
    if (need > avail + EPS) {
      return `Insufficient buying power: needs ${formatPrice(need, 2)} USDT (margin + fee), available ${formatPrice(avail, 2)} USDT at ${this.state.leverage}x`;
    }
    return null;
  }

  maxQty(symbol, side, price) {
    const px = price || this.fillPrice(symbol, side);
    if (!(px > 0)) return 0;
    return this.available() / (px * this.mult(symbol) * (1 / this.state.leverage + PAPER_FEE));
  }

  // ----- orders
  placeOrder(order) {
    const o = { ...order, qty: Number(order.qty), price: Number(order.price), tp: Number(order.tp) || null, sl: Number(order.sl) || null };
    const err = this.validate(o);
    if (err) {
      toast(err, 'error', 6000);
      return false;
    }
    if (o.type === 'market') {
      this.execute(o.symbol, o.side, o.qty, this.fillPrice(o.symbol, o.side), { tp: o.tp, sl: o.sl, reason: 'Market' });
      return true;
    }
    this.state.orders.unshift({ id: uid(), symbol: o.symbol, side: o.side, type: o.type, qty: o.qty, price: o.price, tp: o.tp, sl: o.sl, leverage: this.state.leverage, created: Date.now() });
    toast(`${o.side.toUpperCase()} ${o.type} ${o.qty} ${o.symbol} @ ${formatPrice(o.price)} placed`, 'success');
    this.save();
    return true;
  }

  modifyOrder(id, patch) {
    const o = this.state.orders.find((x) => x.id === id);
    if (!o) return false;
    const err = this.validate({ ...o, ...patch }, { skipMargin: true });
    if (err) {
      toast(err, 'error');
      return false;
    }
    Object.assign(o, patch);
    this.save();
    return true;
  }

  cancel(id) {
    this.state.orders = this.state.orders.filter((o) => o.id !== id);
    this.save();
  }

  // Netting: same side adds (average entry), opposite side reduces, closes or reverses.
  execute(symbol, side, qty, px, { tp, sl, reason }) {
    let remaining = qty;
    const pos = this.state.positions.find((p) => p.symbol === symbol);
    if (pos && pos.side !== side) {
      const closeQty = Math.min(remaining, pos.qty);
      this.closePartial(pos, closeQty, px, remaining > pos.qty + EPS ? 'Reversed' : reason === 'Market' ? 'Closed by order' : reason);
      remaining -= closeQty;
    }
    if (remaining > EPS) {
      const m = this.mult(symbol);
      const fee = px * remaining * m * PAPER_FEE;
      const lev = this.state.leverage;
      const same = this.state.positions.find((p) => p.symbol === symbol && p.side === side);
      this.state.balance -= fee;
      if (same) {
        const total = same.qty + remaining;
        same.entry = (same.entry * same.qty + px * remaining) / total;
        same.qty = +total.toFixed(10);
        same.margin += (px * remaining * m) / lev;
        same.fees += fee;
        if (tp) same.tp = tp;
        if (sl) same.sl = sl;
      } else {
        this.state.positions.unshift({
          id: uid(), symbol, side, qty: remaining, entry: px, tp: tp || null, sl: sl || null, opened: Date.now(),
          fees: fee, leverage: lev, margin: (px * remaining * m) / lev, mfe: 0, mae: 0,
        });
      }
      this.emit('fill', { symbol, side, qty: remaining, price: px, time: Date.now() });
      toast(`${side === 'buy' ? 'Bought' : 'Sold'} ${+remaining.toFixed(8)} ${symbol} @ ${formatPrice(px)}`, 'success');
    }
    this.save();
  }

  closePartial(p, q, exit, reason) {
    const dir = p.side === 'buy' ? 1 : -1;
    const share = q / p.qty;
    const entryFee = p.fees * share;
    const m = this.mult(p.symbol);
    const exitFee = exit * q * m * PAPER_FEE;
    const gross = (exit - p.entry) * q * dir * m;
    const margin = p.margin * share;
    const pnl = gross - entryFee - exitFee;
    // The entry fee was charged at open; settle the gross result minus the exit fee now.
    this.state.balance += gross - exitFee;
    const record = {
      id: uid(), positionId: p.id, symbol: p.symbol, side: p.side, qty: +q.toFixed(10), leverage: p.leverage,
      entry: p.entry, exit, tp: p.tp, sl: p.sl, opened: p.opened, closed: Date.now(),
      gross, fees: entryFee + exitFee, pnl, returnPct: margin ? (pnl / margin) * 100 : 0, margin,
      runUp: (p.mfe ?? 0) * q, drawdown: (p.mae ?? 0) * q, reason,
    };
    this.state.history.unshift(record);
    this.state.history = this.state.history.slice(0, 2000);
    this.appendTrades([record]);
    p.qty = +(p.qty - q).toFixed(10);
    p.fees -= entryFee;
    p.margin -= margin;
    if (p.qty <= EPS) this.state.positions = this.state.positions.filter((x) => x !== p);
    this.emit('fill', { symbol: p.symbol, side: p.side === 'buy' ? 'sell' : 'buy', qty: q, price: exit, time: record.closed, exit: true, pnl });
    toast(`Closed ${+q.toFixed(8)} ${p.symbol} ${p.side === 'buy' ? 'long' : 'short'} @ ${formatPrice(exit)} (${reason}): ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`, pnl >= 0 ? 'success' : 'error', 6000);
    return record;
  }

  close(id, reason = 'Manual', at) {
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) return;
    const exit = finite(at) ? at : this.fillPrice(p.symbol, p.side === 'buy' ? 'sell' : 'buy');
    if (!finite(exit)) {
      toast(`No live price for ${p.symbol} yet`, 'error');
      return;
    }
    this.closePartial(p, p.qty, exit, reason);
    this.save();
  }

  closeAll() {
    for (const p of [...this.state.positions]) this.close(p.id, 'Close all');
  }

  updatePosition(id, patch) {
    const p = this.state.positions.find((x) => x.id === id);
    if (!p) return false;
    const long = p.side === 'buy';
    const mark = this.quote(p.symbol).last ?? p.entry;
    if (finite(patch.tp) && patch.tp > 0 && (long ? patch.tp <= mark : patch.tp >= mark)) {
      toast(`Take profit must be ${long ? 'above' : 'below'} the current price (${formatPrice(mark)})`, 'error');
      return false;
    }
    if (finite(patch.sl) && patch.sl > 0 && (long ? patch.sl >= mark : patch.sl <= mark)) {
      toast(`Stop loss must be ${long ? 'below' : 'above'} the current price (${formatPrice(mark)})`, 'error');
      return false;
    }
    Object.assign(p, patch);
    this.save();
    return true;
  }

  reset(balance = START_BALANCE) {
    this.state = this.sanitize({ balance, leverage: this.state.leverage, createdAt: Date.now(), rev: this.state.rev });
    this.save();
  }

  // ----- matching engine (runs on every last-trade and book-ticker update)
  onPrices(changed) {
    if (!this.state.positions.length && !this.state.orders.length) return;
    const symbols = new Set([...this.state.positions.map((p) => p.symbol), ...this.state.orders.map((o) => o.symbol)]);
    for (const t of changed ?? [...tickers.values()]) if (symbols.has(t.symbol)) this.checkSymbol(t.symbol);
    this.emit('tick', this.state);
  }

  checkSymbol(symbol) {
    if (!this.isLeader) return;
    const { bid, ask } = this.quote(symbol);
    if (!finite(bid) || !finite(ask)) return;
    let dirty = false;
    for (const o of [...this.state.orders]) {
      if (o.symbol !== symbol) continue;
      let fill = null;
      if (o.type === 'limit') {
        if (o.side === 'buy' && ask <= o.price) fill = Math.min(o.price, ask);
        if (o.side === 'sell' && bid >= o.price) fill = Math.max(o.price, bid);
      } else {
        if (o.side === 'buy' && ask >= o.price) fill = ask;
        if (o.side === 'sell' && bid <= o.price) fill = bid;
      }
      if (fill === null) continue;
      this.state.orders = this.state.orders.filter((x) => x !== o);
      const err = this.validate({ ...o, type: 'market', tp: null, sl: null });
      if (err) toast(`${o.side.toUpperCase()} ${o.type} ${o.symbol} cancelled: ${err}`, 'error', 6000);
      else this.execute(o.symbol, o.side, o.qty, fill, { tp: o.tp, sl: o.sl, reason: `${o.type === 'limit' ? 'Limit' : 'Stop'} fill` });
      dirty = true;
    }
    for (const p of [...this.state.positions]) {
      if (p.symbol !== symbol) continue;
      const long = p.side === 'buy';
      const mark = long ? bid : ask;
      const move = (mark - p.entry) * (long ? 1 : -1);
      p.mfe = Math.max(p.mfe ?? 0, move);
      p.mae = Math.min(p.mae ?? 0, move);
      const liq = this.liqPrice(p);
      if (long ? mark <= liq : mark >= liq) {
        this.closePartial(p, p.qty, liq, 'Liquidation');
        dirty = true;
      } else if (p.sl && (long ? mark <= p.sl : mark >= p.sl)) {
        // Stop-loss is a stop-market order: it fills at the current bid/ask, including slippage.
        this.closePartial(p, p.qty, mark, 'Stop loss');
        dirty = true;
      } else if (p.tp && (long ? mark >= p.tp : mark <= p.tp)) {
        // Take-profit is a limit order: it fills at its price.
        this.closePartial(p, p.qty, p.tp, 'Take profit');
        dirty = true;
      }
    }
    if (dirty) this.save();
  }

  // Summary over closed trades.
  stats() {
    const hist = this.state.history;
    const wins = hist.filter((t) => t.pnl > 0);
    const losses = hist.filter((t) => t.pnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    return {
      trades: hist.length,
      winRate: hist.length ? (wins.length / hist.length) * 100 : 0,
      realized: hist.reduce((s, t) => s + t.pnl, 0),
      fees: hist.reduce((s, t) => s + t.fees, 0),
      profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? Infinity : 0,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
    };
  }

  exportCsv() {
    const head = ['Closed', 'Symbol', 'Side', 'Qty', 'Leverage', 'Entry time', 'Entry', 'Exit', 'Reason', 'Gross P&L', 'Fees', 'Net P&L', 'Return % (margin)', 'Run-up', 'Drawdown', 'Duration (min)'];
    const rows = this.state.history.map((t) => [
      new Date(t.closed).toISOString(), t.symbol, t.side === 'buy' ? 'Long' : 'Short', t.qty, t.leverage, new Date(t.opened).toISOString(), t.entry, t.exit, t.reason,
      t.gross.toFixed(4), t.fees.toFixed(4), t.pnl.toFixed(4), t.returnPct.toFixed(3), (t.runUp ?? 0).toFixed(4), (t.drawdown ?? 0).toFixed(4), ((t.closed - t.opened) / 60000).toFixed(1),
    ]);
    return [head, ...rows].map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
  }
}

// ---------------- Backtester ----------------
export const STRATEGIES = [
  {
    id: 'ma_cross',
    name: 'EMA crossover',
    inputs: { fast: 9, slow: 21 },
    signals(c, p) {
      const close = c.map((b) => b.close);
      const f = ema(close, p.fast);
      const s = ema(close, p.slow);
      return c.map((_, i) => (i === 0 ? 0 : f[i - 1] <= s[i - 1] && f[i] > s[i] ? 1 : f[i - 1] >= s[i - 1] && f[i] < s[i] ? -1 : 0));
    },
  },
  {
    id: 'rsi',
    name: 'RSI reversal',
    inputs: { length: 14, oversold: 30, overbought: 70 },
    signals(c, p) {
      const r = rsi(c.map((b) => b.close), p.length);
      return c.map((_, i) => (i === 0 ? 0 : r[i - 1] < p.oversold && r[i] >= p.oversold ? 1 : r[i - 1] > p.overbought && r[i] <= p.overbought ? -1 : 0));
    },
  },
  {
    id: 'supertrend',
    name: 'Supertrend flip',
    inputs: { period: 10, multiplier: 3 },
    signals(c, p) {
      const { dir } = supertrend(c, p.period, p.multiplier);
      return c.map((_, i) => (i === 0 ? 0 : dir[i - 1] === -1 && dir[i] === 1 ? 1 : dir[i - 1] === 1 && dir[i] === -1 ? -1 : 0));
    },
  },
  {
    id: 'bb',
    name: 'Bollinger mean reversion',
    inputs: { length: 20, mult: 2 },
    signals(c, p) {
      const close = c.map((b) => b.close);
      const basis = sma(close, p.length);
      const dev = stdev(close, p.length);
      return c.map((b, i) => {
        if (i === 0 || Number.isNaN(basis[i]) || Number.isNaN(basis[i - 1])) return 0;
        const lower = basis[i] - p.mult * dev[i];
        const upper = basis[i] + p.mult * dev[i];
        if (c[i - 1].close < basis[i - 1] - p.mult * dev[i - 1] && b.close >= lower) return 1;
        if (c[i - 1].close > basis[i - 1] + p.mult * dev[i - 1] && b.close <= upper) return -1;
        return 0;
      });
    },
  },
  {
    id: 'donchian',
    name: 'Donchian breakout',
    inputs: { entry: 20, exit: 10 },
    signals(c, p) {
      return c.map((b, i) => {
        if (i < p.entry) return 0;
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = i - p.entry; j < i; j++) hh = Math.max(hh, c[j].high);
        for (let j = Math.max(0, i - p.exit); j < i; j++) ll = Math.min(ll, c[j].low);
        if (b.close > hh) return 1;
        if (b.close < ll) return -1;
        return 0;
      });
    },
  },
  {
    id: 'atr_trend',
    name: 'EMA trend + ATR exit',
    inputs: { length: 50, atrLength: 14, atrMult: 2 },
    signals(c, p) {
      const close = c.map((b) => b.close);
      const e = ema(close, p.length);
      const a = atr(c, p.atrLength);
      return c.map((b, i) => {
        if (i === 0 || Number.isNaN(e[i]) || Number.isNaN(e[i - 1]) || Number.isNaN(a[i])) return 0;
        if (c[i - 1].close <= e[i - 1] && b.close > e[i]) return 1;
        if (b.close < e[i] - p.atrMult * a[i]) return -1;
        return 0;
      });
    },
  },
];

// Signals are evaluated on bar close and filled at the next bar's open.
// Stop-loss / take-profit (percent) are checked intrabar against high/low, stop first.
export function runBacktest(candles, strategy, params, opts) {
  if (opts.tradeList) return runTradeList(candles, opts.tradeList, opts);
  const { capital = 10000, sizePct = 100, commission = 0.1, direction = 'long', slPct = 0, tpPct = 0 } = opts;
  const signals = strategy.signals(candles, params);
  const fee = commission / 100;
  let cash = capital;
  let pos = null;
  const trades = [];
  const equity = [];
  let peak = capital;
  let maxDD = 0;
  let maxDDPct = 0;

  const closePos = (i, price, reason) => {
    const gross = (pos.dir === 1 ? price - pos.entry : pos.entry - price) * pos.qty;
    const pnl = gross - (pos.entry * pos.qty + price * pos.qty) * fee;
    cash += pnl;
    trades.push({
      dir: pos.dir,
      entryTime: pos.time,
      entryPrice: pos.entry,
      exitTime: candles[i].time,
      exitPrice: price,
      qty: pos.qty,
      pnl,
      pnlPct: (pnl / (pos.entry * pos.qty)) * 100,
      bars: i - pos.index,
      reason,
    });
    pos = null;
  };

  for (let i = 1; i < candles.length; i++) {
    const bar = candles[i];
    const sig = signals[i - 1];
    if (sig !== 0) {
      if (pos && pos.dir !== sig) closePos(i, bar.open, 'Signal');
      const allowed = sig === 1 ? direction !== 'short' : direction !== 'long';
      if (!pos && allowed && cash > 0) {
        const qty = (cash * (sizePct / 100)) / bar.open;
        if (qty > 0) pos = { dir: sig, entry: bar.open, qty, time: bar.time, index: i };
      }
    }
    if (pos) {
      const sl = slPct > 0 ? pos.entry * (1 - (pos.dir * slPct) / 100) : null;
      const tp = tpPct > 0 ? pos.entry * (1 + (pos.dir * tpPct) / 100) : null;
      if (sl !== null && (pos.dir === 1 ? bar.low <= sl : bar.high >= sl)) closePos(i, sl, 'Stop loss');
      else if (tp !== null && (pos.dir === 1 ? bar.high >= tp : bar.low <= tp)) closePos(i, tp, 'Take profit');
    }
    const openPnl = pos ? (pos.dir === 1 ? bar.close - pos.entry : pos.entry - bar.close) * pos.qty : 0;
    const eq = cash + openPnl;
    equity.push({ time: bar.time, value: eq });
    peak = Math.max(peak, eq);
    if (peak - eq > maxDD) {
      maxDD = peak - eq;
      maxDDPct = (maxDD / peak) * 100;
    }
  }
  if (pos) closePos(candles.length - 1, candles.at(-1).close, 'End of data');
  return summarize(candles, trades, equity, capital, cash, maxDD, maxDDPct);
}

// Trades a strategy-style custom indicator simulated itself (its own entries, stops and exits).
// Each trade is sized from the Properties (order size % of equity, or the trade's own quantity),
// charged the commission, and the equity curve follows realised plus open P&L bar by bar.
function runTradeList(candles, list, opts) {
  const { capital = 10000, sizePct = 100, commission = 0.1, direction = 'both' } = opts;
  const fee = commission / 100;
  const times = candles.map((c) => c.time);
  const indexAt = (t) => {
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1; else hi = mid;
    }
    return times[lo] > t && lo > 0 ? lo - 1 : lo;
  };
  let cash = capital;
  const trades = [];
  const sorted = [...list].filter((t) => Number.isFinite(t.entryPrice) && (direction === 'both' || (direction === 'long' ? t.dir === 1 : t.dir === -1)))
    .sort((a, b) => a.entryTime - b.entryTime);
  for (const t of sorted) {
    const i0 = indexAt(t.entryTime);
    const open = t.exitTime === null || !Number.isFinite(t.exitPrice);
    const exitPrice = open ? candles.at(-1).close : t.exitPrice;
    const i1 = open ? candles.length - 1 : indexAt(t.exitTime);
    const qty = t.qty ?? (Math.max(0, cash) * (sizePct / 100)) / t.entryPrice;
    if (!(qty > 0)) continue;
    const gross = (t.dir === 1 ? exitPrice - t.entryPrice : t.entryPrice - exitPrice) * qty;
    const pnl = gross - (t.entryPrice * qty + exitPrice * qty) * fee;
    cash += pnl;
    trades.push({
      dir: t.dir, entryTime: candles[i0].time, entryPrice: t.entryPrice, exitTime: candles[i1].time, exitPrice, qty, pnl,
      pnlPct: (pnl / (t.entryPrice * qty)) * 100, bars: i1 - i0, reason: open ? 'Open' : t.reason, i0, i1,
    });
  }
  const equity = [];
  let realised = capital;
  let peak = capital;
  let maxDD = 0;
  let maxDDPct = 0;
  const byExit = new Map();
  for (const t of trades) byExit.set(t.i1, (byExit.get(t.i1) ?? 0) + t.pnl);
  for (let i = 0; i < candles.length; i++) {
    realised += byExit.get(i) ?? 0;
    let openPnl = 0;
    for (const t of trades) {
      if (t.i0 <= i && i < t.i1) openPnl += (t.dir === 1 ? candles[i].close - t.entryPrice : t.entryPrice - candles[i].close) * t.qty;
    }
    const eq = realised + openPnl;
    equity.push({ time: candles[i].time, value: eq });
    peak = Math.max(peak, eq);
    if (peak - eq > maxDD) {
      maxDD = peak - eq;
      maxDDPct = (maxDD / peak) * 100;
    }
  }
  return summarize(candles, trades, equity, capital, cash, maxDD, maxDDPct);
}

function summarize(candles, trades, equity, capital, cash, maxDD, maxDDPct) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const net = cash - capital;
  const first = candles[0]?.close;
  const last = candles.at(-1)?.close;
  return {
    trades,
    equity,
    stats: {
      net,
      netPct: (net / capital) * 100,
      total: trades.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      maxDD,
      maxDDPct,
      avgTrade: trades.length ? net / trades.length : 0,
      avgBars: trades.length ? trades.reduce((s, t) => s + t.bars, 0) / trades.length : 0,
      largestWin: wins.length ? Math.max(...wins.map((t) => t.pnl)) : 0,
      largestLoss: losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0,
      buyHoldPct: first ? ((last - first) / first) * 100 : 0,
      longs: trades.filter((t) => t.dir === 1).length,
      shorts: trades.filter((t) => t.dir === -1).length,
    },
  };
}
