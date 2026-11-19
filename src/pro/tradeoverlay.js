// On-chart paper trading, TradingView style: position line with live P&L and close button,
// draggable TP/SL and pending-order lines, liquidation line, execution markers, and the
// Sell | qty | Buy quick-trade panel. Painted inside the drawing layer's primitive.

import { PAPER_FEE } from './services.js';
import { formatPrice, h, lowerBound, store } from './util.js';

const COLORS = {
  long: '#2962FF', short: '#E91E63', tp: '#089981', sl: '#F23645', liq: '#FF9800',
};

// One joined label made of coloured segments; returns a hit box per segment.
function pill(ctx, x, y, parts) {
  ctx.font = '600 11px Inter, -apple-system, sans-serif';
  const pad = 6;
  const widths = parts.map((p) => ctx.measureText(p.text).width + pad * 2);
  let left = x - widths.reduce((s, w) => s + w, 0);
  const top = y - 10;
  const boxes = [];
  parts.forEach((p, i) => {
    const w = widths[i];
    ctx.fillStyle = p.bg;
    ctx.beginPath();
    ctx.roundRect(left, top, w, 20, i === 0 ? [3, 0, 0, 3] : i === parts.length - 1 ? [0, 3, 3, 0] : 0);
    ctx.fill();
    ctx.fillStyle = p.fg ?? '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(p.text, left + pad, y + 0.5);
    boxes.push({ id: p.id, x: left, y: top, w, h: 20 });
    left += w;
  });
  return boxes;
}

export class TradeOverlay {
  constructor(pane) {
    this.pane = pane;
    this.hits = [];
    this.drag = null;
    this.buildPanel();
  }

  get app() { return this.pane.app; }
  get broker() { return this.app.broker; }

  y(price) { return this.pane.main.priceToCoordinate(price); }

  money(v) { return `${v >= 0 ? '+' : ''}${formatPrice(v, 2)} USDT`; }

  // Net P&L if the position were closed at `price` (entry and exit fees included).
  pnlAt(p, price) {
    const m = this.broker.mult(p.symbol);
    const gross = (price - p.entry) * p.qty * (p.side === 'buy' ? 1 : -1) * m;
    return gross - p.fees - price * p.qty * m * PAPER_FEE;
  }

  render(ctx, w) {
    this.hits = [];
    const s = this.app.settings;
    const sym = this.pane.symbol;
    const state = this.broker.state;
    const right = w - 8;
    ctx.save();
    if (s.showPositions !== false) {
      for (const p of state.positions.filter((x) => x.symbol === sym)) this.renderPosition(ctx, p, w, right);
      this.renderExecutions(ctx, state);
    }
    if (s.showOrders !== false) {
      for (const o of state.orders.filter((x) => x.symbol === sym)) this.renderOrder(ctx, o, w, right);
    }
    ctx.restore();
  }

  line(ctx, y, color, w, dash = []) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  renderPosition(ctx, p, w, right) {
    const long = p.side === 'buy';
    const color = long ? COLORS.long : COLORS.short;
    const ye = this.y(p.entry);
    if (ye === null) return;
    const upnl = this.broker.unrealized(p);
    const pct = p.margin ? (upnl / p.margin) * 100 : 0;
    this.line(ctx, ye, color, w, [4, 3]);
    const parts = [
      { text: `${long ? 'LONG' : 'SHORT'} ${+p.qty.toFixed(6)}`, bg: color, id: 'pos-label' },
      { text: `${this.money(upnl)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`, bg: upnl >= 0 ? '#089981' : '#F23645', id: 'pos-pnl' },
    ];
    if (!p.tp) parts.push({ text: '+TP', bg: '#2A2E39', id: 'add-tp' });
    if (!p.sl) parts.push({ text: '+SL', bg: '#2A2E39', id: 'add-sl' });
    parts.push({ text: '✕', bg: '#434651', id: 'close' });
    for (const b of pill(ctx, right - 70, ye, parts)) this.hits.push({ ...b, pos: p });
    for (const kind of ['tp', 'sl']) {
      const dragging = this.drag?.id === p.id && this.drag.kind === kind;
      const price = dragging ? this.drag.price : p[kind];
      if (!price) continue;
      const y = this.y(price);
      if (y === null) continue;
      const c = kind === 'tp' ? COLORS.tp : COLORS.sl;
      this.line(ctx, y, c, w, [6, 4]);
      const pnl = this.pnlAt(p, price);
      const boxes = pill(ctx, right - 70, y, [
        { text: `${kind.toUpperCase()} ${formatPrice(price, this.pane.digits())}`, bg: c, id: `drag-${kind}` },
        { text: this.money(pnl), bg: pnl >= 0 ? '#089981' : '#F23645', id: `drag-${kind}` },
        { text: '✕', bg: '#434651', id: `remove-${kind}` },
      ]);
      for (const b of boxes) this.hits.push({ ...b, pos: p });
      this.hits.push({ id: `drag-${kind}`, x: 0, y: y - 4, w: Math.max(0, w - 300), h: 8, pos: p });
    }
    if ((p.leverage ?? 1) > 1) {
      const liq = this.broker.liqPrice(p);
      const y = this.y(liq);
      if (y !== null) {
        this.line(ctx, y, COLORS.liq, w, [2, 3]);
        pill(ctx, right - 70, y, [{ text: `Liq. ${formatPrice(liq, this.pane.digits())}`, bg: COLORS.liq }]);
      }
    }
  }

  renderOrder(ctx, o, w, right) {
    const price = this.drag?.kind === 'order' && this.drag.id === o.id ? this.drag.price : o.price;
    const y = this.y(price);
    if (y === null) return;
    const color = o.side === 'buy' ? COLORS.long : COLORS.short;
    this.line(ctx, y, color, w, [2, 3]);
    const boxes = pill(ctx, right - 70, y, [
      { text: `${o.side.toUpperCase()} ${o.type === 'limit' ? 'LMT' : 'STP'} ${o.qty}`, bg: color, id: 'drag-order' },
      { text: formatPrice(price, this.pane.digits()), bg: '#2A2E39', id: 'drag-order' },
      { text: '✕', bg: '#434651', id: 'cancel-order' },
    ]);
    for (const b of boxes) this.hits.push({ ...b, order: o });
    this.hits.push({ id: 'drag-order', x: 0, y: y - 4, w: Math.max(0, w - 300), h: 8, order: o });
  }

  // Entry/exit arrows for this symbol's fills (open positions and closed trades).
  renderExecutions(ctx, state) {
    const sym = this.pane.symbol;
    const step = this.pane.stepSec();
    const times = this.pane.displayTimes();
    if (!times.length) return;
    const marks = [];
    for (const p of state.positions) if (p.symbol === sym) marks.push({ t: p.opened / 1000, price: p.entry, buy: p.side === 'buy' });
    for (const t of state.history.slice(0, 300)) {
      if (t.symbol !== sym) continue;
      marks.push({ t: t.opened / 1000, price: t.entry, buy: t.side === 'buy' });
      marks.push({ t: t.closed / 1000, price: t.exit, buy: t.side !== 'buy', exit: true, pnl: t.pnl });
    }
    const ts = this.pane.chart.timeScale();
    for (const m of marks) {
      if (m.t < times[0]) continue;
      const bar = Math.floor(m.t / step) * step;
      const idx = lowerBound(times, bar);
      const x = ts.logicalToCoordinate(times[idx] === bar ? idx : this.pane.drawings.timeToLogical(m.t));
      const y = this.y(m.price);
      if (x === null || y === null) continue;
      ctx.fillStyle = m.buy ? COLORS.long : COLORS.short;
      ctx.beginPath();
      if (m.buy) {
        ctx.moveTo(x, y + 2);
        ctx.lineTo(x - 5, y + 10);
        ctx.lineTo(x + 5, y + 10);
      } else {
        ctx.moveTo(x, y - 2);
        ctx.lineTo(x - 5, y - 10);
        ctx.lineTo(x + 5, y - 10);
      }
      ctx.closePath();
      ctx.fill();
      if (m.exit) {
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = m.buy ? 'top' : 'bottom';
        ctx.fillStyle = m.pnl >= 0 ? '#089981' : '#F23645';
        ctx.fillText(`${m.pnl >= 0 ? '+' : ''}${m.pnl.toFixed(2)}`, x, m.buy ? y + 12 : y - 12);
      }
    }
  }

  // ----- pointer interaction (the drawing layer asks us first)
  hitAt(x, y) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const b = this.hits[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }

  cursorAt(x, y) {
    const hit = this.hitAt(x, y);
    if (!hit) return null;
    return hit.id.startsWith('drag-') ? 'ns-resize' : 'pointer';
  }

  pointerDown(x, y) {
    const hit = this.hitAt(x, y);
    if (!hit) return false;
    const b = this.broker;
    const p = hit.pos;
    const d = this.pane.digits() ?? 2;
    const mark = p ? b.quote(p.symbol).last ?? p.entry : null;
    switch (hit.id) {
      case 'close':
        b.close(p.id, 'Closed from chart');
        break;
      case 'add-tp':
        b.updatePosition(p.id, { tp: +(p.side === 'buy' ? Math.max(p.entry, mark) * 1.01 : Math.min(p.entry, mark) * 0.99).toFixed(d) });
        break;
      case 'add-sl':
        b.updatePosition(p.id, { sl: +(p.side === 'buy' ? Math.min(p.entry, mark) * 0.99 : Math.max(p.entry, mark) * 1.01).toFixed(d) });
        break;
      case 'remove-tp':
        b.updatePosition(p.id, { tp: null });
        break;
      case 'remove-sl':
        b.updatePosition(p.id, { sl: null });
        break;
      case 'cancel-order':
        b.cancel(hit.order.id);
        break;
      case 'drag-tp':
      case 'drag-sl': {
        const kind = hit.id.slice(5);
        this.drag = { kind, id: p.id, price: p[kind] };
        return true;
      }
      case 'drag-order':
        this.drag = { kind: 'order', id: hit.order.id, price: hit.order.price };
        return true;
      default:
        return true;
    }
    this.pane.drawings.update();
    return true;
  }

  pointerMove(y) {
    if (!this.drag) return false;
    const price = this.pane.main.coordinateToPrice(y);
    if (price !== null) {
      this.drag.price = +price.toFixed(this.pane.digits() ?? 2);
      this.pane.drawings.update();
    }
    return true;
  }

  pointerUp() {
    if (!this.drag) return false;
    const { kind, id, price } = this.drag;
    this.drag = null;
    if (kind === 'order') this.broker.modifyOrder(id, { price });
    else this.broker.updatePosition(id, { [kind]: price });
    this.pane.drawings.update();
    return true;
  }

  // ----- Sell | qty | Buy panel (TradingView's on-chart buy/sell buttons)
  buildPanel() {
    const qty = h('input', { type: 'number', step: 'any', min: '0', class: 'qt-qty', 'aria-label': 'Order quantity' });
    const sell = h('button', { type: 'button', class: 'qt-btn sell', title: 'Market sell at the bid' }, h('small', {}, 'SELL'), h('b', {}, '—'));
    const buy = h('button', { type: 'button', class: 'qt-btn buy', title: 'Market buy at the ask' }, h('small', {}, 'BUY'), h('b', {}, '—'));
    const spread = h('span', { class: 'qt-spread' }, '');
    const send = (side) => {
      const q = Number(qty.value);
      store.set(`qty.${this.pane.symbol}`, q);
      this.broker.placeOrder({ symbol: this.pane.symbol, side, type: 'market', qty: q });
    };
    sell.addEventListener('click', () => send('sell'));
    buy.addEventListener('click', () => send('buy'));
    qty.addEventListener('change', () => store.set(`qty.${this.pane.symbol}`, Number(qty.value)));
    this.panel = h('div', { class: 'quick-trade glass-pop' }, sell, h('div', { class: 'qt-mid' }, qty, spread), buy);
    this.panelParts = { qty, sell, buy, spread };
    this.pane.host.append(this.panel);
  }

  refreshPanel(resetQty = false) {
    const { qty, sell, buy, spread } = this.panelParts;
    this.panel.hidden = this.app.settings.showBuySell === false;
    const q = this.broker.quote(this.pane.symbol);
    const d = this.pane.digits();
    sell.lastChild.textContent = Number.isFinite(q.bid) ? formatPrice(q.bid, d) : '—';
    buy.lastChild.textContent = Number.isFinite(q.ask) ? formatPrice(q.ask, d) : '—';
    spread.textContent = Number.isFinite(q.ask - q.bid) ? formatPrice(q.ask - q.bid, d) : '';
    if (resetQty || !qty.value) {
      qty.value = store.get(`qty.${this.pane.symbol}`, q.last ? +(1000 / q.last).toPrecision(3) : 1);
    }
  }
}
