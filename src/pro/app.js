// App shell: toolbars, layout grid, dialogs, keyboard shortcuts, and coordination between panes,
// the sidebar, the bottom panel and the alert/paper-trading services.

import { PriceScaleMode } from 'lightweight-charts';
import { fetchSymbols, hub, startTickerFeed, tickDigits, tickers } from './binance.js';
import { GROUPS, TOOLS, toolById, withAlpha } from './drawtools.js';
import { CHART_TYPE_DEFAULTS } from './charttypes.js';
import { openOptionChain } from './optionchain.js';
import { optionTitle, parseSymbol, PROVIDER_INFO, PROVIDERS } from './providers.js';
import { CHART_DEFAULTS, openChartSettings } from './drawui.js';
import { INDICATORS } from './indicators.js';
import { CHART_TYPES, ChartPane } from './pane.js';
import { BottomPanel, Sidebar } from './panels.js';
import { ALERT_CONDITIONS, AlertManager, PaperBroker } from './services.js';
import {
  closeMenus, debounce, downloadCanvas, escapeHtml, FAVORITE_INTERVALS, formatCompact, formatPct, formatPrice, h, INTERVALS, intervalLabel,
  modal, showMenu, signClass, store, toast,
} from './util.js';

const GRIDS = [
  { id: '1', label: 'Single chart', count: 1, icon: '▢' },
  { id: '2v', label: '2 charts · side by side', count: 2, icon: '◫' },
  { id: '2h', label: '2 charts · stacked', count: 2, icon: '⊟' },
  { id: '3', label: '3 charts', count: 3, icon: '◰' },
  { id: '4', label: '4 charts · grid', count: 4, icon: '⊞' },
];

const TIMEZONES = [
  { id: 'local', label: 'Local time' },
  { id: 'UTC', label: 'UTC' },
  { id: 'America/New_York', label: 'New York' },
  { id: 'Europe/London', label: 'London' },
  { id: 'Asia/Kolkata', label: 'Kolkata' },
  { id: 'Asia/Singapore', label: 'Singapore' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
];

const RANGES = [
  { label: '1D', span: 86400 },
  { label: '5D', span: 5 * 86400 },
  { label: '1M', span: 30 * 86400 },
  { label: '3M', span: 90 * 86400 },
  { label: '6M', span: 180 * 86400 },
  { label: 'YTD', span: 'ytd' },
  { label: '1Y', span: 365 * 86400 },
  { label: 'All', span: 'all' },
];

const DEFAULT_SETTINGS = {
  ...CHART_DEFAULTS,
  ...CHART_TYPE_DEFAULTS,
  theme: 'dark',
  tz: 'local',
  showVolume: true,
  grid: true,
  magnetCrosshair: false,
  syncCrosshair: true,
  syncSymbol: false,
  syncInterval: false,
};

const SHORTCUTS = [
  ['Type any letter', 'Symbol search'],
  ['Type a number', 'Change interval (e.g. 15, 60, 4h, 1d)'],
  ['/', 'Indicators'],
  ['Alt + A', 'Create alert at last price'],
  ['Alt + T / H / V / F / R', 'Trend line / Horizontal / Vertical / Fib / Rectangle'],
  ['Shift + click & drag', 'Quick measure (date and price range)'],
  ['Esc', 'Cancel drawing, finish a path, deselect, exit tool'],
  ['Enter / double-click', 'Finish a path or polyline'],
  ['Del / Backspace', 'Delete selected drawing'],
  ['Ctrl/⌘ + C, Ctrl/⌘ + V', 'Copy / paste the selected drawing'],
  ['Double-click a drawing', 'Open its settings (or edit text)'],
  ['Ctrl/⌘ + Z', 'Undo drawing change'],
  ['Ctrl/⌘ + Shift + Z, Ctrl + Y', 'Redo'],
  ['Alt + S', 'Save chart screenshot'],
  ['Alt + L', 'Toggle log scale'],
  ['Space', 'Replay: play / pause'],
  ['Shift + →  /  Shift + ←', 'Replay: step forward / back'],
  ['Double-click text', 'Edit text drawing'],
  ['Right-click chart', 'Chart menu (alerts, orders, lines)'],
  ['?', 'This list'],
];

function makeTimeFormatter(tz) {
  const zone = tz === 'local' ? undefined : tz;
  const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, ...opts });
  const year = fmt({ year: 'numeric' });
  const month = fmt({ month: 'short' });
  const day = fmt({ day: 'numeric' });
  const time = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
  const timeSec = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const full = fmt({ weekday: 'short', day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return {
    tick(t, type) {
      const d = new Date(t * 1000);
      switch (type) {
        case 0: return year.format(d);
        case 1: return month.format(d);
        case 2: return day.format(d);
        case 4: return timeSec.format(d);
        default: return time.format(d);
      }
    },
    full: (t) => full.format(new Date(t * 1000)).replace(',', ''),
    clock: () => timeSec.format(new Date()),
  };
}

export class App {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
    this.theme = this.settings.theme;
    this.timeFormatter = makeTimeFormatter(this.settings.tz);
    this.symbols = new Map();
    this.panes = [];
    this.activePane = null;
    this.tool = 'cross';
    this.groupTool = store.get('groupTool', {});
    this.favTools = store.get('favTools', []);
    this.hubStatus = 'connecting';
    this.alerts = new AlertManager();
    this.broker = new PaperBroker();
    this.saveLayout = debounce(() => this.persistLayout(), 300);
    this.dom = {
      topbar: document.querySelector('#topbar'),
      toolbar: document.querySelector('#draw-toolbar'),
      grid: document.querySelector('#chart-grid'),
      rangeBar: document.querySelector('#range-bar'),
      replayBar: document.querySelector('#replay-bar'),
    };
  }

  start() {
    document.documentElement.dataset.theme = this.theme;
    document.documentElement.classList.toggle('glass', this.settings.glass !== false);
    this.alerts.soundEnabled = this.settings.alertSound !== false;
    startTickerFeed();
    hub.onStatus((status) => {
      this.hubStatus = status;
      const el = document.querySelector('#stream-status');
      if (el) {
        el.className = `stream-status ${status}`;
        el.title = `Market stream: ${status}`;
        el.querySelector('span').textContent = status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Reconnecting';
      }
    });
    fetchSymbols().then((list) => {
      for (const s of list) this.symbols.set(s.symbol, s);
      for (const pane of this.panes) {
        pane.main.applyOptions({ priceFormat: pane.priceFormat() });
        pane.renderLegend();
      }
      this.renderTopbar();
      this.sidebar?.onActiveSymbol();
    }).catch((error) => toast(`Could not load the Binance symbol list: ${error.message}`, 'error'));

    this.renderTopbar();
    this.renderToolbar();
    this.renderRangeBar();
    this.layouts = store.get('layouts', null);
    if (!this.layouts) {
      const legacy = store.get('layout', null);
      this.layouts = { main: { name: 'My layout', ...(legacy ?? {}), updated: Date.now() } };
      store.set('layouts', this.layouts);
      store.set('currentLayout', 'main');
    }
    this.layoutId = this.layouts[store.get('currentLayout', 'main')] ? store.get('currentLayout', 'main') : Object.keys(this.layouts)[0];
    this.autosave = store.get('layoutAutosave', true);
    const layout = this.layouts[this.layoutId];
    this.gridId = layout?.grid ?? '1';
    const configs = layout?.panes?.length
      ? layout.panes
      : [{ symbol: 'BTCUSDT', interval: '1h', type: 'candles', indicators: [{ id: 'ema', params: { length: 21 } }, { id: 'vwap' }] }];
    this.buildPanes(configs, layout?.active ?? 0);
    this.sidebar = new Sidebar(this, document.querySelector('#sidebar'));
    this.bottom = new BottomPanel(this, document.querySelector('#bottom-panel'));
    this.alerts.on('change', () => this.refreshAllOverlays());
    // Live P&L labels / bid-ask panel: repaint panes for the symbol that moved, once per frame.
    let pendingPaint = new Set();
    const paint = () => {
      const syms = pendingPaint;
      pendingPaint = new Set();
      for (const pane of this.panes) {
        if (!syms.has(pane.symbol) && !syms.has('*')) continue;
        pane.trade?.refreshPanel();
        pane.drawings.requestUpdate?.();
      }
    };
    const queue = (sym) => {
      if (!pendingPaint.size) requestAnimationFrame(paint);
      pendingPaint.add(sym);
    };
    this.broker.on('quote', queue);
    this.broker.on('tick', () => queue('*'));
    this.broker.on('change', () => queue('*'));
    this.syncBrokerWatch();
    this.bindKeyboard();
    this.setupResponsive();
    setInterval(() => this.tickClock(), 1000);
    setInterval(() => this.renderSymbolChange(), 2000);
    this.tickClock();
  }

  // ----- theme & settings -----
  themeColors() {
    const dark = this.theme !== 'light';
    return {
      bg: dark ? '#0f0f0f' : '#ffffff',
      text: dark ? '#b8b8b8' : '#4a5568',
      grid: dark ? 'rgba(242,242,242,.06)' : 'rgba(224,227,235,.8)',
      border: dark ? '#2e2e2e' : '#e0e3eb',
      hover: dark ? 'rgba(41,98,255,.3)' : 'rgba(41,98,255,.2)',
      crosshair: dark ? '#6b7385' : '#9598a1',
      label: dark ? '#363a45' : '#4a5568',
      up: this.settings.upColor,
      down: this.settings.downColor,
      volUp: withAlpha(this.settings.upColor, 0.35),
      volDown: withAlpha(this.settings.downColor, 0.35),
      accent: '#2962ff',
      alert: '#f5a623',
      levels: dark ? 'rgba(138,147,166,.45)' : 'rgba(74,85,104,.35)',
    };
  }

  saveSettings() {
    store.set('settings', this.settings);
  }

  setTheme(theme) {
    this.theme = theme;
    this.settings.theme = theme;
    this.saveSettings();
    document.documentElement.dataset.theme = theme;
    for (const pane of this.panes) pane.applyTheme();
    this.renderTopbar();
    if (this.bottom?.open && this.bottom.tab === 'tester') this.bottom.renderResults();
  }

  applyChartSettings() {
    if (this.settings.theme && this.settings.theme !== this.theme) {
      this.setTheme(this.settings.theme);
    }
    document.documentElement.classList.toggle('glass', this.settings.glass !== false);
    this.alerts.soundEnabled = this.settings.alertSound !== false;
    this.timeFormatter = makeTimeFormatter(this.settings.tz);
    for (const pane of this.panes) pane.applyTheme();
    this.saveSettings();
    this.tickClock();
  }

  symbolInfo(symbol) { return this.symbols.get(symbol); }

  // ----- layout -----
  buildPanes(configs, activeIndex = 0) {
    for (const pane of this.panes) pane.destroy();
    this.panes = [];
    const grid = GRIDS.find((g) => g.id === this.gridId) ?? GRIDS[0];
    this.dom.grid.className = `chart-grid grid-${grid.id}`;
    const base = configs[0];
    const spareIntervals = ['15m', '4h', '1d', '5m', '1w'];
    for (let i = 0; i < grid.count; i++) {
      let cfg = configs[i];
      if (!cfg) {
        const used = new Set([...configs.map((c) => c.interval), ...this.panes.map((p) => p.interval)]);
        cfg = { symbol: base.symbol, interval: spareIntervals.find((iv) => !used.has(iv)) ?? base.interval, type: base.type };
      }
      this.panes.push(new ChartPane(this, cfg, this.dom.grid));
    }
    this.setActivePane(this.panes[Math.min(activeIndex, this.panes.length - 1)]);
    this.setTool(this.tool);
    this.persistLayout();
  }

  setGrid(id) {
    if (id === this.gridId) return;
    const configs = this.panes.map((p) => p.serialize());
    const activeIndex = this.panes.indexOf(this.activePane);
    this.gridId = id;
    this.buildPanes(configs, activeIndex);
    this.renderTopbar();
  }

  snapshotLayout() {
    return { grid: this.gridId, active: Math.max(0, this.panes.indexOf(this.activePane)), panes: this.panes.map((p) => p.serialize()) };
  }

  persistLayout(force = false) {
    const snap = this.snapshotLayout();
    store.set('layout', snap);
    if (!this.layouts?.[this.layoutId]) return;
    if (this.autosave || force) {
      this.layouts[this.layoutId] = { ...this.layouts[this.layoutId], ...snap, updated: Date.now() };
      store.set('layouts', this.layouts);
      this.layoutDirty = false;
    } else {
      this.layoutDirty = true;
    }
    this.updateLayoutButton?.();
  }

  setActivePane(pane) {
    this.activePane = pane;
    for (const p of this.panes) p.host.classList.toggle('active', p === pane && this.panes.length > 1);
    this.renderTopbar();
    this.renderReplayBar();
    this.updateScaleButtons();
    this.sidebar?.onActiveSymbol();
    this.bottom?.onActiveSymbol();
    this.saveLayout();
  }

  onPaneSymbolChange(pane) {
    this.syncBrokerWatch();
    if (pane === this.activePane) {
      this.renderTopbar();
      this.updateScaleButtons();
      this.sidebar?.onActiveSymbol();
      this.bottom?.onActiveSymbol();
    }
    if (this.syncingSymbol) return;
    this.syncingSymbol = true;
    for (const other of this.panes) {
      if (other === pane) continue;
      if (this.settings.syncSymbol) other.setSymbol(pane.symbol);
      if (this.settings.syncInterval) other.setInterval(pane.interval);
    }
    this.syncingSymbol = false;
  }

  onCrosshair(pane, param) {
    if (pane === this.activePane && this.sidebar?.tab === 'data') this.sidebar.renderData(param);
    if (!this.settings.syncCrosshair || this.panes.length < 2 || this.syncingCrosshair) return;
    // Only propagate real mouse movement (or the mouse leaving the pane that last drove the sync).
    if (!param.sourceEvent && !(param.point === undefined && this.crosshairSource === pane)) return;
    this.crosshairSource = pane;
    this.syncingCrosshair = true;
    for (const other of this.panes) {
      if (other !== pane) other.syncCrosshairTo(param.point ? param.time : null);
    }
    this.syncingCrosshair = false;
  }

  syncBrokerWatch() {
    const extra = (this.sidebar?.watchlist ?? []).filter((sym) => parseSymbol(sym).provider !== 'spot' && !sym.endsWith('.P'));
    this.broker?.watch([...this.panes.map((p) => p.symbol), ...extra]);
  }

  refreshOverlays(pane) {
    pane.setAlertLines(this.alerts.alerts);
    pane.setPositionLines(this.broker.state.positions, this.broker.state.orders);
  }

  refreshAllOverlays() {
    for (const pane of this.panes) this.refreshOverlays(pane);
  }

  emitObjects(pane) {
    if (pane === this.activePane && this.sidebar?.tab === 'objects') this.sidebar.renderObjects();
  }


  // ----- top bar -----
  renderSymbolChange() {
    const el = this.dom.topbar.querySelector('.tb-change');
    const t = this.activePane && tickers.get(this.activePane.symbol);
    if (!el || !t) return;
    const pct = ((t.last - t.open) / t.open) * 100;
    el.className = `tb-change ${signClass(pct)}`;
    el.textContent = formatPct(pct);
  }

  renderTopbar() {
    const pane = this.activePane;
    const bar = this.dom.topbar;
    if (!pane) return;
    const info = this.symbolInfo(pane.symbol);
    const t = tickers.get(pane.symbol);
    const btn = (attrs, ...children) => h('button', { type: 'button', class: 'tb-btn', ...attrs }, ...children);
    const sep = () => h('span', { class: 'tb-sep' });

    const symbolBtn = btn({ class: 'tb-btn symbol-btn', title: 'Symbol search (type any letter)', onclick: () => this.openSymbolSearch() },
      h('span', { class: 'coin' }, (info?.base ?? pane.symbol).slice(0, 1)),
      h('b', {}, pane.symbol),
      h('span', { class: `tb-change ${t ? signClass(t.last - t.open) : ''}` }, t ? formatPct(((t.last - t.open) / t.open) * 100) : ''));
    const compareBtn = btn({ title: 'Compare symbol', 'aria-label': 'Compare symbol', onclick: () => this.openSymbolSearch({ mode: 'compare' }) }, '⊕');

    const favs = FAVORITE_INTERVALS.map((iv) => btn({ class: `tb-btn interval${pane.interval === iv ? ' active' : ''}`, onclick: () => pane.setInterval(iv) }, intervalLabel(iv)));
    const isFav = FAVORITE_INTERVALS.includes(pane.interval);
    const moreIntervals = btn({ class: `tb-btn interval${isFav ? '' : ' active'}`, title: 'All intervals', 'aria-label': 'All intervals' }, isFav ? '▾' : `${intervalLabel(pane.interval)} ▾`);
    moreIntervals.addEventListener('click', () => {
      const items = [];
      let group = null;
      for (const iv of INTERVALS) {
        if (iv.group !== group) {
          items.push({ header: iv.group });
          group = iv.group;
        }
        items.push({ label: iv.label, active: iv.id === pane.interval, action: () => pane.setInterval(iv.id) });
      }
      showMenu(moreIntervals, items, { className: 'interval-menu' });
    });

    const typeDef = CHART_TYPES.find((c) => c.id === pane.type) ?? CHART_TYPES[0];
    const typeBtn = btn({ title: `Chart type: ${typeDef.label}`, 'aria-label': 'Chart type' }, h('span', { class: 'tb-icon' }, typeDef.icon), h('span', { class: 'tb-label' }, typeDef.label), '▾');
    typeBtn.addEventListener('click', () => {
      // Same order and grouping as TradingView's chart type menu.
      const items = [];
      let section = null;
      for (const c of CHART_TYPES) {
        if (section !== null && c.section !== section) items.push('-');
        section = c.section;
        items.push({ label: c.label, icon: c.icon, active: c.id === pane.type, action: () => { pane.setType(c.id); this.renderTopbar(); } });
      }
      items.push('-', { label: 'Chart type settings…', icon: '⚙', action: () => openChartSettings(this, 'symbol') });
      showMenu(typeBtn, items, { className: 'glass-pop chart-type-menu' });
    });

    const indBtn = btn({ title: 'Indicators (/)', onclick: () => this.openIndicators() }, h('span', { class: 'tb-icon' }, 'ƒx'), h('span', { class: 'tb-label' }, 'Indicators'));
    const chainBtn = btn({ title: 'Option chain (Binance & Deribit)', onclick: () => this.openOptionChain() }, h('span', { class: 'tb-icon' }, '⛓'), h('span', { class: 'tb-label' }, 'Options'));
    const alertBtn = btn({ title: 'Create alert (Alt+A)', onclick: () => this.openAlertDialog() }, h('span', { class: 'tb-icon' }, '⏰'), h('span', { class: 'tb-label' }, 'Alert'));
    const replayBtn = btn({ class: `tb-btn${pane.replay ? ' active' : ''}`, title: 'Bar replay', onclick: () => (pane.replay ? pane.exitReplay() : pane.startReplaySelect()) }, h('span', { class: 'tb-icon' }, '⏮'), h('span', { class: 'tb-label' }, 'Replay'));
    const undoBtn = btn({ title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => this.undo() }, '↶');
    const redoBtn = btn({ title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', onclick: () => this.redo() }, '↷');

    const grid = GRIDS.find((g) => g.id === this.gridId) ?? GRIDS[0];
    const gridBtn = btn({ title: 'Layout & sync', 'aria-label': 'Layout' }, h('span', { class: 'tb-icon' }, grid.icon), '▾');
    gridBtn.addEventListener('click', () => showMenu(gridBtn, [
      { header: 'Layout' },
      ...GRIDS.map((g) => ({ label: g.label, icon: g.icon, active: g.id === this.gridId, action: () => this.setGrid(g.id) })),
      '-',
      { header: 'Sync across charts' },
      { label: 'Crosshair', icon: this.settings.syncCrosshair ? '✓' : '', action: () => this.toggleSetting('syncCrosshair') },
      { label: 'Symbol', icon: this.settings.syncSymbol ? '✓' : '', action: () => this.toggleSetting('syncSymbol') },
      { label: 'Interval', icon: this.settings.syncInterval ? '✓' : '', action: () => this.toggleSetting('syncInterval') },
    ], { align: 'right' }));

    const status = h('span', { id: 'stream-status', class: `stream-status ${this.hubStatus}`, title: `Market stream: ${this.hubStatus}` },
      h('i'), h('span', {}, this.hubStatus === 'live' ? 'Live' : this.hubStatus === 'connecting' ? 'Connecting' : 'Reconnecting'));

    // Optional controls collapse into the ⋯ menu as the window narrows (tier 2 first, then tier 1).
    const opt = (tier, el) => {
      el.classList.add(`tb-opt${tier}`);
      return el;
    };
    const moreBtn = btn({ class: 'tb-btn tb-more', title: 'More', 'aria-label': 'More actions' }, '⋯');
    moreBtn.addEventListener('click', () => showMenu(moreBtn, [
      { label: 'Compare symbol…', icon: '⊕', action: () => this.openSymbolSearch({ mode: 'compare' }) },
      { label: 'Create alert…', icon: '⏰', hint: 'Alt+A', action: () => this.openAlertDialog() },
      { label: pane.replay ? 'Exit replay' : 'Bar replay', icon: '⏮', action: () => (pane.replay ? pane.exitReplay() : pane.startReplaySelect()) },
      { label: 'Undo', icon: '↶', hint: 'Ctrl+Z', action: () => this.undo() },
      { label: 'Redo', icon: '↷', hint: 'Ctrl+Y', action: () => this.redo() },
      '-',
      ...GRIDS.map((g) => ({ label: g.label, icon: g.icon, active: g.id === this.gridId, action: () => this.setGrid(g.id) })),
      '-',
      { label: 'Screenshot', icon: '📷', hint: 'Alt+S', action: () => this.screenshot() },
      { label: 'Chart settings…', icon: '⚙', action: () => this.openSettings() },
      { label: this.theme === 'light' ? 'Dark theme' : 'Light theme', icon: this.theme === 'light' ? '☾' : '☀', action: () => this.setTheme(this.theme === 'light' ? 'dark' : 'light') },
      { label: 'Keyboard shortcuts', icon: '⌨', hint: '?', action: () => this.openShortcuts() },
      { label: 'Fullscreen', icon: '⛶', action: () => this.toggleFullscreen() },
    ], { align: 'right', className: 'glass-pop' }));

    bar.replaceChildren(
      h('a', { class: 'brand', href: '#', 'aria-label': 'Orbit', onclick: (e) => e.preventDefault() }, h('span', { class: 'brand-mark' }, 'O'), h('span', { class: 'brand-name' }, 'orbit', h('em', {}, 'pro'))),
      btn({ class: 'tb-btn tb-tools', title: 'Drawing tools', 'aria-label': 'Drawing tools', onclick: () => document.querySelector('.app').classList.toggle('show-tools') }, '✎'),
      symbolBtn, opt(1, compareBtn), sep(),
      h('div', { class: 'tb-group intervals' }, ...favs, moreIntervals), sep(),
      typeBtn, indBtn, chainBtn, opt(1, sep()), opt(1, alertBtn), opt(1, replayBtn), opt(1, sep()), opt(1, undoBtn), opt(1, redoBtn),
      h('span', { class: 'spacer' }),
      this.layoutButton(),
      opt(1, status),
      opt(1, gridBtn),
      opt(2, btn({ title: 'Screenshot (Alt+S)', 'aria-label': 'Screenshot', onclick: () => this.screenshot() }, '📷')),
      opt(1, btn({ title: 'Chart settings', 'aria-label': 'Chart settings', onclick: () => this.openSettings() }, '⚙')),
      opt(2, btn({ title: 'Toggle light/dark', 'aria-label': 'Toggle theme', onclick: () => this.setTheme(this.theme === 'light' ? 'dark' : 'light') }, this.theme === 'light' ? '☾' : '☀')),
      opt(2, btn({ title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', onclick: () => this.openShortcuts() }, '⌨')),
      opt(2, btn({ title: 'Fullscreen', 'aria-label': 'Fullscreen', onclick: () => this.toggleFullscreen() }, '⛶')),
      moreBtn);
  }

  toggleSetting(key) {
    this.settings[key] = !this.settings[key];
    this.saveSettings();
    toast(`${key.replace('sync', 'Sync ')}: ${this.settings[key] ? 'on' : 'off'}`, 'info', 1800);
    if ((key === 'syncSymbol' || key === 'syncInterval') && this.settings[key]) this.onPaneSymbolChange(this.activePane);
  }

  // ----- left drawing toolbar (TradingView grouping: each group shows its last-used tool) -----
  setTool(id) {
    const tool = toolById(id);
    this.tool = id;
    if (tool?.group) {
      this.groupTool[tool.group] = id;
      store.set('groupTool', this.groupTool);
    }
    for (const pane of this.panes) pane.drawings.setTool(id);
    document.querySelector('.app')?.classList.remove('show-tools');
    this.syncToolbar();
    if (this.favBar && !this.favBar.hidden) this.renderFavBar();
  }

  syncToolbar() {
    const bar = this.dom.toolbar;
    for (const g of bar.querySelectorAll('[data-group]')) {
      const current = toolById(this.groupTool[g.dataset.group]) ?? TOOLS.find((t) => t.group === g.dataset.group);
      const main = g.querySelector('.dt-main');
      main.textContent = current.icon;
      main.title = `${current.label}${current.key ? ` (${current.key})` : ''}`;
      main.setAttribute('aria-label', current.label);
      main.dataset.tool = current.id;
      g.classList.toggle('active', toolById(this.tool)?.group === g.dataset.group);
    }
    for (const b of bar.querySelectorAll('[data-util]')) b.classList.toggle('active', b.dataset.util === this.tool);
    const layer = this.panes[0]?.drawings;
    if (!layer) return;
    const set = (sel, on) => bar.querySelector(sel)?.classList.toggle('on', Boolean(on));
    set('[data-toggle=magnet]', layer.magnet !== 'off');
    set('[data-toggle=keep]', layer.keepDrawing);
    set('[data-toggle=lock]', layer.locked);
    set('[data-toggle=hide]', layer.hidden);
    set('[data-toggle=fav]', this.showFavBar);
  }

  flyoutAt(anchor) {
    const r = anchor.getBoundingClientRect();
    return new DOMRect(r.right + 4, r.top - 6, 0, 0);
  }

  openToolFlyout(groupId, anchor) {
    const group = GROUPS.find((g) => g.id === groupId);
    const items = [];
    for (const section of group.sections) {
      const tools = TOOLS.filter((t) => t.group === groupId && t.section === section);
      if (!tools.length) continue;
      if (groupId !== 'cursors') items.push({ header: section });
      for (const t of tools) {
        items.push({
          label: t.label, icon: t.icon, hint: t.key ?? '', active: t.id === this.tool, action: () => this.setTool(t.id),
          fav: t.cursor ? undefined : this.favTools.includes(t.id), toolId: t.id,
        });
      }
    }
    showMenu(this.flyoutAt(anchor), items, { className: 'tool-flyout glass-pop' });
    // Favorite stars: starred tools appear on the floating favorites bar.
    const menu = document.querySelector('.menu.tool-flyout');
    const rows = items.filter((x) => !x.header);
    menu?.querySelectorAll('.menu-item').forEach((el, i) => {
      const item = rows[i];
      if (!item || item.fav === undefined) return;
      const star = h('span', { class: `fav-star${item.fav ? ' on' : ''}`, title: item.fav ? 'Remove from favorites' : 'Add to favorites', role: 'button', 'aria-label': 'Toggle favorite' }, item.fav ? '★' : '☆');
      star.addEventListener('click', (event) => {
        event.stopPropagation();
        const on = !this.favTools.includes(item.toolId);
        this.favTools = on ? [...this.favTools, item.toolId] : this.favTools.filter((x) => x !== item.toolId);
        store.set('favTools', this.favTools);
        star.classList.toggle('on', on);
        star.textContent = on ? '★' : '☆';
        this.renderFavBar();
      });
      el.append(star);
    });
  }

  renderToolbar() {
    const groupEls = GROUPS.map((group) => {
      const main = h('button', { type: 'button', class: 'dt-btn dt-main' });
      main.addEventListener('click', () => {
        const id = main.dataset.tool;
        this.setTool(id === this.tool && !toolById(id).cursor ? 'cross' : id);
      });
      const arrow = h('button', { type: 'button', class: 'dt-arrow', title: group.label, 'aria-label': group.label }, '›');
      arrow.addEventListener('click', () => this.openToolFlyout(group.id, arrow));
      // Long-press on the main button also opens the flyout, like TradingView.
      let pressTimer;
      main.addEventListener('pointerdown', () => { pressTimer = setTimeout(() => this.openToolFlyout(group.id, main), 450); });
      main.addEventListener('pointerup', () => clearTimeout(pressTimer));
      main.addEventListener('pointerleave', () => clearTimeout(pressTimer));
      return h('div', { class: 'dt-group', 'data-group': group.id }, main, arrow);
    });
    const util = (id, icon, title, onClick) => {
      const b = h('button', { type: 'button', class: 'dt-btn', 'data-util': id, title, 'aria-label': title }, icon);
      b.addEventListener('click', onClick);
      return b;
    };
    const split = (toggle, icon, title, onMain, menuItems) => {
      const main = h('button', { type: 'button', class: 'dt-btn dt-main', title, 'aria-label': title, 'data-toggle': toggle }, icon);
      main.addEventListener('click', onMain);
      if (!menuItems) return main;
      const arrow = h('button', { type: 'button', class: 'dt-arrow', title: `${title} options`, 'aria-label': `${title} options` }, '›');
      arrow.addEventListener('click', () => showMenu(this.flyoutAt(arrow), menuItems(), { className: 'glass-pop' }));
      return h('div', { class: 'dt-group' }, main, arrow);
    };
    const eachLayer = (fn) => { for (const pane of this.panes) fn(pane.drawings, pane); this.syncToolbar(); };
    const magnetMenu = () => {
      const mode = this.panes[0]?.drawings.magnet ?? 'off';
      const pick = (m) => () => { store.set('magnetMode', m); eachLayer((l) => { l.magnet = m; }); };
      return [
        { label: 'Weak magnet', icon: '🧲', active: mode === 'weak', action: pick('weak') },
        { label: 'Strong magnet', icon: '🧲', active: mode === 'strong', action: pick('strong') },
        { label: 'Off', icon: '', active: mode === 'off', action: pick('off') },
      ];
    };
    const setPositionsShown = (on) => {
      this.settings.showPositions = on;
      this.settings.showOrders = on;
      this.saveSettings();
      this.refreshAllOverlays();
    };
    const hideMenu = () => [
      { label: 'Hide drawings', icon: '✎', action: () => eachLayer((l) => { l.hidden = !l.hidden; l.update(); }) },
      { label: 'Hide indicators', icon: 'ƒ', action: () => { const vis = !this.activePane.indicators.some((i) => i.visible); this.panes.forEach((p) => p.setIndicatorsVisible(vis)); } },
      { label: 'Hide positions and orders', icon: '⇅', action: () => setPositionsShown(this.settings.showPositions === false) },
      {
        label: 'Hide all',
        icon: '👁',
        action: () => {
          const hide = !this.panes[0].drawings.hidden;
          eachLayer((l) => { l.hidden = hide; l.update(); });
          this.panes.forEach((p) => p.setIndicatorsVisible(!hide));
          setPositionsShown(!hide);
        },
      },
    ];
    const removeMenu = () => {
      const pane = this.activePane;
      const n = pane.drawings.drawings.length;
      const removeLocked = store.get('removeLocked', true);
      const k = pane.indicators.length;
      return [
        { label: `Remove ${n} drawing${n === 1 ? '' : 's'}`, icon: '✎', danger: true, disabled: !n, action: () => pane.drawings.clear(removeLocked) },
        { label: `Remove ${k} indicator${k === 1 ? '' : 's'}`, icon: 'ƒ', danger: true, disabled: !k, action: () => pane.removeAllIndicators() },
        { label: `Remove ${n} drawings & ${k} indicators`, icon: '🗑', danger: true, disabled: !n && !k, action: () => { pane.drawings.clear(removeLocked); pane.removeAllIndicators(); } },
        '-',
        { label: 'Always remove locked drawings', icon: removeLocked ? '✓' : '', action: () => store.set('removeLocked', !removeLocked) },
      ];
    };
    this.dom.toolbar.replaceChildren(
      ...groupEls,
      h('span', { class: 'dt-sep' }),
      util('quickmeasure', '📏', 'Measure (Shift + click)', () => this.setTool(this.tool === 'quickmeasure' ? 'cross' : 'quickmeasure')),
      util('zoom', '🔍', 'Zoom in (drag a box)', () => this.setTool(this.tool === 'zoom' ? 'cross' : 'zoom')),
      h('span', { class: 'dt-sep' }),
      split('magnet', '🧲', 'Magnet mode snaps drawings to the closest OHLC value', () => {
        const next = (this.panes[0]?.drawings.magnet ?? 'off') === 'off' ? 'weak' : 'off';
        store.set('magnetMode', next);
        eachLayer((l) => { l.magnet = next; });
      }, magnetMenu),
      split('keep', '✐', 'Keep drawing', () => eachLayer((l) => { l.keepDrawing = !l.keepDrawing; })),
      split('lock', '🔒', 'Lock all drawings', () => eachLayer((l) => { l.locked = !l.locked; })),
      split('hide', '👁', 'Hide all drawings', () => eachLayer((l) => { l.hidden = !l.hidden; l.update(); }), hideMenu),
      split('remove', '🗑', 'Remove drawings', () => {
        const pane = this.activePane;
        if (pane.drawings.drawings.length) pane.drawings.clear(store.get('removeLocked', true));
      }, removeMenu),
      h('span', { class: 'dt-sep' }),
      split('fav', '★', 'Show favorite drawing tools toolbar', () => {
        this.showFavBar = !this.showFavBar;
        store.set('showFavBar', this.showFavBar);
        this.renderFavBar();
        this.syncToolbar();
      }));
    this.showFavBar = store.get('showFavBar', false);
    this.renderFavBar();
    this.syncToolbar();
  }

  // Floating favorites bar (starred tools), draggable like TradingView's.
  renderFavBar() {
    if (!this.favBar) {
      this.favBar = h('div', { class: 'fav-bar glass-pop', role: 'toolbar', 'aria-label': 'Favorite drawing tools' });
      document.querySelector('.center').append(this.favBar);
      const pos = store.get('favBarPos', null);
      if (pos) Object.assign(this.favBar.style, pos);
    }
    const tools = this.favTools.map(toolById).filter(Boolean);
    this.favBar.hidden = !this.showFavBar;
    const handle = h('span', { class: 'ft-handle', 'aria-hidden': 'true' }, '⋮⋮');
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const host = this.favBar.parentElement.getBoundingClientRect();
      const box = this.favBar.getBoundingClientRect();
      const dx = event.clientX - box.left;
      const dy = event.clientY - box.top;
      const move = (ev) => {
        this.favBar.style.left = `${Math.max(0, ev.clientX - host.left - dx)}px`;
        this.favBar.style.top = `${Math.max(0, ev.clientY - host.top - dy)}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        store.set('favBarPos', { left: this.favBar.style.left, top: this.favBar.style.top });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.favBar.replaceChildren(handle, ...(tools.length
      ? tools.map((t) => h('button', { type: 'button', class: `ft-btn${this.tool === t.id ? ' on' : ''}`, title: t.label, 'aria-label': t.label, onclick: () => this.setTool(t.id) }, t.icon))
      : [h('span', { class: 'muted small fav-empty' }, 'Star tools in the toolbar flyouts')]));
  }

  // ----- bottom range bar -----
  renderRangeBar() {
    const scale = (mode, text, title) => h('button', {
      type: 'button',
      class: 'rb-btn scale',
      'data-mode': mode,
      title,
      onclick: () => {
        const pane = this.activePane;
        pane.setScaleMode(pane.scaleMode === mode ? PriceScaleMode.Normal : mode);
        this.updateScaleButtons();
      },
    }, text);
    this.clockEl = h('button', { type: 'button', class: 'rb-btn clock', title: 'Time zone' });
    this.clockEl.addEventListener('click', () => showMenu(this.clockEl, TIMEZONES.map((z) => ({
      label: z.label,
      active: z.id === this.settings.tz,
      action: () => {
        this.settings.tz = z.id;
        this.saveSettings();
        this.applyChartSettings();
      },
    })), { align: 'right' }));
    const autoBtn = h('button', {
      type: 'button',
      class: 'rb-btn',
      title: 'Reset price scale (auto)',
      onclick: () => {
        this.activePane.chart.priceScale('right').applyOptions({ autoScale: true });
        this.activePane.chart.timeScale().scrollToRealTime();
      },
    }, 'auto');
    const goTo = h('button', { type: 'button', class: 'rb-btn', title: 'Go to date', 'aria-label': 'Go to date' }, '📅');
    goTo.addEventListener('click', () => {
      const input = h('input', { type: 'datetime-local', class: 'goto-input', 'aria-label': 'Date and time' });
      let dialog;
      const go = () => {
        const t = new Date(input.value).getTime() / 1000;
        if (Number.isFinite(t)) this.activePane?.goToDate(t);
        dialog.close();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      dialog = modal('Go to', h('div', { class: 'settings-form' }, input), {
        width: 320,
        footer: [h('button', { type: 'button', class: 'btn ghost', onclick: () => dialog.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', onclick: go }, 'Go to')],
      });
      input.focus();
    });
    this.dom.rangeBar.replaceChildren(
      ...RANGES.map((r) => h('button', { type: 'button', class: 'rb-btn', onclick: () => this.activePane?.setVisibleSpan(r.span) }, r.label)),
      h('span', { class: 'rb-sep' }),
      goTo,
      h('span', { class: 'spacer' }),
      this.clockEl,
      h('span', { class: 'rb-sep' }),
      scale(PriceScaleMode.Percentage, '%', 'Percent scale'),
      scale(PriceScaleMode.Logarithmic, 'log', 'Log scale (Alt+L)'),
      autoBtn);
  }

  updateScaleButtons() {
    const mode = this.activePane?.scaleMode;
    this.dom.rangeBar.querySelectorAll('.scale').forEach((b) => b.classList.toggle('active', Number(b.dataset.mode) === mode));
  }

  tickClock() {
    if (!this.clockEl) return;
    const tz = TIMEZONES.find((z) => z.id === this.settings.tz);
    this.clockEl.textContent = `${this.timeFormatter.clock()}${tz && tz.id !== 'local' ? ` (${tz.label})` : ''}`;
  }

  // ----- replay bar -----
  onReplayChange(pane) {
    if (pane === this.activePane) {
      this.renderReplayBar();
      this.renderTopbar();
    }
  }

  renderReplayBar() {
    const pane = this.activePane;
    const bar = this.dom.replayBar;
    if (!pane?.replay) {
      bar.hidden = true;
      return;
    }
    const r = pane.replay;
    const current = pane.candles[r.index];
    const speed = h('select', { 'aria-label': 'Replay speed' }, ...[0.5, 1, 2, 3, 5, 10].map((s) => h('option', { value: s, selected: s === r.speed }, `${s}x`)));
    speed.addEventListener('change', () => pane.replaySpeed(Number(speed.value)));
    bar.hidden = false;
    bar.replaceChildren(
      h('span', { class: 'replay-title' }, '⏮ Replay'),
      h('button', { type: 'button', class: 'tb-btn', title: 'Step back (Shift+←)', 'aria-label': 'Step back', onclick: () => pane.replayBack() }, '⏪'),
      r.playing
        ? h('button', { type: 'button', class: 'tb-btn active', title: 'Pause (Space)', 'aria-label': 'Pause', onclick: () => pane.replayPause() }, '⏸')
        : h('button', { type: 'button', class: 'tb-btn', title: 'Play (Space)', 'aria-label': 'Play', onclick: () => pane.replayPlay() }, '▶'),
      h('button', { type: 'button', class: 'tb-btn', title: 'Step forward (Shift+→)', 'aria-label': 'Step forward', onclick: () => pane.replayStep(1) }, '⏩'),
      speed,
      h('span', { class: 'muted' }, current ? this.timeFormatter.full(current.time) : ''),
      h('span', { class: 'muted' }, `${pane.candles.length - 1 - r.index} bars left`),
      h('button', { type: 'button', class: 'tb-btn', title: 'Pick a new start bar', onclick: () => pane.startReplaySelect() }, 'Jump to…'),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => pane.exitReplay() }, 'Exit replay'));
  }

  // ----- dialogs -----
  // Load a market's symbol list into the shared map (spot loads at start; others on demand).
  loadMarket(market) {
    this.marketLoads ??= {};
    this.marketLoads[market] ??= PROVIDERS[market].symbols().then((list) => {
      for (const sym of list) if (!this.symbols.has(sym.symbol)) this.symbols.set(sym.symbol, sym);
      for (const pane of this.panes) if (parseSymbol(pane.symbol).provider === market) {
        pane.main.applyOptions({ priceFormat: pane.priceFormat() });
        pane.renderLegend();
      }
      return list;
    }).catch((error) => {
      delete this.marketLoads[market];
      toast(`Could not load ${PROVIDER_INFO[market].short} symbols: ${error.message}`, 'error');
      return [];
    });
    return this.marketLoads[market];
  }

  ensureSymbols(symbol) {
    const { provider } = parseSymbol(symbol);
    if (provider !== 'spot') this.loadMarket(provider);
  }

  // Multi-chart helpers: put a symbol beside the current chart, or fill a grid with several.
  openInNewPane(symbol) {
    const next = { 1: '2v', 2: '3', 3: '4' }[this.panes.length];
    if (next) {
      this.setGrid(next);
      this.panes.at(-1).setSymbol(symbol);
      this.setActivePane(this.panes.at(-1));
    } else {
      const target = this.panes.find((p) => p !== this.activePane && p.symbol !== symbol) ?? this.panes.at(-1);
      target.setSymbol(symbol);
      this.setActivePane(target);
    }
  }

  openSymbols(symbols) {
    const grid = { 1: '1', 2: '2v', 3: '3', 4: '4' }[Math.min(4, symbols.length)];
    this.setGrid(grid);
    // Same timeframe in every chart so contracts and the underlying line up bar for bar.
    const interval = this.activePane?.interval ?? '1h';
    symbols.slice(0, 4).forEach((sym, i) => {
      this.panes[i]?.setSymbol(sym);
      this.panes[i]?.setInterval(interval);
    });
    this.setActivePane(this.panes[0]);
  }

  openSymbolSearch({ mode = 'chart', initial = '' } = {}) {
    closeMenus();
    const titles = { chart: 'Symbol search', compare: 'Compare symbol', watchlist: 'Add to watchlist' };
    const input = h('input', { type: 'search', class: 'search-input', placeholder: 'Search, e.g. BTC, ETHUSDT, "btc 85000 c"', autocomplete: 'off', spellcheck: 'false', value: initial, 'aria-label': 'Search symbols' });
    const MARKETS = [['spot', 'Spot'], ['perp', 'Perpetuals'], ['bopt', 'Binance Options'], ['deribit', 'Deribit']];
    const quotes = ['All', 'USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'EUR'];
    let market = store.get('searchMarket', 'spot');
    let quote = store.get('searchQuote', 'USDT');
    const marketTabs = h('div', { class: 'segmented search-markets' });
    const tabs = h('div', { class: 'segmented search-tabs' });
    const chainBtn = h('button', { type: 'button', class: 'btn small ghost', onclick: () => { dialog.close(); this.openOptionChain(); } }, '⛓ Option chain');
    const results = h('div', { class: 'search-results', role: 'listbox' });
    let items = [];
    let sel = 0;
    let dialog;
    const choose = (symbol) => {
      dialog.close();
      if (mode === 'compare') this.activePane.addCompare(symbol);
      else if (mode === 'watchlist') this.sidebar.addToWatchlist(symbol);
      else this.activePane.setSymbol(symbol);
    };
    const render = () => {
      results.innerHTML = items.map((s, i) => {
        const t = tickers.get(s.symbol);
        const chg = t && t.open ? ((t.last - t.open) / t.open) * 100 : NaN;
        const name = optionTitle(s.symbol) ?? `${s.base} / ${s.quote}${s.type === 'perp' ? ' Perpetual' : s.type === 'future' ? ' Futures' : ''}`;
        return `<div class="search-row${i === sel ? ' sel' : ''}" role="option" aria-selected="${i === sel}" data-i="${i}">
          <span class="coin">${escapeHtml(s.base.slice(0, 1))}</span>
          <span class="sr-name"><b>${escapeHtml(s.symbol)}</b><small>${escapeHtml(name)}</small></span>
          <span class="sr-ex">${escapeHtml(PROVIDER_INFO[s.provider ?? 'spot'].short)}</span>
          <span class="sr-last">${t ? formatPrice(t.last, tickDigits(s.tick)) : ''}</span>
          <span class="sr-chg ${signClass(chg)}">${Number.isFinite(chg) ? formatPct(chg) : ''}</span>
          <span class="sr-vol">${t?.quoteVolume ? formatCompact(t.quoteVolume) : ''}</span>
        </div>`;
      }).join('') || `<div class="empty">${this.marketLoads?.[market] || market === 'spot' ? 'No matching symbols' : 'Loading…'}</div>`;
      results.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    const search = () => {
      const text = input.value.trim().toUpperCase();
      const q = text.replace(/[^A-Z0-9]/g, '');
      let list = [...this.symbols.values()].filter((s) => (s.provider ?? 'spot') === market);
      if ((market === 'spot' || market === 'perp') && quote !== 'All') list = list.filter((s) => s.quote === quote);
      const vol = (s) => tickers.get(s.symbol)?.quoteVolume ?? 0;
      if (market === 'bopt' || (market === 'deribit' && text)) {
        // Token search over symbol and readable contract name: "btc 85000 c", "eth dec put".
        const tokens = text.split(/\s+/).filter(Boolean);
        list = list.filter((s) => {
          const hay = `${s.symbol} ${optionTitle(s.symbol) ?? ''}`.toUpperCase();
          return tokens.every((tk) => hay.includes(tk) || (tk === 'C' && s.side === 'C') || (tk === 'P' && s.side === 'P'));
        });
        list.sort((a, b) => (a.expiry ?? 0) - (b.expiry ?? 0) || (a.strike ?? 0) - (b.strike ?? 0) || String(a.side).localeCompare(String(b.side)));
      } else if (q) {
        list = list.filter((s) => s.symbol.replace(/[^A-Z0-9]/g, '').includes(q) || s.base.startsWith(q));
        const score = (s) => (s.base === q || s.symbol === q ? 0 : s.base.startsWith(q) ? 1 : 2);
        list.sort((a, b) => score(a) - score(b) || vol(b) - vol(a));
      } else {
        list.sort((a, b) => vol(b) - vol(a) || (a.expiry ?? 0) - (b.expiry ?? 0));
      }
      items = list.slice(0, 120);
      sel = 0;
      render();
    };
    const renderTabs = () => {
      marketTabs.replaceChildren(...MARKETS.map(([id, label]) => h('button', {
        type: 'button',
        class: `seg${id === market ? ' active' : ''}`,
        onclick: () => {
          market = id;
          store.set('searchMarket', id);
          renderTabs();
          if (id !== 'spot') this.loadMarket(id).then(search);
          search();
          input.focus();
        },
      }, label)));
      tabs.hidden = market === 'bopt' || market === 'deribit';
      chainBtn.hidden = !(market === 'bopt' || market === 'deribit');
      tabs.replaceChildren(...quotes.map((q) => h('button', {
        type: 'button',
        class: `seg${q === quote ? ' active' : ''}`,
        onclick: () => {
          quote = q;
          store.set('searchQuote', q);
          renderTabs();
          search();
          input.focus();
        },
      }, q)));
    };
    results.addEventListener('click', (event) => {
      const row = event.target.closest('[data-i]');
      if (row) choose(items[Number(row.dataset.i)].symbol);
    });
    input.addEventListener('input', search);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); event.preventDefault(); }
      else if (event.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); event.preventDefault(); }
      else if (event.key === 'Enter' && items[sel]) { choose(items[sel].symbol); event.preventDefault(); }
    });
    dialog = modal(titles[mode], h('div', { class: 'symbol-search' }, input, marketTabs, h('div', { class: 'search-sub' }, tabs, chainBtn), results), { width: 720 });
    renderTabs();
    if (market !== 'spot') this.loadMarket(market).then(search);
    search();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  // ---------------------------------------------------------------- named layouts
  layoutButton() {
    const b = h('button', { type: 'button', class: 'tb-btn layout-btn', title: 'Layouts (Ctrl+S to save)', 'aria-label': 'Layouts' });
    this.updateLayoutButton = () => {
      const cur = this.layouts?.[this.layoutId];
      b.replaceChildren(...[h('span', { class: 'tb-icon' }, '▦'), h('span', { class: 'layout-name' }, cur?.name ?? 'Layout'), this.layoutDirty ? h('span', { class: 'layout-dirty', title: 'Unsaved changes' }, '●') : null, '▾'].filter(Boolean));
    };
    this.updateLayoutButton();
    b.addEventListener('click', () => this.openLayoutMenu(b));
    return b;
  }

  openLayoutMenu(anchor) {
    const entries = Object.entries(this.layouts).sort((a, b) => b[1].updated - a[1].updated);
    const items = [
      { label: 'Save layout', icon: '💾', hint: 'Ctrl+S', action: () => this.saveCurrentLayout() },
      { label: 'Save layout as…', icon: '⎘', action: () => this.saveLayoutAs() },
      { label: 'New layout', icon: '＋', action: () => this.newLayout() },
      { label: 'Rename…', icon: '✎', action: () => this.renameLayout() },
      { label: this.autosave ? 'Autosave: on' : 'Autosave: off', icon: this.autosave ? '✓' : '', action: () => { this.autosave = !this.autosave; store.set('layoutAutosave', this.autosave); if (this.autosave) this.persistLayout(true); } },
      '-',
      { header: `Layouts (${entries.length})` },
      ...entries.map(([id, l]) => ({
        label: `${l.name} · ${(l.panes?.length ?? 1)} chart${(l.panes?.length ?? 1) === 1 ? '' : 's'} · ${(l.panes ?? []).map((pp) => pp.symbol).slice(0, 2).join(', ')}`,
        icon: id === this.layoutId ? '●' : '',
        active: id === this.layoutId,
        action: () => this.switchLayout(id),
      })),
      '-',
      { label: 'Delete current layout…', icon: '🗑', danger: true, disabled: entries.length < 2, action: () => this.deleteLayout() },
    ];
    showMenu(anchor, items, { align: 'right', className: 'glass-pop layout-menu' });
  }

  saveCurrentLayout() {
    this.persistLayout(true);
    toast(`Layout "${this.layouts[this.layoutId].name}" saved`, 'success', 1600);
  }

  uniqueName(base) {
    const names = new Set(Object.values(this.layouts).map((l) => l.name));
    let name = base;
    for (let i = 2; names.has(name); i++) name = `${base} ${i}`;
    return name;
  }

  saveLayoutAs() {
    const name = prompt('Layout name', this.uniqueName(`${this.layouts[this.layoutId]?.name ?? 'Layout'} copy`));
    if (!name?.trim()) return;
    const id = `l${Date.now().toString(36)}`;
    this.layouts[id] = { name: name.trim(), ...this.snapshotLayout(), updated: Date.now() };
    this.layoutId = id;
    store.set('layouts', this.layouts);
    store.set('currentLayout', id);
    this.layoutDirty = false;
    this.updateLayoutButton();
    toast(`Saved as "${name.trim()}"`, 'success', 1600);
  }

  newLayout() {
    const name = prompt('New layout name', this.uniqueName('New layout'));
    if (!name?.trim()) return;
    // Flush pending (debounced) autosave so the current layout keeps its latest changes.
    if (this.autosave || (this.layoutDirty && confirm(`Save changes to "${this.layouts[this.layoutId].name}" first?`))) this.persistLayout(true);
    const id = `l${Date.now().toString(36)}`;
    this.layouts[id] = { name: name.trim(), grid: '1', active: 0, panes: [{ symbol: this.activePane?.symbol ?? 'BTCUSDT', interval: this.activePane?.interval ?? '1h', type: 'candles', indicators: [] }], updated: Date.now() };
    store.set('layouts', this.layouts);
    this.switchLayout(id, { skipSave: true });
  }

  renameLayout() {
    const cur = this.layouts[this.layoutId];
    const name = prompt('Rename layout', cur.name);
    if (!name?.trim()) return;
    cur.name = name.trim();
    store.set('layouts', this.layouts);
    this.updateLayoutButton();
  }

  deleteLayout() {
    const cur = this.layouts[this.layoutId];
    if (!confirm(`Delete layout "${cur.name}"? Its charts, indicators and settings are removed (drawings stay with their symbols).`)) return;
    delete this.layouts[this.layoutId];
    store.set('layouts', this.layouts);
    const next = Object.entries(this.layouts).sort((a, b) => b[1].updated - a[1].updated)[0][0];
    this.switchLayout(next, { skipSave: true });
  }

  // Each layout keeps its own grid, symbols/markets, intervals, chart types, indicators and compares.
  switchLayout(id, { skipSave = false } = {}) {
    if (!this.layouts[id] || (id === this.layoutId && !skipSave)) return;
    if (!skipSave && this.layouts[this.layoutId]) {
      if (this.autosave) this.persistLayout(true);
      else if (this.layoutDirty && confirm(`Save changes to "${this.layouts[this.layoutId].name}" before switching?`)) this.persistLayout(true);
    }
    const target = this.layouts[id];
    this.layoutId = id;
    store.set('currentLayout', id);
    this.layoutDirty = false;
    this.gridId = target.grid ?? '1';
    const configs = target.panes?.length ? target.panes : [{ symbol: 'BTCUSDT', interval: '1h', type: 'candles', indicators: [] }];
    this.buildPanes(configs, target.active ?? 0);
    this.renderTopbar();
    this.syncBrokerWatch();
    toast(`Layout: ${target.name}`, 'info', 1400);
  }

  // ---------------------------------------------------------------- indicator templates
  indicatorTemplates() { return store.get('indTemplates', {}); }

  saveIndicatorTemplate(pane = this.activePane) {
    if (!pane.indicators.length) {
      toast('Add some indicators first — a template saves the current chart’s indicators with their settings.', 'info', 4000);
      return false;
    }
    const name = prompt('Indicator template name', pane.indicators.map((i) => i.def.short).join(' + '));
    if (!name?.trim()) return false;
    const templates = this.indicatorTemplates();
    if (templates[name.trim()] && !confirm(`Replace the existing template "${name.trim()}"?`)) return false;
    templates[name.trim()] = pane.serialize().indicators;
    store.set('indTemplates', templates);
    toast(`Template "${name.trim()}" saved (${templates[name.trim()].length} indicators)`, 'success', 1800);
    return true;
  }

  applyIndicatorTemplate(name, { replace = true, pane = this.activePane } = {}) {
    const list = this.indicatorTemplates()[name];
    if (!list) return;
    if (replace) pane.removeAllIndicators();
    for (const cfg of list) pane.addIndicator(cfg.id, JSON.parse(JSON.stringify(cfg)), false);
    pane.renderLegend();
    this.saveLayout();
    this.emitObjects(pane);
    toast(`Applied "${name}"`, 'success', 1400);
  }

  deleteIndicatorTemplate(name) {
    const templates = this.indicatorTemplates();
    delete templates[name];
    store.set('indTemplates', templates);
  }

  openOptionChain(opts) {
    openOptionChain(this, opts);
  }

  openIndicators() {
    closeMenus();
    const pane = this.activePane;
    const input = h('input', { type: 'search', class: 'search-input', placeholder: 'Search indicators', autocomplete: 'off', 'aria-label': 'Search indicators' });
    const cats = ['All', ...new Set(INDICATORS.filter((i) => !i.custom).map((i) => i.category)), 'Custom'];
    let cat = store.get('indCat', 'All');
    if (!cats.includes(cat)) cat = 'All';
    // Custom indicators are grouped by family, as in CandL's dialog.
    const families = ['All', ...new Set(INDICATORS.filter((i) => i.custom).map((i) => i.family))];
    let family = 'All';
    const tabs = h('div', { class: 'segmented' });
    const famTabs = h('div', { class: 'ind-families' });
    const list = h('div', { class: 'ind-list' });
    const preview = h('div', { class: 'ind-preview', hidden: true });
    const showPreview = (def) => {
      preview.hidden = !def?.description;
      if (def?.description) preview.replaceChildren(h('b', {}, def.name), h('span', { class: 'ind-tag' }, `Custom · ${def.family}`), h('p', {}, def.description));
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      famTabs.hidden = cat !== 'Custom';
      famTabs.replaceChildren(...families.map((f) => h('button', { type: 'button', class: `chip${f === family ? ' active' : ''}`, onclick: () => { family = f; render(); } }, f)));
      const items = INDICATORS.filter((i) => (cat === 'All' || i.category === cat)
        && (cat !== 'Custom' || family === 'All' || i.family === family)
        && (!q || i.name.toLowerCase().includes(q) || i.short.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q)));
      list.replaceChildren(...items.map((def) => {
        const count = pane.indicators.filter((i) => i.def.id === def.id).length;
        return h('button', {
          type: 'button',
          class: `ind-row${def.custom ? ' custom' : ''}`,
          title: def.description ?? '',
          onmouseenter: () => showPreview(def),
          onfocus: () => showPreview(def),
          onclick: () => {
            pane.addIndicator(def.id);
            toast(`${def.name} added`, 'success', 1500);
            render();
          },
        },
        h('span', { class: 'ind-short' }, def.short),
        h('span', { class: 'ind-name' }, def.name),
        def.custom ? h('span', { class: 'ind-badge' }, 'Custom') : null,
        h('span', { class: 'ind-cat' }, def.overlay ? 'On chart' : 'New pane'),
        count ? h('span', { class: 'ind-count' }, `×${count}`) : null);
      }));
    };
    const renderTabs = () => tabs.replaceChildren(...cats.map((c) => h('button', { type: 'button', class: `seg${c === cat ? ' active' : ''}`, onclick: () => { cat = c; store.set('indCat', c); renderTabs(); render(); } }, c === 'Custom' ? `★ Custom (${INDICATORS.filter((i) => i.custom).length})` : c)));
    input.addEventListener('input', render);
    const tplBar = h('div', { class: 'ind-templates' });
    const renderTemplates = () => {
      const templates = Object.entries(this.indicatorTemplates());
      tplBar.replaceChildren(...[
        h('span', { class: 'muted small' }, 'Templates'),
        ...templates.map(([name, cfgs]) => h('span', { class: 'tpl-chip' },
          h('button', { type: 'button', class: 'tpl-apply', title: `Replace this chart's indicators with: ${cfgs.map((c) => c.id.toUpperCase()).join(', ')}`, onclick: () => { this.applyIndicatorTemplate(name); render(); } }, name),
          h('button', { type: 'button', class: 'tpl-add', title: 'Add to the current indicators', 'aria-label': `Add ${name}`, onclick: () => { this.applyIndicatorTemplate(name, { replace: false }); render(); } }, '+'),
          h('button', { type: 'button', class: 'tpl-del', title: 'Delete template', 'aria-label': `Delete ${name}`, onclick: () => { if (confirm(`Delete template "${name}"?`)) { this.deleteIndicatorTemplate(name); renderTemplates(); } } }, '✕'))),
        templates.length ? null : h('span', { class: 'faint small' }, 'None yet'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { if (this.saveIndicatorTemplate(pane)) renderTemplates(); } }, '💾 Save current as template')].filter(Boolean));
    };
    renderTemplates();
    modal('Indicators', h('div', { class: 'indicator-picker' }, tplBar, input, tabs, famTabs, list, preview), { width: 640 });
    renderTabs();
    render();
    input.focus();
  }

  openAlertDialog(symbol = this.activePane?.symbol, price, existing) {
    closeMenus();
    const last = tickers.get(symbol)?.last ?? this.activePane?.candles.at(-1)?.close;
    const info = this.symbolInfo(symbol);
    const digits = info ? tickDigits(info.tick) : 2;
    const symInput = h('input', { type: 'text', value: symbol, spellcheck: 'false' });
    const cond = h('select', {}, ...ALERT_CONDITIONS.map((c) => h('option', { value: c.id, selected: (existing?.condition ?? 'crossing') === c.id }, c.label)));
    const priceInput = h('input', { type: 'number', step: 'any', value: Number(price ?? existing?.price ?? last ?? 0).toFixed(digits) });
    const message = h('input', { type: 'text', placeholder: 'Optional message', value: existing?.message ?? '' });
    const once = h('select', {},
      h('option', { value: 'once', selected: existing ? existing.once : true }, 'Only once'),
      h('option', { value: 'every', selected: existing ? !existing.once : false }, 'Every time'));
    const form = h('form', { class: 'settings-form' },
      h('label', { class: 'form-row' }, h('span', {}, 'Symbol'), symInput),
      h('label', { class: 'form-row' }, h('span', {}, 'Condition'), cond),
      h('label', { class: 'form-row' }, h('span', {}, 'Price'), priceInput),
      h('label', { class: 'form-row' }, h('span', {}, 'Trigger'), once),
      h('label', { class: 'form-row' }, h('span', {}, 'Message'), message),
      last ? h('p', { class: 'muted small' }, `Last price ${formatPrice(last, digits)}. Alerts run while this page is open and also show as a browser notification.`) : null);
    let dialog;
    const save = () => {
      const sym = symInput.value.trim().toUpperCase();
      const p = Number(priceInput.value);
      if (!sym || !(p > 0)) {
        toast('Enter a symbol and a price above zero', 'error');
        return;
      }
      const data = { symbol: sym, condition: cond.value, price: p, message: message.value.trim(), once: once.value === 'once', active: true };
      if (existing) this.alerts.update(existing.id, data);
      else this.alerts.add(data);
      dialog.close();
    };
    form.addEventListener('submit', (event) => { event.preventDefault(); save(); });
    dialog = modal(existing ? 'Edit alert' : 'Create alert', form, {
      width: 400,
      footer: [h('button', { type: 'button', class: 'btn ghost', onclick: () => dialog.close() }, 'Cancel'), h('button', { type: 'button', class: 'btn primary', onclick: save }, existing ? 'Save' : 'Create')],
    });
    priceInput.focus();
    priceInput.select();
  }

  openSettings() {
    openChartSettings(this);
  }

  openShortcuts() {
    modal('Keyboard shortcuts', h('div', { class: 'shortcuts' }, ...SHORTCUTS.map(([k, d]) => h('div', { class: 'shortcut' }, h('kbd', {}, k), h('span', {}, d)))), { width: 480 });
  }

  openIntervalInput(initial) {
    const input = h('input', { class: 'interval-input', value: initial, 'aria-label': 'Interval', spellcheck: 'false' });
    const box = h('div', { class: 'interval-popup' }, h('small', {}, 'Change interval'), input, h('small', { class: 'muted' }, 'e.g. 5, 15, 60, 4h, 1d, 1w · Enter'));
    document.body.append(box);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const close = () => box.remove();
    input.addEventListener('blur', close);
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') close();
      if (event.key !== 'Enter') return;
      const raw = input.value.trim().toLowerCase();
      const m = raw.match(/^(\d+)\s*([mhdw]?)$/);
      let id = null;
      if (m) {
        const n = Number(m[1]);
        const unit = m[2] || 'm';
        if (unit === 'm' && n === 1440) id = '1d';
        else if (unit === 'm' && n >= 60 && n % 60 === 0) id = `${n / 60}h`;
        else id = `${n}${unit}`;
      }
      if (raw === '1mo' || raw === 'mo') id = '1M';
      const iv = INTERVALS.find((i) => i.id === id);
      if (iv) this.activePane.setInterval(iv.id);
      else toast(`Unsupported interval "${input.value}". Available: ${INTERVALS.map((i) => i.label).join(', ')}`, 'error');
      close();
    });
  }

  // ----- context menu -----
  chartContextMenu(pane, event, price, drawing) {
    if (drawing) {
      const layer = pane.drawings;
      const tool = toolById(drawing.type);
      showMenu(new DOMRect(event.clientX, event.clientY, 0, 0), [
        { header: tool?.label ?? 'Drawing' },
        { label: 'Settings…', icon: '⚙', action: () => layer.openSettings(drawing) },
        ...(tool?.alertable ? [{ label: 'Add alert…', icon: '⏰', action: () => this.openAlertDialog(pane.symbol, drawing.points.at(-1).price) }] : []),
        ...(tool?.editText ? [{ label: 'Edit text', icon: 'Aa', action: () => layer.editText(drawing) }] : []),
        '-',
        { label: 'Clone', icon: '⧉', action: () => layer.clone(drawing.id) },
        { label: 'Copy', icon: '⎘', hint: 'Ctrl+C', action: () => { layer.selectedId = drawing.id; layer.copySelected(); } },
        '-',
        { label: 'Bring to front', icon: '⇈', action: () => layer.reorder(drawing.id, 'front') },
        { label: 'Send to back', icon: '⇊', action: () => layer.reorder(drawing.id, 'back') },
        '-',
        { label: drawing.locked ? 'Unlock' : 'Lock', icon: drawing.locked ? '🔓' : '🔒', action: () => layer.mutate(drawing.id, (x) => { x.locked = !x.locked; }, { remember: false }) },
        { label: 'Hide', icon: '👁', action: () => layer.mutate(drawing.id, (x) => { x.hidden = true; }, { remember: false }) },
        { label: 'Remove', icon: '🗑', hint: 'Del', danger: true, action: () => layer.remove(drawing.id) },
      ]);
      return;
    }
    const d = pane.digits();
    const p = price !== null && price !== undefined ? Number(price.toFixed(d ?? 2)) : null;
    const pText = p !== null ? formatPrice(p, d) : '';
    const last = tickers.get(pane.symbol)?.last ?? pane.candles.at(-1)?.close;
    const qty = store.get(`qty.${pane.symbol}`, last ? +(1000 / last).toPrecision(3) : 1);
    const items = [
      {
        label: 'Reset chart view',
        icon: '⟲',
        action: () => {
          pane.chart.priceScale('right').applyOptions({ autoScale: true });
          pane.chart.timeScale().resetTimeScale();
          pane.chart.timeScale().scrollToRealTime();
        },
      },
      '-',
    ];
    if (p !== null && last) {
      items.push(
        { label: `Add alert at ${pText}`, icon: '⏰', action: () => this.openAlertDialog(pane.symbol, p) },
        { label: `Draw horizontal line at ${pText}`, icon: '─', action: () => pane.drawings.addHorizontalLine(p) },
        { label: `Paper buy ${qty} @ ${pText} (${p < last ? 'limit' : 'stop'})`, icon: '▲', action: () => this.broker.placeOrder({ symbol: pane.symbol, side: 'buy', type: p < last ? 'limit' : 'stop', qty, price: p }) },
        { label: `Paper sell ${qty} @ ${pText} (${p > last ? 'limit' : 'stop'})`, icon: '▼', action: () => this.broker.placeOrder({ symbol: pane.symbol, side: 'sell', type: p > last ? 'limit' : 'stop', qty, price: p }) },
        { label: `Copy price ${pText}`, icon: '⧉', action: () => navigator.clipboard?.writeText(String(p)).then(() => toast('Price copied', 'info', 1200)).catch(() => {}) },
        '-',
      );
    }
    items.push(
      { label: 'Indicators…', icon: 'ƒ', hint: '/', action: () => this.openIndicators() },
      { label: 'Compare symbol…', icon: '⊕', action: () => this.openSymbolSearch({ mode: 'compare' }) },
      { label: 'Start bar replay', icon: '⏮', action: () => pane.startReplaySelect() },
      { label: 'Screenshot', icon: '📷', hint: 'Alt+S', action: () => this.screenshot() },
      '-',
      { label: `Remove ${pane.drawings.drawings.length} drawings`, icon: '✎', danger: true, disabled: !pane.drawings.drawings.length, action: () => pane.drawings.clear() },
      { label: `Remove ${pane.indicators.length} indicators`, icon: 'ƒ', danger: true, disabled: !pane.indicators.length, action: () => pane.removeAllIndicators() },
      '-',
      { label: 'Chart settings…', icon: '⚙', action: () => this.openSettings() },
    );
    showMenu(new DOMRect(event.clientX, event.clientY, 0, 0), items);
  }

  // ----- actions -----
  undo() {
    if (!this.activePane?.drawings.undo()) toast('Nothing to undo', 'info', 1200);
  }

  redo() {
    if (!this.activePane?.drawings.redo()) toast('Nothing to redo', 'info', 1200);
  }

  screenshot() {
    const pane = this.activePane;
    if (!pane) return;
    const chartCanvas = pane.screenshot();
    const pad = 36;
    const canvas = document.createElement('canvas');
    canvas.width = chartCanvas.width;
    canvas.height = chartCanvas.height + pad;
    const ctx = canvas.getContext('2d');
    const t = this.themeColors();
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(chartCanvas, 0, pad);
    const last = pane.candles.at(-1);
    ctx.fillStyle = this.theme === 'light' ? '#131722' : '#d1d4dc';
    ctx.font = '600 15px Inter, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${pane.symbol} · ${intervalLabel(pane.interval)} · Binance${last ? `   C ${formatPrice(last.close, pane.digits())}` : ''}`, 12, pad / 2);
    ctx.font = '12px Inter, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = t.text;
    ctx.fillText(`Orbit · ${this.timeFormatter.full(Math.floor(Date.now() / 1000))}`, canvas.width - 12, pad / 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadCanvas(canvas, `${pane.symbol}_${pane.interval}_${stamp}.png`);
    toast('Screenshot saved to your downloads', 'success', 2000);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen is not available here', 'error'));
  }

  // ----- screen fitting: breakpoints, splitters, overlay panels -----
  setupResponsive() {
    const root = document.documentElement;
    const appEl = document.querySelector('.app');
    const bottom = document.querySelector('#bottom-panel');
    const sidebar = document.querySelector('#sidebar');
    const savedH = store.get('bottomH', null);
    const savedW = store.get('sideW', null);
    if (savedH) root.style.setProperty('--bottom-h', `${savedH}px`);
    if (savedW) root.style.setProperty('--side-w', `${savedW}px`);

    const isPhone = () => window.matchMedia('(max-width: 640px)').matches;
    const isCompact = () => window.matchMedia('(max-width: 1180px)').matches;
    // Small screens start with the chart visible: floating panels closed (without changing saved prefs).
    if (isCompact() && this.sidebar.open) {
      this.sidebar.open = false;
      this.sidebar.applyOpen();
      this.sidebar.render();
    }
    if (isPhone() && this.bottom.open) {
      this.bottom.open = false;
      this.bottom.applyOpen();
      this.bottom.renderHead();
      this.bottom.render();
    }

    // Tapping the charts closes a floating sidebar / the tools drawer.
    this.dom.grid.addEventListener('pointerdown', () => {
      if (isCompact() && this.sidebar.open) {
        this.sidebar.open = false;
        this.sidebar.applyOpen();
        this.sidebar.render();
      }
      if (appEl.classList.contains('show-tools') && this.tool === 'cross') appEl.classList.remove('show-tools');
    });

    const drag = (handle, onMove, onDone, onReset) => {
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        appEl.classList.add('splitting');
        try { handle.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
        const move = (ev) => onMove(ev);
        const up = () => {
          appEl.classList.remove('splitting');
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          onDone();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
      handle.addEventListener('dblclick', onReset);
    };
    const bottomSplit = h('div', { class: 'split-bottom', title: 'Drag to resize · double-click to reset', 'aria-hidden': 'true' });
    bottom.prepend(bottomSplit);
    let bottomH = savedH;
    drag(bottomSplit, (ev) => {
      const center = document.querySelector('.center').getBoundingClientRect();
      const head = bottom.querySelector('.bottom-head').offsetHeight;
      const max = Math.max(160, center.height * 0.72 - head);
      bottomH = Math.round(Math.min(max, Math.max(120, center.bottom - ev.clientY - head)));
      root.style.setProperty('--bottom-h', `${bottomH}px`);
    }, () => store.set('bottomH', bottomH), () => {
      bottomH = null;
      root.style.removeProperty('--bottom-h');
      store.set('bottomH', null);
    });
    const sideSplit = h('div', { class: 'split-side', title: 'Drag to resize · double-click to reset', 'aria-hidden': 'true' });
    sidebar.prepend(sideSplit);
    let sideW = savedW;
    drag(sideSplit, (ev) => {
      const rail = sidebar.querySelector('.sidebar-rail').getBoundingClientRect();
      sideW = Math.round(Math.min(Math.min(560, window.innerWidth * 0.45), Math.max(230, rail.left - ev.clientX)));
      root.style.setProperty('--side-w', `${sideW}px`);
    }, () => store.set('sideW', sideW), () => {
      sideW = null;
      root.style.removeProperty('--side-w');
      store.set('sideW', null);
    });

    // Keep everything inside the viewport after a resize/rotation.
    let timer;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const pane of this.panes) {
          pane.layoutSubLegends();
          pane.drawings.toolbar.render();
        }
        this.favBar && this.renderFavBar();
      }, 120);
    });
  }

  // ----- keyboard -----
  bindKeyboard() {
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (typing || document.querySelector('.modal-backdrop')) return;
      const pane = this.activePane;
      if (!pane) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key;

      if (key === 'Escape') {
        closeMenus();
        if (pane.drawings.cancel()) return;
        if (this.tool !== 'cross') this.setTool('cross');
        if (pane.onPaneClick) pane.exitReplay(false);
        return;
      }
      if (key === 'Enter' && pane.drawings.draft) {
        event.preventDefault();
        pane.drawings.finishMulti(true);
        return;
      }
      if (mod && key.toLowerCase() === 'c' && pane.drawings.copySelected()) {
        event.preventDefault();
        toast('Drawing copied', 'info', 1000);
        return;
      }
      if (mod && key.toLowerCase() === 'v' && this.clipboard) {
        event.preventDefault();
        pane.drawings.paste();
        return;
      }
      if ((key === 'Delete' || key === 'Backspace') && pane.drawings.deleteSelected()) {
        event.preventDefault();
        return;
      }
      if (mod && key.toLowerCase() === 's') {
        event.preventDefault();
        this.saveCurrentLayout();
        return;
      }
      if (mod && key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && key.toLowerCase() === 'y') {
        event.preventDefault();
        this.redo();
        return;
      }
      if (event.altKey && !mod) {
        const code = event.code.replace('Key', '');
        const toolKeys = { T: 'trend', H: 'hline', V: 'vline', F: 'fib', R: 'rect' };
        if (toolKeys[code]) {
          event.preventDefault();
          this.setTool(toolKeys[code]);
          return;
        }
        if (code === 'A') { event.preventDefault(); this.openAlertDialog(); return; }
        if (code === 'S') { event.preventDefault(); this.screenshot(); return; }
        if (code === 'L') {
          event.preventDefault();
          pane.setScaleMode(pane.scaleMode === PriceScaleMode.Logarithmic ? PriceScaleMode.Normal : PriceScaleMode.Logarithmic);
          this.updateScaleButtons();
          return;
        }
      }
      if (pane.replay) {
        if (key === ' ') {
          event.preventDefault();
          if (pane.replay.playing) pane.replayPause();
          else pane.replayPlay();
          return;
        }
        if (event.shiftKey && key === 'ArrowRight') { event.preventDefault(); pane.replayStep(1); return; }
        if (event.shiftKey && key === 'ArrowLeft') { event.preventDefault(); pane.replayBack(); return; }
      }
      if (mod || event.altKey) return;
      if (key === '/') { event.preventDefault(); this.openIndicators(); return; }
      if (key === '?') { event.preventDefault(); this.openShortcuts(); return; }
      if (/^[0-9]$/.test(key)) { event.preventDefault(); this.openIntervalInput(key); return; }
      if (/^[a-zA-Z]$/.test(key)) { event.preventDefault(); this.openSymbolSearch({ initial: key.toUpperCase() }); }
    });
  }
}

export function start() {
  const app = new App();
  app.start();
  window.orbit = app;
  return app;
}
