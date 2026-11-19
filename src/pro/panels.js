// Right sidebar widgets (watchlist, alerts, order book, trades, data window, object tree)
// and the bottom panel (paper trading + strategy tester).

import { AreaSeries, createChart } from 'lightweight-charts';
import { fetchDepth, fetchTrades, hub, onTickers, tickDigits, tickers } from './binance.js';
import { toolById } from './drawings.js';
import { ALERT_CONDITIONS, runBacktest, STRATEGIES as BASE_STRATEGIES } from './services.js';
import { CUSTOM_STRATEGIES } from './customind.js';

// Built-in strategies, then the strategy-style custom indicators (their own simulated trades).
const STRATEGIES = [...BASE_STRATEGIES, ...CUSTOM_STRATEGIES];
import {
  escapeHtml, formatCompact, formatPct, formatPrice, h, intervalLabel, lowerBound, showMenu, signClass, store, throttleFrame,
  toast,
} from './util.js';

const DEFAULT_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TRXUSDT', 'DOTUSDT', 'LTCUSDT', 'PAXGUSDT'];

export const SIDE_TABS = [
  { id: 'watchlist', icon: '☰', label: 'Watchlist' },
  { id: 'alerts', icon: '⏰', label: 'Alerts' },
  { id: 'book', icon: '≡', label: 'Order book' },
  { id: 'trades', icon: '⇅', label: 'Recent trades' },
  { id: 'data', icon: '⊞', label: 'Data window' },
  { id: 'objects', icon: '⧉', label: 'Object tree' },
];

function fmtTime(ms, withDate = false) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return withDate ? `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}` : time;
}

export class Sidebar {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.body = root.querySelector('.sidebar-body');
    this.rail = root.querySelector('.sidebar-rail');
    this.tab = store.get('sideTab', 'watchlist');
    this.open = store.get('sideOpen', true);
    this.watchlist = store.get('watchlist', DEFAULT_WATCHLIST);
    this.sort = store.get('watchSort', null);
    this.prevPrices = new Map();
    this.streamUnsub = null;
    this.bookData = null;
    this.trades = [];

    for (const t of SIDE_TABS) {
      const btn = h('button', { type: 'button', class: 'rail-btn', 'data-tab': t.id, title: t.label, 'aria-label': t.label }, t.icon);
      btn.addEventListener('click', () => this.select(t.id));
      this.rail.append(btn);
    }
    onTickers(throttleFrame(() => this.onTickers()));
    app.alerts.on('change', () => { if (this.open && this.tab === 'alerts') this.render(); });
    this.applyOpen();
    this.render();
  }

  select(tab) {
    if (this.tab === tab && this.open) this.open = false;
    else {
      this.tab = tab;
      this.open = true;
    }
    store.set('sideTab', this.tab);
    store.set('sideOpen', this.open);
    this.applyOpen();
    this.render();
  }

  applyOpen() {
    this.root.classList.toggle('collapsed', !this.open);
    this.rail.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', this.open && b.dataset.tab === this.tab));
  }

  onActiveSymbol() {
    if (!this.open) return;
    if (this.tab === 'watchlist') this.updateWatchRows();
    else if (this.tab !== 'alerts') this.render();
  }

  render() {
    this.streamUnsub?.();
    this.streamUnsub = null;
    this.watchRows = null;
    this.dataEl = null;
    if (!this.open) {
      this.body.replaceChildren();
      return;
    }
    switch (this.tab) {
      case 'alerts': this.renderAlerts(); break;
      case 'book': this.startBook(); break;
      case 'trades': this.startTrades(); break;
      case 'data': this.renderData(); break;
      case 'objects': this.renderObjects(); break;
      default: this.renderWatchlist();
    }
  }

  onTickers() {
    if (this.open && this.tab === 'watchlist') this.updateWatchRows();
  }

  // ---------- Watchlist ----------
  saveWatchlist() { store.set('watchlist', this.watchlist); }

  addToWatchlist(symbol) {
    if (!this.watchlist.includes(symbol)) {
      this.watchlist.push(symbol);
      this.saveWatchlist();
    }
    if (this.open && this.tab === 'watchlist') this.renderWatchlist();
  }

  removeFromWatchlist(symbol) {
    this.watchlist = this.watchlist.filter((s) => s !== symbol);
    this.saveWatchlist();
    this.renderWatchlist();
  }

  sortedWatchlist() {
    const list = [...this.watchlist];
    if (!this.sort) return list;
    const [key, dir] = this.sort;
    const val = (s) => {
      if (key === 'symbol') return s;
      const t = tickers.get(s);
      if (!t) return -Infinity;
      if (key === 'last') return t.last;
      if (key === 'chg') return (t.last - t.open) / t.open;
      return t.quoteVolume;
    };
    list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }

  setSort(key) {
    if (!this.sort || this.sort[0] !== key) this.sort = [key, key === 'symbol' ? 'asc' : 'desc'];
    else if (this.sort[1] === 'desc') this.sort = [key, 'asc'];
    else this.sort = null;
    store.set('watchSort', this.sort);
    this.renderWatchlist();
  }

  renderWatchlist() {
    const active = this.app.activePane?.symbol;
    const header = h('div', { class: 'widget-head' },
      h('h2', {}, 'Watchlist'),
      h('div', { class: 'widget-actions' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Add symbol', onclick: () => this.app.openSymbolSearch({ mode: 'watchlist' }) }, '+'),
        h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'More',
          onclick: (event) => showMenu(event.currentTarget, [
            { label: 'Add active symbol', icon: '+', action: () => active && this.addToWatchlist(active) },
            { label: 'Reset to defaults', icon: '↺', action: () => { this.watchlist = [...DEFAULT_WATCHLIST]; this.saveWatchlist(); this.renderWatchlist(); } },
            { label: 'Clear sorting', icon: '⇅', disabled: !this.sort, action: () => { this.sort = null; store.set('watchSort', null); this.renderWatchlist(); } },
          ], { align: 'right' }),
        }, '⋯')));
    const sortMark = (key) => (this.sort?.[0] === key ? (this.sort[1] === 'asc' ? ' ▲' : ' ▼') : '');
    const cols = h('div', { class: 'watch-cols' },
      ...[['symbol', 'Symbol'], ['last', 'Last'], ['chg', 'Chg%'], ['vol', 'Vol']].map(([key, text]) => h('button', { type: 'button', onclick: () => this.setSort(key) }, text + sortMark(key))));
    this.watchRows = h('div', { class: 'watch-rows' });
    this.watchRows.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-remove]');
      if (remove) {
        event.stopPropagation();
        this.removeFromWatchlist(remove.dataset.remove);
        return;
      }
      const row = event.target.closest('[data-symbol]');
      if (row) this.app.activePane?.setSymbol(row.dataset.symbol);
    });
    this.watchRows.addEventListener('keydown', (event) => {
      const row = event.target.closest('[data-symbol]');
      if (row && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        this.app.activePane?.setSymbol(row.dataset.symbol);
      }
    });
    this.detail = h('div', { class: 'symbol-detail' });
    this.body.replaceChildren(h('div', { class: 'widget watchlist' }, header, cols, this.watchRows), this.detail);
    this.updateWatchRows();
  }

  updateWatchRows() {
    if (!this.watchRows) return;
    const active = this.app.activePane?.symbol;
    const list = this.sortedWatchlist();
    const focused = document.activeElement?.closest?.('[data-symbol]')?.dataset.symbol;
    const html = list.map((s) => {
      const t = tickers.get(s);
      const info = this.app.symbolInfo(s);
      const prev = this.prevPrices.get(s);
      const flash = t && prev !== undefined && t.last !== prev ? (t.last > prev ? 'flash-up' : 'flash-down') : '';
      if (t) this.prevPrices.set(s, t.last);
      const chg = t ? ((t.last - t.open) / t.open) * 100 : NaN;
      const digits = info ? tickDigits(info.tick) : undefined;
      return `<div class="watch-row${s === active ? ' active' : ''}" data-symbol="${escapeHtml(s)}" role="button" tabindex="0">
        <span class="w-sym"><span class="coin">${escapeHtml((info?.base ?? s).slice(0, 1))}</span><span><b>${escapeHtml(info?.base ?? s)}</b><small>${escapeHtml(info?.quote ?? '')}</small></span></span>
        <span class="w-last ${flash}">${t ? formatPrice(t.last, digits) : '—'}</span>
        <span class="w-chg ${signClass(chg)}">${formatPct(chg)}</span>
        <span class="w-vol">${t ? formatCompact(t.quoteVolume) : '—'}</span>
        <button type="button" class="w-remove" data-remove="${escapeHtml(s)}" title="Remove" aria-label="Remove ${escapeHtml(s)}">✕</button>
      </div>`;
    }).join('');
    this.watchRows.innerHTML = html || '<div class="empty">Add symbols with +</div>';
    if (focused) this.watchRows.querySelector(`[data-symbol="${CSS.escape(focused)}"]`)?.focus();
    this.renderDetail();
  }

  renderDetail() {
    if (!this.detail) return;
    const s = this.app.activePane?.symbol;
    const t = s && tickers.get(s);
    const info = s && this.app.symbolInfo(s);
    if (!t) {
      this.detail.replaceChildren();
      return;
    }
    const digits = info ? tickDigits(info.tick) : undefined;
    const chg = t.last - t.open;
    const pct = (chg / t.open) * 100;
    const pos = t.high > t.low ? ((t.last - t.low) / (t.high - t.low)) * 100 : 50;
    this.detail.innerHTML = `
      <div class="detail-head"><span class="coin big">${escapeHtml((info?.base ?? s).slice(0, 1))}</span><div><b>${escapeHtml(s)}</b><small>${escapeHtml(info ? `${info.base} / ${info.quote} · Binance spot` : 'Binance spot')}</small></div></div>
      <div class="detail-price"><span>${formatPrice(t.last, digits)}</span><small>${escapeHtml(info?.quote ?? '')}</small></div>
      <div class="detail-change ${signClass(chg)}">${chg >= 0 ? '+' : ''}${formatPrice(chg, digits)} (${formatPct(pct)}) <small>24h</small></div>
      <div class="range"><div class="range-labels"><span>${formatPrice(t.low, digits)}</span><small>24h range</small><span>${formatPrice(t.high, digits)}</span></div>
      <div class="range-track"><span style="left:${Math.max(0, Math.min(100, pos)).toFixed(1)}%"></span></div></div>
      <div class="detail-grid">
        <span>Volume</span><b>${formatCompact(t.volume)} ${escapeHtml(info?.base ?? '')}</b>
        <span>Quote volume</span><b>${formatCompact(t.quoteVolume)} ${escapeHtml(info?.quote ?? '')}</b>
        <span>Open (24h)</span><b>${formatPrice(t.open, digits)}</b>
        <span>Tick size</span><b>${info ? info.tick : '—'}</b>
      </div>`;
  }

  // ---------- Alerts ----------
  renderAlerts() {
    const alerts = this.app.alerts;
    const list = h('div', { class: 'alert-list' },
      ...(alerts.alerts.length ? alerts.alerts.map((a) => {
        const cond = ALERT_CONDITIONS.find((c) => c.id === a.condition)?.label ?? a.condition;
        const last = tickers.get(a.symbol)?.last;
        return h('div', { class: `alert-item${a.active ? '' : ' inactive'}` },
          h('button', { type: 'button', class: 'alert-main', onclick: () => this.app.activePane?.setSymbol(a.symbol) },
            h('b', {}, a.symbol),
            h('span', {}, `${cond} ${formatPrice(a.price)}`),
            h('small', {}, a.message || `${last ? `Last ${formatPrice(last)} · ` : ''}${a.once ? 'Once' : 'Every time'}${a.active ? '' : ' · stopped'}`)),
          h('div', { class: 'alert-actions' },
            h('button', { type: 'button', class: 'icon-btn', title: a.active ? 'Pause' : 'Resume', onclick: () => alerts.update(a.id, { active: !a.active }) }, a.active ? '⏸' : '▶'),
            h('button', { type: 'button', class: 'icon-btn', title: 'Edit', onclick: () => this.app.openAlertDialog(a.symbol, a.price, a) }, '✎'),
            h('button', { type: 'button', class: 'icon-btn', title: 'Delete', onclick: () => alerts.remove(a.id) }, '✕')));
      }) : [h('div', { class: 'empty' }, 'No alerts yet. Press Alt+A or right-click the chart.')]));
    const log = h('div', { class: 'alert-log' },
      ...(alerts.log.length ? alerts.log.slice(0, 50).map((l) => h('div', { class: 'log-item' },
        h('span', {}, fmtTime(l.time, true)),
        h('b', {}, l.message),
        h('small', {}, `@ ${formatPrice(l.price)}`))) : [h('div', { class: 'empty' }, 'Triggered alerts appear here.')]));
    this.body.replaceChildren(h('div', { class: 'widget' },
      h('div', { class: 'widget-head' }, h('h2', {}, 'Alerts'),
        h('div', { class: 'widget-actions' },
          h('button', { type: 'button', class: 'btn small primary', onclick: () => this.app.openAlertDialog() }, '+ Create'))),
      list,
      h('div', { class: 'widget-head sub' }, h('h3', {}, 'Log'), alerts.log.length ? h('button', { type: 'button', class: 'link-btn', onclick: () => alerts.clearLog() }, 'Clear') : null),
      log));
  }

  // ---------- Order book ----------
  startBook() {
    const symbol = this.app.activePane?.symbol;
    if (!symbol) return;
    const info = this.app.symbolInfo(symbol);
    this.bookDigits = info ? tickDigits(info.tick) : undefined;
    this.bookSymbol = symbol;
    this.bookEl = h('div', { class: 'book' }, h('div', { class: 'empty' }, 'Loading order book…'));
    this.body.replaceChildren(h('div', { class: 'widget' },
      h('div', { class: 'widget-head' }, h('h2', {}, 'Order book'), h('span', { class: 'muted' }, symbol)),
      h('div', { class: 'book-cols' }, h('span', {}, 'Price'), h('span', {}, 'Amount'), h('span', {}, 'Total')),
      this.bookEl));
    this.bookData = null;
    fetchDepth(symbol, 20).then((d) => {
      if (this.tab !== 'book' || this.bookSymbol !== symbol || this.bookData) return;
      this.renderBook({ bids: d.bids, asks: d.asks });
    }).catch(() => {});
    const render = throttleFrame(() => this.renderBook(this.bookData));
    this.streamUnsub = hub.subscribe(`${symbol.toLowerCase()}@depth20@100ms`, (d) => {
      this.bookData = { bids: d.bids, asks: d.asks };
      render();
    });
  }

  renderBook(data) {
    if (!data || !this.bookEl?.isConnected) return;
    const rows = 14;
    const asks = data.asks.slice(0, rows).map(([p, q]) => [Number(p), Number(q)]);
    const bids = data.bids.slice(0, rows).map(([p, q]) => [Number(p), Number(q)]);
    let cum = 0;
    const askCum = asks.map(([p, q]) => { cum += q; return [p, q, cum]; });
    cum = 0;
    const bidCum = bids.map(([p, q]) => { cum += q; return [p, q, cum]; });
    const max = Math.max(askCum.at(-1)?.[2] ?? 0, bidCum.at(-1)?.[2] ?? 0) || 1;
    const d = this.bookDigits;
    const row = (side) => ([p, q, c]) => `<div class="book-row ${side}"><span class="bar" style="width:${((c / max) * 100).toFixed(1)}%"></span><span>${formatPrice(p, d)}</span><span>${q.toFixed(q >= 100 ? 2 : 4)}</span><span>${formatCompact(c)}</span></div>`;
    const bestAsk = asks[0]?.[0];
    const bestBid = bids[0]?.[0];
    const spread = bestAsk && bestBid ? bestAsk - bestBid : NaN;
    const t = tickers.get(this.bookSymbol);
    this.bookEl.innerHTML = `${askCum.slice().reverse().map(row('ask')).join('')}
      <div class="book-mid"><b class="${signClass(t ? t.last - t.open : 0)}">${formatPrice(t?.last ?? bestBid ?? NaN, d)}</b><small>Spread ${formatPrice(spread, d)} (${bestBid ? ((spread / bestBid) * 100).toFixed(3) : '—'}%)</small></div>
      ${bidCum.map(row('bid')).join('')}`;
  }

  // ---------- Trades ----------
  startTrades() {
    const symbol = this.app.activePane?.symbol;
    if (!symbol) return;
    const info = this.app.symbolInfo(symbol);
    const digits = info ? tickDigits(info.tick) : undefined;
    const listEl = h('div', { class: 'trades' });
    this.body.replaceChildren(h('div', { class: 'widget' },
      h('div', { class: 'widget-head' }, h('h2', {}, 'Recent trades'), h('span', { class: 'muted' }, symbol)),
      h('div', { class: 'book-cols' }, h('span', {}, 'Price'), h('span', {}, 'Amount'), h('span', {}, 'Time')),
      listEl));
    this.trades = [];
    const render = throttleFrame(() => {
      listEl.innerHTML = this.trades.map((t) => `<div class="trade-row ${t.m ? 'down' : 'up'}"><span>${formatPrice(Number(t.p), digits)}</span><span>${Number(t.q).toFixed(4)}</span><span>${fmtTime(t.T)}</span></div>`).join('');
    });
    fetchTrades(symbol, 60).then((rows) => {
      if (!listEl.isConnected) return;
      this.trades = [...this.trades, ...rows.reverse()].slice(0, 80);
      render();
    }).catch(() => {});
    this.streamUnsub = hub.subscribe(`${symbol.toLowerCase()}@aggTrade`, (t) => {
      this.trades.unshift(t);
      if (this.trades.length > 80) this.trades.length = 80;
      render();
    });
  }

  // ---------- Data window ----------
  renderData(param) {
    if (!this.open || this.tab !== 'data') return;
    const pane = this.app.activePane;
    if (!pane) return;
    const { bar, prev } = pane.barAt(param ? param.time : pane.crosshairTime);
    const d = pane.digits();
    const rows = [];
    const add = (text, value) => rows.push(`<span>${escapeHtml(text)}</span><b>${value}</b>`);
    if (bar) {
      add('Date', escapeHtml(this.app.timeFormatter.full(bar.time)));
      add('Open', formatPrice(bar.open, d));
      add('High', formatPrice(bar.high, d));
      add('Low', formatPrice(bar.low, d));
      add('Close', formatPrice(bar.close, d));
      if (prev) add('Change', `<span class="${signClass(bar.close - prev.close)}">${formatPct(((bar.close - prev.close) / prev.close) * 100)}</span>`);
      add('Range', formatPrice(bar.high - bar.low, d));
      add('Volume', formatCompact(bar.volume));
      if (bar.quoteVolume) add('Quote vol', formatCompact(bar.quoteVolume));
      if (bar.trades) add('Trades', bar.trades.toLocaleString());
    }
    const sections = [`<div class="data-grid">${rows.join('')}</div>`];
    for (const inst of pane.indicators) {
      const values = pane.valuesAt(inst, bar?.time);
      const cells = values.map((v) => {
        const text = Number.isFinite(v.value) ? (Math.abs(v.value) >= 1e5 ? formatCompact(v.value) : v.value.toFixed(Math.abs(v.value) >= 100 ? 2 : 4)) : '—';
        return `<span>${escapeHtml(v.plot.title)}</span><b style="color:${escapeHtml(v.color)}">${text}</b>`;
      }).join('');
      sections.push(`<div class="data-title">${escapeHtml(pane.indicatorLabel(inst))}</div><div class="data-grid">${cells}</div>`);
    }
    if (!this.dataEl?.isConnected) {
      this.dataEl = h('div', { class: 'data-window' });
      this.body.replaceChildren(h('div', { class: 'widget' }, h('div', { class: 'widget-head' }, h('h2', {}, 'Data window')), this.dataEl));
    }
    this.dataEl.innerHTML = `<div class="data-title">${escapeHtml(pane.symbol)} · ${escapeHtml(intervalLabel(pane.interval))}</div>${sections.join('')}`;
  }

  // ---------- Object tree ----------
  renderObjects() {
    if (!this.open || this.tab !== 'objects') return;
    const pane = this.app.activePane;
    if (!pane) return;
    const layer = pane.drawings;
    const item = (icon, name, actions, active, onSelect) => h('div', { class: `obj-item${active ? ' active' : ''}` },
      h('span', { class: 'obj-icon' }, icon),
      h('span', { class: 'obj-name', onclick: onSelect }, name),
      h('span', { class: 'obj-actions' }, ...actions));
    const btn = (title, text, fn) => h('button', { type: 'button', class: 'icon-btn', title, 'aria-label': title, onclick: fn }, text);
    const sections = [
      h('div', { class: 'obj-section' }, 'Chart'),
      item('▮', `${pane.symbol} · ${intervalLabel(pane.interval)}`, [], false),
    ];
    for (const cmp of pane.compares) sections.push(item('≈', `Compare ${cmp.symbol}`, [btn('Remove', '✕', () => pane.removeCompare(cmp.symbol))], false));
    sections.push(h('div', { class: 'obj-section' }, `Indicators (${pane.indicators.length})`));
    for (const inst of pane.indicators) {
      sections.push(item('ƒ', pane.indicatorLabel(inst), [
        btn(inst.visible ? 'Hide' : 'Show', inst.visible ? '◉' : '○', () => pane.toggleIndicator(inst.uid)),
        btn('Settings', '⚙', () => pane.editIndicator(inst.uid)),
        btn('Remove', '✕', () => pane.removeIndicator(inst.uid)),
      ], false));
    }
    sections.push(h('div', { class: 'obj-section' }, `Drawings (${layer.drawings.length})`,
      layer.drawings.length ? h('button', {
        type: 'button',
        class: 'link-btn',
        onclick: () => { if (confirm(`Remove all ${layer.drawings.length} drawings on ${pane.symbol}?`)) layer.clear(); },
      }, 'Remove all') : null));
    for (const d of [...layer.drawings].reverse()) {
      const tool = toolById(d.type);
      const text = d.props?.text;
      sections.push(item(tool?.icon ?? '•', text ? `${tool?.label}: ${text}` : tool?.label ?? d.type, [
        btn('Settings', '⚙', () => layer.openSettings(d)),
        btn(d.hidden ? 'Show' : 'Hide', d.hidden ? '○' : '◉', () => layer.mutate(d.id, (x) => { x.hidden = !x.hidden; })),
        btn(d.locked ? 'Unlock' : 'Lock', d.locked ? '🔒' : '🔓', () => layer.mutate(d.id, (x) => { x.locked = !x.locked; })),
        btn('Remove', '✕', () => layer.remove(d.id)),
      ], d.id === layer.selectedId, () => { layer.selectedId = d.id; layer.changed(); }));
    }
    if (!layer.drawings.length) sections.push(h('div', { class: 'empty' }, 'No drawings on this symbol.'));
    this.body.replaceChildren(h('div', { class: 'widget objects' }, h('div', { class: 'widget-head' }, h('h2', {}, 'Object tree')), ...sections));
  }
}

// ======================= Bottom panel =======================
export class BottomPanel {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.tab = store.get('bottomTab', 'trading');
    this.open = store.get('bottomOpen', false);
    this.tradeTab = 'positions';
    this.side = 'buy';
    this.orderType = 'market';
    this.btResult = null;
    this.btConfig = store.get('btConfig', { strategy: 'ma_cross', params: {}, capital: 10000, sizePct: 100, commission: 0.1, direction: 'long', slPct: 0, tpPct: 0, showOnChart: true });
    this.head = root.querySelector('.bottom-head');
    this.body = root.querySelector('.bottom-body');
    this.renderHead();
    this.applyOpen();
    app.broker.on('change', () => this.refreshTrading());
    let lastTick = 0;
    app.broker.on('tick', () => {
      const now = performance.now();
      if (now - lastTick < 250) return;
      lastTick = now;
      this.refreshTrading(true);
    });
    this.render();
  }

  renderHead() {
    const tabs = [['trading', 'Paper trading'], ['tester', 'Strategy tester']];
    this.head.replaceChildren(
      ...tabs.map(([id, text]) => h('button', { type: 'button', class: `bottom-tab${this.tab === id && this.open ? ' active' : ''}`, onclick: () => this.select(id) }, text)),
      h('span', { class: 'spacer' }),
      h('span', { class: 'account-mini' }),
      h('button', { type: 'button', class: 'icon-btn', title: this.open ? 'Collapse panel' : 'Expand panel', 'aria-label': this.open ? 'Collapse panel' : 'Expand panel', onclick: () => this.toggle() }, this.open ? '▾' : '▴'));
    this.updateAccountMini();
  }

  select(tab) {
    if (this.tab === tab && this.open) this.open = false;
    else {
      this.tab = tab;
      this.open = true;
    }
    store.set('bottomTab', this.tab);
    store.set('bottomOpen', this.open);
    this.applyOpen();
    this.renderHead();
    this.render();
  }

  toggle() {
    this.open = !this.open;
    store.set('bottomOpen', this.open);
    this.applyOpen();
    this.renderHead();
    this.render();
  }

  applyOpen() {
    this.root.classList.toggle('open', this.open);
  }

  render() {
    this.equityChart?.remove();
    this.equityChart = null;
    this.ticketEl = null;
    this.accountEl = null;
    this.resultsEl = null;
    this.testerTarget = null;
    if (!this.open) {
      this.body.replaceChildren();
      return;
    }
    if (this.tab === 'tester') this.renderTester();
    else this.renderTrading();
  }

  onActiveSymbol() {
    if (!this.open) return;
    if (this.tab === 'trading') this.renderTicket();
    else this.renderTesterTarget();
  }

  updateAccountMini() {
    const el = this.head.querySelector('.account-mini');
    if (!el) return;
    const b = this.app.broker;
    const eq = b.equity();
    const upnl = eq - b.state.balance;
    el.innerHTML = `Paper equity <b>${formatPrice(eq, 2)}</b> · Open P&L <b class="${signClass(upnl)}">${upnl >= 0 ? '+' : ''}${formatPrice(upnl, 2)}</b>`;
  }

  // ---------- Paper trading ----------
  renderTrading() {
    this.ticketEl = h('div', { class: 'ticket' });
    this.accountEl = h('div', { class: 'account' });
    this.tableEl = h('div', { class: 'trade-table' });
    this.body.replaceChildren(h('div', { class: 'trading' }, this.ticketEl, h('div', { class: 'trading-main' }, this.accountEl, this.tableEl)));
    this.renderTicket();
    this.refreshTrading();
  }

  renderTicket() {
    if (!this.ticketEl) return;
    const b = this.app.broker;
    const symbol = this.app.activePane?.symbol ?? 'BTCUSDT';
    const info = this.app.symbolInfo(symbol);
    const digits = info ? tickDigits(info.tick) : undefined;
    const q = b.quote(symbol);
    const qty = h('input', { type: 'number', step: 'any', min: '0', value: store.get(`qty.${symbol}`, q.last ? +(1000 / q.last).toPrecision(3) : 1), 'aria-label': 'Quantity' });
    const price = h('input', { type: 'number', step: 'any', value: q.last ? q.last.toFixed(digits ?? 2) : '', 'aria-label': 'Order price' });
    const tp = h('input', { type: 'number', step: 'any', placeholder: 'optional', 'aria-label': 'Take profit price' });
    const sl = h('input', { type: 'number', step: 'any', placeholder: 'optional', 'aria-label': 'Stop loss price' });
    const preview = h('div', { class: 'ticket-preview' });
    const submit = h('button', { type: 'submit', class: `btn wide ${this.side}` }, `${this.side === 'buy' ? 'Buy' : 'Sell'} ${info?.base ?? symbol}${this.orderType === 'market' ? ' at market' : ` ${this.orderType}`}`);
    const order = () => ({
      symbol, side: this.side, type: this.orderType, qty: Number(qty.value), price: Number(price.value), tp: Number(tp.value) || null, sl: Number(sl.value) || null,
    });
    const refPrice = () => (this.orderType === 'market' ? b.fillPrice(symbol, this.side) : Number(price.value));
    const updatePreview = () => {
      const o = order();
      const px = refPrice();
      const notional = px * o.qty;
      const lev = b.state.leverage;
      const err = b.validate(o);
      const max = b.maxQty(symbol, this.side, px);
      const riskLine = o.sl && px ? `Risk to SL ${formatPrice(Math.abs(px - o.sl) * o.qty, 2)} USDT` : '';
      const rewardLine = o.tp && px ? `Reward to TP ${formatPrice(Math.abs(o.tp - px) * o.qty, 2)} USDT` : '';
      preview.innerHTML = `
        <div><span>${this.orderType === 'market' ? (this.side === 'buy' ? 'Ask' : 'Bid') : 'Price'}</span><b>${Number.isFinite(px) ? formatPrice(px, digits) : '—'}</b></div>
        <div><span>Order value</span><b>${Number.isFinite(notional) ? formatPrice(notional, 2) : '—'}</b></div>
        <div><span>Margin (${lev}x) + fee</span><b>${Number.isFinite(notional) ? formatPrice(notional / lev + notional * 0.001, 2) : '—'}</b></div>
        <div><span>Max quantity</span><b>${Number.isFinite(max) ? +max.toPrecision(6) : '—'}</b></div>
        ${riskLine || rewardLine ? `<div class="full"><span>${escapeHtml([riskLine, rewardLine].filter(Boolean).join(' · '))}</span></div>` : ''}
        ${err ? `<div class="full error">${escapeHtml(err)}</div>` : ''}`;
      submit.disabled = Boolean(err);
    };
    for (const el of [qty, price, tp, sl]) el.addEventListener('input', updatePreview);
    const sideBtn = (s, text) => h('button', { type: 'button', class: `side-btn ${s}${this.side === s ? ' active' : ''}`, onclick: () => { this.side = s; this.renderTicket(); } }, text);
    const typeBtn = (t) => h('button', { type: 'button', class: `seg${this.orderType === t ? ' active' : ''}`, onclick: () => { this.orderType = t; this.renderTicket(); } }, t[0].toUpperCase() + t.slice(1));
    const pctBtns = [10, 25, 50, 100].map((pct) => h('button', {
      type: 'button',
      class: 'seg small',
      title: `${pct}% of buying power`,
      onclick: () => {
        const max = b.maxQty(symbol, this.side, refPrice());
        if (!(max > 0)) return;
        const step = 10 ** -6;
        qty.value = String(Math.floor(((max * pct) / 100) / step) * step);
        updatePreview();
      },
    }, `${pct}%`));
    const lev = h('select', { 'aria-label': 'Leverage' }, ...[1, 2, 3, 5, 10, 20, 50, 100].map((v) => h('option', { value: v, selected: b.state.leverage === v }, `${v}x`)));
    lev.addEventListener('change', () => { b.setLeverage(Number(lev.value)); updatePreview(); });
    const form = h('form', { class: 'ticket-form' },
      h('div', { class: 'ticket-title' }, h('b', {}, symbol), h('label', { class: 'lev' }, h('span', { class: 'muted' }, 'Leverage'), lev)),
      h('div', { class: 'side-toggle' },
        sideBtn('sell', `Sell ${Number.isFinite(q.bid) ? formatPrice(q.bid, digits) : ''}`),
        sideBtn('buy', `Buy ${Number.isFinite(q.ask) ? formatPrice(q.ask, digits) : ''}`)),
      h('div', { class: 'segmented' }, typeBtn('market'), typeBtn('limit'), typeBtn('stop')),
      this.orderType !== 'market' ? h('label', { class: 'field' }, h('span', {}, `${this.orderType === 'limit' ? 'Limit' : 'Stop'} price`), price) : null,
      h('label', { class: 'field' }, h('span', {}, `Quantity (${info?.base ?? symbol.replace(/(USDT|USDC|FDUSD|BTC|ETH)$/, '')})`), qty),
      h('div', { class: 'segmented' }, ...pctBtns),
      h('div', { class: 'field-row' }, h('label', { class: 'field' }, h('span', {}, 'Take profit'), tp), h('label', { class: 'field' }, h('span', {}, 'Stop loss'), sl)),
      preview,
      submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const o = order();
      store.set(`qty.${symbol}`, o.qty);
      if (b.placeOrder(o)) {
        tp.value = '';
        sl.value = '';
      }
      updatePreview();
    });
    updatePreview();
    this.ticketEl.replaceChildren(form);
  }

  refreshTrading(tickOnly = false) {
    this.updateAccountMini();
    if (!tickOnly) this.app.refreshAllOverlays();
    if (!this.open || this.tab !== 'trading' || !this.accountEl) return;
    const b = this.app.broker;
    const s = b.state;
    const eq = b.equity();
    const upnl = eq - s.balance;
    const st = b.stats();
    const cell = (label, value, cls = '') => `<div><span>${label}</span><b class="${cls}">${value}</b></div>`;
    const money = (v) => `${v >= 0 ? '+' : ''}${formatPrice(v, 2)}`;
    this.accountEl.innerHTML = [
      cell('Balance', formatPrice(s.balance, 2)),
      cell('Equity', formatPrice(eq, 2)),
      cell('Open P&L', money(upnl), signClass(upnl)),
      cell('Used margin', formatPrice(b.usedMargin(), 2)),
      cell('Buying power', formatPrice(b.available() * s.leverage, 2)),
      cell('Realized P&L', money(st.realized), signClass(st.realized)),
      cell('Fees paid', formatPrice(st.fees, 2)),
      cell('Win rate', `${st.winRate.toFixed(1)}% <small>${st.trades} trades</small>`),
      cell('Profit factor', Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : '∞'),
    ].join('');
    if (tickOnly && (this.tradeTab === 'history' || this.tableEl.contains(document.activeElement))) return;
    const tabs = h('div', { class: 'table-tabs' },
      ...[['positions', `Positions (${s.positions.length})`], ['orders', `Orders (${s.orders.length})`], ['history', `History (${s.history.length})`]]
        .map(([id, text]) => h('button', { type: 'button', class: `seg${this.tradeTab === id ? ' active' : ''}`, onclick: () => { this.tradeTab = id; this.refreshTrading(); } }, text)),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small storage-note', title: 'Closed trades are appended to data/paper/trades.csv; the account is saved to data/paper/account.json' },
        b.serverOk ? '💾 Saved to data/paper/' : b.serverOk === false ? '⚠ Saved in this browser only' : ''),
      this.tradeTab === 'positions' && s.positions.length ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => b.closeAll() }, 'Close all') : null,
      this.tradeTab === 'history' && s.history.length ? h('button', {
        type: 'button',
        class: 'btn small ghost',
        onclick: () => {
          const blob = new Blob([b.exportCsv()], { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = h('a', { href: url, download: `paper-trades-${new Date().toISOString().slice(0, 10)}.csv` });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        },
      }, 'Export CSV') : null,
      h('button', {
        type: 'button',
        class: 'btn small ghost',
        onclick: () => {
          const v = prompt('Reset the paper account. Starting balance (USDT):', '100000');
          if (v === null) return;
          const n = Number(v);
          if (!(n > 0)) {
            toast('Enter a positive balance', 'error');
            return;
          }
          b.reset(n);
        },
      }, 'Reset account'));
    const sideCell = (side, label) => `<span class="${side === 'buy' ? 'up' : 'down'}">${label ?? (side === 'buy' ? 'LONG' : 'SHORT')}</span>`;
    const dur = (ms) => {
      const m = Math.round(ms / 60000);
      return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
    };
    let table;
    if (this.tradeTab === 'orders') {
      table = this.table(['Symbol', 'Side', 'Type', 'Qty', 'Price', 'Last', 'TP', 'SL', 'Placed', ''], s.orders.map((o) => [
        `<a href="#" data-goto="${escapeHtml(o.symbol)}">${escapeHtml(o.symbol)}</a>`, sideCell(o.side, o.side.toUpperCase()), o.type, o.qty,
        { input: o.price, fn: (v) => b.modifyOrder(o.id, { price: v }) }, b.price(o.symbol) ? formatPrice(b.price(o.symbol)) : '—',
        o.tp ? formatPrice(o.tp) : '—', o.sl ? formatPrice(o.sl) : '—', fmtTime(o.created, true),
        { btn: 'Cancel', fn: () => b.cancel(o.id) },
      ]), 'No working orders');
    } else if (this.tradeTab === 'history') {
      table = this.table(
        ['Closed', 'Symbol', 'Side', 'Qty', 'Entry', 'Exit', 'Exit reason', 'Gross P&L', 'Fees', 'Net P&L', 'Return %', 'Run-up', 'Drawdown', 'Held'],
        s.history.map((t) => [
          fmtTime(t.closed, true), `<a href="#" data-goto="${escapeHtml(t.symbol)}" data-time="${Math.floor(t.opened / 1000)}">${escapeHtml(t.symbol)}</a>`, sideCell(t.side), t.qty,
          `${formatPrice(t.entry)}<small class="muted"> ${fmtTime(t.opened, true)}</small>`, formatPrice(t.exit), escapeHtml(t.reason),
          `<span class="${signClass(t.gross)}">${money(t.gross)}</span>`, formatPrice(t.fees, 2),
          `<b class="${signClass(t.pnl)}">${money(t.pnl)}</b>`, `<span class="${signClass(t.returnPct)}">${formatPct(t.returnPct)}</span>`,
          formatPrice(t.runUp ?? 0, 2), formatPrice(t.drawdown ?? 0, 2), dur(t.closed - t.opened),
        ]),
        'No closed trades yet. Net P&L = gross P&L − entry fee − exit fee (0.1% each side).',
      );
    } else {
      table = this.table(['Symbol', 'Side', 'Qty', 'Entry', 'Mark', 'Open P&L', 'Return %', 'Margin', 'Liq. price', 'TP', 'SL', ''], s.positions.map((p) => {
        const mark = b.fillPrice(p.symbol, p.side === 'buy' ? 'sell' : 'buy');
        const pnl = b.unrealized(p);
        const pct = p.margin ? (pnl / p.margin) * 100 : 0;
        return [
          `<a href="#" data-goto="${escapeHtml(p.symbol)}">${escapeHtml(p.symbol)}</a>`, sideCell(p.side), +p.qty.toFixed(8), formatPrice(p.entry), Number.isFinite(mark) ? formatPrice(mark) : '—',
          `<b class="${signClass(pnl)}">${money(pnl)}</b>`, `<span class="${signClass(pct)}">${formatPct(pct)}</span>`, formatPrice(p.margin, 2),
          p.leverage > 1 ? formatPrice(b.liqPrice(p)) : '—',
          { input: p.tp, fn: (v) => b.updatePosition(p.id, { tp: v || null }) },
          { input: p.sl, fn: (v) => b.updatePosition(p.id, { sl: v || null }) },
          { btn: 'Close', fn: () => b.close(p.id) },
        ];
      }), 'No open positions. Use the order ticket, or the Sell/Buy buttons on the chart.');
    }
    this.tableEl.replaceChildren(tabs, table);
  }

  table(headers, rows, emptyText) {
    const tbl = h('table', {}, h('thead', {}, h('tr', {}, ...headers.map((x) => h('th', {}, x)))));
    const tbody = h('tbody');
    if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: headers.length, class: 'empty' }, emptyText)));
    for (const r of rows) {
      const tr = h('tr');
      for (const cell of r) {
        const td = h('td');
        if (cell && typeof cell === 'object' && cell.btn) td.append(h('button', { type: 'button', class: 'btn small ghost', onclick: cell.fn }, cell.btn));
        else if (cell && typeof cell === 'object' && 'input' in cell) {
          const input = h('input', { type: 'number', step: 'any', class: 'cell-input', value: cell.input ?? '', placeholder: '—' });
          input.addEventListener('change', () => cell.fn(Number(input.value)));
          td.append(input);
        } else td.innerHTML = String(cell);
        tr.append(td);
      }
      tbody.append(tr);
    }
    tbl.append(tbody);
    tbl.addEventListener('click', (event) => {
      const a = event.target.closest('[data-goto]');
      if (!a) return;
      event.preventDefault();
      const pane = this.app.activePane;
      if (!pane) return;
      const t = Number(a.dataset.time);
      const same = pane.symbol === a.dataset.goto;
      if (!same) pane.setSymbol(a.dataset.goto);
      if (t) setTimeout(() => pane.goToDate(t), same ? 0 : 1500);
    });
    return h('div', { class: 'table-wrap' }, tbl);
  }

  // ---------- Strategy tester ----------
  renderTester() {
    const cfg = this.btConfig;
    const strategy = STRATEGIES.find((s) => s.id === cfg.strategy) ?? STRATEGIES[0];
    const params = { ...strategy.inputs, ...(cfg.strategy === strategy.id ? cfg.params : {}) };
    const select = h('select', {}, ...STRATEGIES.map((s) => h('option', { value: s.id, selected: s.id === strategy.id }, s.name)));
    select.addEventListener('change', () => {
      // Custom-indicator strategies pick their own side, so they default to long & short.
      const picked = STRATEGIES.find((x) => x.id === select.value);
      this.btConfig = { ...cfg, strategy: select.value, params: {}, ...(picked?.custom ? { direction: 'both' } : {}) };
      store.set('btConfig', this.btConfig);
      this.renderTester();
    });
    const specs = strategy.paramSpecs ?? Object.keys(strategy.inputs).map((key) => ({ key, label: key.replace(/([A-Z])/g, ' $1') }));
    const paramInputs = specs.map((spec) => {
      const key = spec.key;
      if (spec.toggle) return h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: params[key] === 1, 'data-key': key, 'data-toggle': '1' }), h('span', {}, spec.label));
      if (spec.options) return h('label', { class: 'field' }, h('span', {}, spec.label), h('select', { 'data-key': key }, ...spec.options.map((o) => h('option', { value: o.value, selected: o.value === params[key] }, o.label))));
      return h('label', { class: 'field' }, h('span', {}, spec.label), h('input', { type: 'number', step: spec.step ?? 'any', min: spec.min, max: spec.max, value: params[key], 'data-key': key }));
    });
    const num = (key, text) => h('label', { class: 'field' }, h('span', {}, text), h('input', { type: 'number', step: 'any', value: cfg[key], 'data-opt': key }));
    const direction = h('select', { 'data-opt': 'direction' }, ...[['long', 'Long only'], ['short', 'Short only'], ['both', 'Long & short']].map(([v, l]) => h('option', { value: v, selected: cfg.direction === v }, l)));
    const show = h('input', { type: 'checkbox', checked: cfg.showOnChart });
    this.testerTarget = h('div', { class: 'tester-target' });
    const form = h('form', { class: 'tester-form' },
      h('label', { class: 'field' }, h('span', {}, 'Strategy'), select),
      strategy.custom ? h('div', { class: 'muted small' }, 'Trades come from the custom indicator itself (its entries, stops and targets); the stop loss / take profit % below do not apply.') : null,
      h('div', { class: `field-grid${strategy.custom ? ' custom-params' : ''}` }, ...paramInputs),
      h('div', { class: 'form-section' }, 'Properties'),
      h('div', { class: 'field-grid' },
        num('capital', 'Initial capital'), num('sizePct', 'Order size % equity'), num('commission', 'Commission %'),
        h('label', { class: 'field' }, h('span', {}, 'Direction'), direction),
        num('slPct', 'Stop loss %'), num('tpPct', 'Take profit %')),
      h('label', { class: 'check' }, show, h('span', {}, 'Show trades on chart')),
      this.testerTarget,
      h('button', { type: 'submit', class: 'btn primary wide' }, '▶ Run backtest'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const p = {};
      form.querySelectorAll('[data-key]').forEach((el) => { p[el.dataset.key] = el.dataset.toggle ? (el.checked ? 1 : 0) : Number(el.value); });
      const next = { ...this.btConfig, strategy: strategy.id, params: p, showOnChart: show.checked };
      form.querySelectorAll('[data-opt]').forEach((el) => { next[el.dataset.opt] = el.tagName === 'SELECT' ? el.value : Number(el.value); });
      this.btConfig = next;
      store.set('btConfig', next);
      this.runTest();
    });
    this.resultsEl = h('div', { class: 'tester-results' });
    this.body.replaceChildren(h('div', { class: 'tester' }, form, this.resultsEl));
    this.renderTesterTarget();
    this.renderResults();
  }

  renderTesterTarget() {
    const pane = this.app.activePane;
    if (!this.testerTarget || !pane) return;
    this.testerTarget.textContent = `Runs on ${pane.symbol} · ${intervalLabel(pane.interval)} · ${pane.displayCandles().length.toLocaleString()} bars loaded (scroll the chart left to load more history)`;
  }

  async runTest() {
    const pane = this.app.activePane;
    if (!pane || pane.displayCandles().length < 50) return;
    const cfg = this.btConfig;
    const strategy = STRATEGIES.find((s) => s.id === cfg.strategy) ?? STRATEGIES[0];
    const params = { ...strategy.inputs, ...cfg.params };
    const candles = pane.displayCandles();
    let opts = cfg;
    if (strategy.tradeList) {
      try {
        opts = { ...cfg, tradeList: await strategy.tradeList(candles, params, pane.candlContext()) };
      } catch (error) {
        toast(`${strategy.name} failed: ${error.message}`, 'error');
        return;
      }
    }
    const result = runBacktest(candles, strategy, params, opts);
    this.btResult = { ...result, symbol: pane.symbol, interval: pane.interval, strategy: strategy.name, from: candles[0].time, to: candles.at(-1).time };
    this.btPane = pane;
    if (cfg.showOnChart) {
      const markers = [];
      for (const t of result.trades) {
        markers.push({ time: t.entryTime, position: t.dir === 1 ? 'belowBar' : 'aboveBar', color: t.dir === 1 ? '#2962ff' : '#e91e63', shape: t.dir === 1 ? 'arrowUp' : 'arrowDown', text: t.dir === 1 ? 'Long' : 'Short' });
        markers.push({ time: t.exitTime, position: t.dir === 1 ? 'aboveBar' : 'belowBar', color: t.pnl >= 0 ? '#26a69a' : '#ef5350', shape: 'circle', text: `${t.pnl >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%` });
      }
      markers.sort((a, b) => a.time - b.time);
      pane.setMarkers(markers);
    } else pane.setMarkers([]);
    this.renderResults();
  }

  renderResults() {
    if (!this.resultsEl) return;
    this.equityChart?.remove();
    this.equityChart = null;
    const r = this.btResult;
    if (!r) {
      this.resultsEl.innerHTML = '<div class="empty big">Pick a strategy and run it on the active chart. Performance stats, the equity curve and every trade appear here.</div>';
      return;
    }
    const s = r.stats;
    const stat = (text, value, cls = '') => `<div class="stat"><span>${text}</span><b class="${cls}">${value}</b></div>`;
    const money = (v) => `${v >= 0 ? '+' : ''}${formatPrice(v, 2)}`;
    const statsHtml = `<div class="stats">
        ${stat('Net profit', `${money(s.net)} <small>${formatPct(s.netPct)}</small>`, signClass(s.net))}
        ${stat('Total trades', `${s.total} <small>${s.longs}L / ${s.shorts}S</small>`)}
        ${stat('Win rate', `${s.winRate.toFixed(1)}%`)}
        ${stat('Profit factor', Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞')}
        ${stat('Max drawdown', `${formatPrice(s.maxDD, 2)} <small>${s.maxDDPct.toFixed(2)}%</small>`, 'down')}
        ${stat('Avg trade', money(s.avgTrade), signClass(s.avgTrade))}
        ${stat('Avg bars in trade', s.avgBars.toFixed(1))}
        ${stat('Buy & hold', formatPct(s.buyHoldPct), signClass(s.buyHoldPct))}
      </div>`;
    const head = h('div', { class: 'results-head' },
      h('b', {}, `${r.strategy} · ${r.symbol} ${intervalLabel(r.interval)}`),
      h('span', { class: 'muted' }, `${this.app.timeFormatter.full(r.from)} → ${this.app.timeFormatter.full(r.to)}`),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => this.btPane?.setMarkers([]) }, 'Clear chart markers'));
    const equityEl = h('div', { class: 'equity-chart' });
    const trades = r.trades.slice().reverse();
    const list = this.table(['#', 'Type', 'Entry', 'Entry price', 'Exit', 'Exit price', 'P&L', 'P&L %', 'Bars', 'Exit reason'], trades.map((t, i) => [
      trades.length - i,
      `<span class="${t.dir === 1 ? 'up' : 'down'}">${t.dir === 1 ? 'Long' : 'Short'}</span>`,
      this.app.timeFormatter.full(t.entryTime), formatPrice(t.entryPrice), this.app.timeFormatter.full(t.exitTime), formatPrice(t.exitPrice),
      `<b class="${signClass(t.pnl)}">${money(t.pnl)}</b>`, `<span class="${signClass(t.pnlPct)}">${formatPct(t.pnlPct)}</span>`, t.bars, t.reason,
    ]), 'No trades were generated with these settings.');
    list.classList.add('trade-list');
    list.title = 'Click a trade to scroll the chart to it';
    list.addEventListener('click', (event) => {
      const row = event.target.closest('tbody tr');
      if (!row || !this.btPane) return;
      const t = trades[[...row.parentElement.children].indexOf(row)];
      if (!t) return;
      const candles = this.btPane.displayCandles();
      const i = lowerBound(candles, t.entryTime, (c) => c.time);
      this.btPane.chart.timeScale().setVisibleLogicalRange({ from: i - 40, to: i + t.bars + 40 });
    });
    this.resultsEl.replaceChildren(head, h('div', { html: statsHtml }), h('div', { class: 'results-split' }, equityEl, list));
    const colors = this.app.themeColors();
    this.equityChart = createChart(equityEl, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: colors.text, attributionLogo: false, fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      handleScroll: false,
      handleScale: false,
    });
    const up = s.net >= 0;
    this.equityChart.addSeries(AreaSeries, {
      lineColor: up ? '#26a69a' : '#ef5350',
      topColor: up ? 'rgba(38,166,154,.35)' : 'rgba(239,83,80,.35)',
      bottomColor: 'rgba(0,0,0,0)',
      lineWidth: 2,
      priceLineVisible: false,
    }).setData(r.equity);
    this.equityChart.timeScale().fitContent();
  }
}
