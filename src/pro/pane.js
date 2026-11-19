// One chart cell in the layout grid: data loading, live updates, chart types, indicators,
// compare symbols, drawings, alerts/positions overlays, status line (legend) and bar replay.

import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
} from 'lightweight-charts';
import { pushPrice, tickDigits } from './binance.js';
import { bucketStart, markProvider, optionTitle, parseOption, parseSymbol, PROVIDER_INFO, providerFor } from './providers.js';
import {
  addTradeToRows, CHART_TYPES, chartTypeById, deriveBars, footprintRows, niceStep, VIEW_FACTORIES,
} from './charttypes.js';
import { DrawingLayer } from './drawings.js';
import { TradeOverlay } from './tradeoverlay.js';
import { defaultVisibility, visibleOnInterval } from './drawtools.js';
import { openIndicatorSettings } from './drawui.js';
import { defaultParams, indicatorById } from './indicators.js';
import {
  CandlPrimitive, candlSymbol, createOutputSeries, outputData, outputSeriesOptions, publishFootprint, startDomFeed, toCandl,
} from './customind.js';
import { getCanvasSource, getSignalSource } from '../candl/examples/basic/custom-indicators.ts';
import {
  formatCompact, formatPrice, h, intervalLabel, intervalSec, lowerBound, signClass, store, toast, uid,
} from './util.js';

export { CHART_TYPES };

const COMPARE_COLORS = ['#FF9800', '#9C27B0', '#00BCD4', '#E91E63', '#4CAF50'];
const MAX_BARS = 15000;

function formatIndicatorValue(v, precision) {
  if (precision !== undefined && precision !== 'default') return v.toFixed(Number(precision));
  const a = Math.abs(v);
  if (a >= 1e5) return formatCompact(v);
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  return v.toPrecision(4);
}

// ---------------------------------------------------------------- legend DOM patching
// The status line re-renders on every tick and crosshair move. Replacing its nodes would reset
// hover state under the cursor (the indicator buttons fade in again, hovered names flicker), so
// freshly built rows are patched into the existing ones: same element kind (tag, first class,
// data-key) is updated in place (text, attributes, children); anything else is swapped. Event
// listeners stay those of the first render, so rows carry a data-key naming what they act on.
// Attributes named in data-keep (e.g. "style hidden" set by layout code) are left alone.
function sameKind(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return a.tagName === b.tagName && (a.dataset.key ?? '') === (b.dataset.key ?? '') && (a.classList[0] ?? '') === (b.classList[0] ?? '');
}

function patchNode(a, b) {
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  const keep = new Set((a.dataset.keep ?? '').split(' ').filter(Boolean));
  for (const { name } of [...a.attributes]) if (!keep.has(name) && !b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (!keep.has(name) && a.getAttribute(name) !== value) a.setAttribute(name, value);
  patchChildren(a, [...b.childNodes]);
}

export function patchChildren(parent, next) {
  for (let i = 0; i < next.length; i++) {
    const a = parent.childNodes[i];
    const b = next[i];
    if (a === b) continue;
    if (a && sameKind(a, b)) patchNode(a, b);
    else if (a) parent.replaceChild(b, a);
    else parent.appendChild(b);
  }
  while (parent.childNodes.length > next.length) parent.lastChild.remove();
}

export class ChartPane {
  constructor(app, config, container) {
    this.app = app;
    this.id = uid();
    this.symbol = config.symbol;
    this.interval = config.interval;
    this.type = config.type || 'candles';
    this.candles = [];
    this.indicators = [];
    this.compares = [];
    this.alertLines = new Map();
    this.positionLines = [];
    this.extraLines = {};
    this.markers = [];
    this.scaleMode = config.scaleMode ?? PriceScaleMode.Normal;
    this.replay = null;
    this.loading = false;
    this.loadingMore = false;
    this.exhausted = false;
    this.unsub = null;
    this.loadId = 0;
    this.crosshairTime = null;
    // Indicator rows in the status line start collapsed behind a chevron, as on TradingView.
    this.legendCollapsed = config.legendCollapsed ?? true;
    // Option charts: 'mark' (clean mark-price candles) or 'last' (the exchange's trade candles).
    this.optPrice = config.optPrice ?? 'mark';

    this.host = h('div', { class: 'pane' });
    this.chartEl = h('div', { class: 'pane-chart' });
    this.legend = h('div', { class: 'legend' });
    this.subLegends = h('div', { class: 'sub-legends' });
    this.overlay = h('div', { class: 'pane-overlay', hidden: true });
    this.watermark = h('div', { class: 'pane-watermark', 'aria-hidden': 'true' });
    this.host.append(this.chartEl, this.watermark, this.legend, this.subLegends, this.overlay);
    container.append(this.host);

    this.chart = createChart(this.chartEl, this.chartOptions());
    this.drawings = new DrawingLayer(this);
    this.trade = new TradeOverlay(this);
    this.createMainSeries();
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false,
    }, 0);
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.volume.applyOptions({ visible: app.settings.showVolume });
    this.drawings.onChange(() => app.emitObjects(this));

    this.bindChartEvents();
    for (const ind of config.indicators ?? []) this.addIndicator(ind.id, ind, false);
    this.pendingCompares = [...(config.compare ?? [])];
    this.host.addEventListener('pointerdown', () => this.activate(), true);
    this.resizeObserver = new ResizeObserver(() => {
      this.layoutSubLegends();
      this.drawings.toolbar.render();
    });
    this.resizeObserver.observe(this.chartEl);
    this.countdownTimer = setInterval(() => this.updateCountdown(), 1000);
    this.load();
  }

  // ---------------------------------------------------------------- chart options from settings
  chartOptions() {
    const s = this.app.settings;
    const t = this.app.themeColors();
    const fmt = this.app.timeFormatter;
    const bg = s.bgColor ?? t.bg;
    return {
      autoSize: true,
      layout: {
        background: s.bgType === 'gradient'
          ? { type: ColorType.VerticalGradient, topColor: bg, bottomColor: s.bgColor2 ?? bg }
          : { type: ColorType.Solid, color: bg },
        textColor: s.scaleText ?? t.text,
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: s.scaleFont ?? 11,
        attributionLogo: false,
        panes: { separatorColor: s.scaleLines ?? t.border, separatorHoverColor: t.hover, enableResize: true },
      },
      grid: {
        vertLines: { color: s.gridVert ?? t.grid, visible: s.gridVertOn !== false && s.grid !== false },
        horzLines: { color: s.gridHorz ?? t.grid, visible: s.gridHorzOn !== false && s.grid !== false },
      },
      crosshair: {
        mode: s.magnetCrosshair ? CrosshairMode.Magnet : CrosshairMode.Normal,
        vertLine: { color: s.crosshairColor ?? t.crosshair, width: s.crosshairWidth ?? 1, style: s.crosshairStyle ?? LineStyle.Dashed, labelBackgroundColor: t.label },
        horzLine: { color: s.crosshairColor ?? t.crosshair, width: s.crosshairWidth ?? 1, style: s.crosshairStyle ?? LineStyle.Dashed, labelBackgroundColor: t.label },
      },
      rightPriceScale: {
        borderColor: s.scaleLines ?? t.border,
        scaleMargins: { top: (s.marginTop ?? 8) / 100, bottom: (s.marginBottom ?? 20) / 100 },
        mode: this.scaleMode,
        invertScale: Boolean(s.invertScale),
      },
      timeScale: {
        borderColor: s.scaleLines ?? t.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: s.rightBars ?? 10,
        tickMarkFormatter: (time, type) => fmt.tick(time, type),
      },
      localization: {
        timeFormatter: (time) => fmt.full(time),
        priceFormatter: (p) => formatPrice(p, this.digits()),
      },
    };
  }

  applyCursorMode(mode) {
    const lines = mode === 'cross';
    this.chartEl.dataset.cursor = mode;
    this.chart.applyOptions({
      crosshair: {
        vertLine: { visible: lines, labelVisible: mode !== 'arrow' },
        horzLine: { visible: lines, labelVisible: mode !== 'arrow' },
      },
    });
  }

  digits() {
    const p = this.app.settings.precision;
    if (p !== undefined && p !== 'default') return Number(p);
    const info = this.app.symbolInfo(this.symbol);
    return info ? tickDigits(info.tick) : undefined;
  }

  priceFormat() {
    const precision = this.digits() ?? 2;
    const info = this.app.symbolInfo(this.symbol);
    const minMove = this.app.settings.precision !== 'default' && this.app.settings.precision !== undefined ? 10 ** -precision : info?.tick || 10 ** -precision;
    return { type: 'price', precision, minMove };
  }

  candleColors() {
    const s = this.app.settings;
    return {
      upColor: s.upColor,
      downColor: s.downColor,
      borderVisible: s.borderVisible !== false,
      borderUpColor: s.borderUp ?? s.upColor,
      borderDownColor: s.borderDown ?? s.downColor,
      wickVisible: s.wickVisible !== false,
      wickUpColor: s.wickUp ?? s.upColor,
      wickDownColor: s.wickDown ?? s.downColor,
    };
  }

  tick() {
    const info = this.app.symbolInfo(this.symbol);
    return info?.tick || 10 ** -(this.digits() ?? 2);
  }

  // Options for the custom-rendered chart types (session/period sizes, row sizes, colours).
  customOptions(common) {
    const s = this.app.settings;
    const cc = this.candleColors();
    const barSec = this.stepSec();
    const daily = barSec >= 86400;
    return {
      ...common,
      ...cc,
      sessionSec: daily ? 7 * 86400 : 86400,
      periodSec: daily ? 86400 : Math.max(barSec, (s.tpoPeriod ?? 30) * 60),
      barSec,
      tick: this.tick(),
      rowSize: s.tpoRows > 0 ? s.tpoRows : 0,
      valueArea: this.type === 'tpo' ? s.tpoVA ?? 70 : s.svpVA ?? 70,
      rows: s.svpRows ?? 24,
      widthPct: s.svpWidth ?? 70,
      precision: this.digits() ?? 2,
      textColor: this.app.theme === 'light' ? '#131722' : '#D1D4DC',
    };
  }

  createMainSeries() {
    const s = this.app.settings;
    const t = this.app.themeColors();
    const cc = this.candleColors();
    const common = { priceFormat: this.priceFormat(), priceLineVisible: s.showPriceLine !== false, lastValueVisible: s.showLastLabel !== false };
    if (this.main) {
      this.markersApi?.detach?.();
      this.markersApi = null;
      this.chart.removeSeries(this.main);
    }
    const factory = VIEW_FACTORIES[this.type];
    if (factory) {
      this.main = this.chart.addCustomSeries(factory(), this.customOptions(common), 0);
    } else {
      switch (this.type) {
        case 'bars':
          this.main = this.chart.addSeries(BarSeries, { ...common, upColor: cc.upColor, downColor: cc.downColor, thinBars: false }, 0);
          break;
        case 'line':
        case 'step':
        case 'linemarkers':
          this.main = this.chart.addSeries(LineSeries, {
            ...common, color: t.accent, lineWidth: 2, lineType: this.type === 'step' ? 1 : 0,
            pointMarkersVisible: this.type === 'linemarkers', pointMarkersRadius: 3,
          }, 0);
          break;
        case 'area':
          this.main = this.chart.addSeries(AreaSeries, { ...common, lineColor: t.accent, topColor: 'rgba(41,98,255,.35)', bottomColor: 'rgba(41,98,255,0)', lineWidth: 2 }, 0);
          break;
        case 'baseline':
          this.main = this.chart.addSeries(BaselineSeries, {
            ...common,
            baseValue: { type: 'price', price: this.candles[0]?.close ?? 0 },
            topLineColor: cc.upColor,
            bottomLineColor: cc.downColor,
            topFillColor1: 'rgba(8,153,129,.28)',
            topFillColor2: 'rgba(8,153,129,.05)',
            bottomFillColor1: 'rgba(242,54,69,.05)',
            bottomFillColor2: 'rgba(242,54,69,.28)',
          }, 0);
          break;
        case 'hollow':
          this.main = this.chart.addSeries(CandlestickSeries, { ...common, ...cc, upColor: 'rgba(0,0,0,0)', borderVisible: true }, 0);
          break;
        case 'renko':
        case 'linebreak':
          // Bricks and lines have no wicks.
          this.main = this.chart.addSeries(CandlestickSeries, { ...common, ...cc, wickVisible: false }, 0);
          break;
        default:
          this.main = this.chart.addSeries(CandlestickSeries, { ...common, ...cc }, 0);
      }
    }
    this.markersApi = createSeriesMarkers(this.main, this.markers);
    this.drawings.attach(this.main);
    // Custom (CandL) overlay drawings live on the main series: move them to the new one.
    for (const inst of this.indicators ?? []) {
      if (inst.primitive && !inst.host) this.main.attachPrimitive(inst.primitive);
    }
    this.alertLines.clear();
    this.positionLines = [];
    this.extraLines = {};
  }

  setType(type) {
    if (type === this.type) return;
    const prev = this.type;
    this.type = type;
    this.derivedKey = null;
    this.createMainSeries();
    if (type === 'footprint') {
      this.chart.timeScale().applyOptions({ barSpacing: 90 });
      this.loadFootprint();
    } else if (prev === 'footprint') {
      this.stopFootprint();
      this.chart.timeScale().applyOptions({ barSpacing: 7 });
    }
    this.applyData();
    if (chartTypeById(type).derived || chartTypeById(prev).derived) this.chart.timeScale().scrollToRealTime();
    this.app.refreshOverlays(this);
    this.app.saveLayout();
  }

  applyTheme() {
    this.chart.applyOptions(this.chartOptions());
    this.applyCursorMode(this.chartEl.dataset.cursor || 'cross');
    this.createMainSeries();
    this.volume.applyOptions({ visible: this.app.settings.showVolume });
    this.applyData();
    for (const inst of this.indicators) this.applyIndicatorStyle(inst, false);
    this.app.refreshOverlays(this);
    this.updateWatermark();
  }

  updateWatermark() {
    const s = this.app.settings;
    this.watermark.hidden = s.watermarkOn === false;
    this.watermark.style.color = s.watermarkColor ?? '';
    this.watermark.textContent = `${this.symbol} · ${intervalLabel(this.interval)}`;
  }

  bindChartEvents() {
    this.chart.subscribeCrosshairMove((param) => {
      this.crosshairTime = param.time ?? null;
      this.renderLegend(param);
      this.app.onCrosshair(this, param);
    });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      this.updateHighLow();
      if (!range || this.loading || this.loadingMore || this.exhausted || this.replay) return;
      if (range.from < 25) this.loadMore();
    });
    this.chartEl.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const rect = this.chartEl.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const hit = this.drawings.hitTest(x, y);
      const price = y <= this.chart.paneSize(0).height ? this.main.coordinateToPrice(y) : null;
      this.activate();
      if (hit) {
        this.drawings.selectedId = hit.d.id;
        this.drawings.changed();
      }
      this.app.chartContextMenu(this, event, price, hit?.d);
    });
  }

  activate() {
    if (this.app.activePane !== this) this.app.setActivePane(this);
  }

  // ---------------------------------------------------------------- data
  baseCandles() {
    return this.replay ? this.candles.slice(0, this.replay.index + 1) : this.candles;
  }

  // Bars actually plotted: Renko/Kagi/P&F/etc. are rebuilt from the candles; everything else
  // (drawings, indicators, legend, backtests) works on these bars, as on TradingView.
  displayCandles() {
    const base = this.baseCandles();
    if (!chartTypeById(this.type).derived) return base;
    const s = this.app.settings;
    const key = `${this.type}|${base.length}|${base[0]?.time}|${base.at(-1)?.time}|${base.at(-1)?.close}|${JSON.stringify([s.renkoMode, s.renkoAtr, s.renkoBox, s.renkoSource, s.lbLines, s.kagiMode, s.kagiAtr, s.kagiValue, s.pnfMode, s.pnfAtr, s.pnfBox, s.pnfReversal, s.pnfSource, s.rangeMode, s.rangeAtr, s.rangeValue])}`;
    if (this.derivedKey !== key) {
      this.derivedKey = key;
      this.derivedCache = deriveBars(this.type, base, s, this.tick());
    }
    return this.derivedCache;
  }

  displayTimes() {
    const bars = this.displayCandles();
    const key = `${this.type}|${bars.length}|${bars[0]?.time}|${bars.at(-1)?.time}`;
    if (this.timesKey !== key) {
      this.timesKey = key;
      this.timesCache = bars.map((c) => c.time);
    }
    return this.timesCache;
  }

  stepSec() { return intervalSec(this.interval); }

  mainData(candles, offset = 0) {
    const s = this.app.settings;
    switch (this.type) {
      case 'line':
      case 'step':
      case 'linemarkers':
      case 'area':
      case 'baseline':
        return candles.map((c) => ({ time: c.time, value: c.close }));
      case 'kagi':
      case 'pnf':
      case 'volcandles':
      case 'hlcarea':
      case 'columns':
      case 'highlow':
      case 'tpo':
      case 'svp':
        return candles.map((c) => ({ ...c, t: c.time }));
      case 'footprint':
        return candles.map((c) => ({ ...c, rows: this.footprint?.bars.get(c.time), rowSize: this.footprint?.rowSize, approx: this.footprint?.approx.has(c.time) }));
      case 'heikin':
      case 'renko':
      case 'linebreak':
      case 'range':
        return candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
      default: {
        if (!s.colorOnPrevClose) return candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
        // "Color bars based on previous close": direction compares with the prior close, not the open.
        const cc = this.candleColors();
        const all = this.displayCandles();
        return candles.map((c, i) => {
          const prev = all[offset + i - 1];
          const up = prev ? c.close >= prev.close : c.close >= c.open;
          return {
            time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
            color: this.type === 'hollow' && up ? 'rgba(0,0,0,0)' : up ? cc.upColor : cc.downColor,
            borderColor: up ? cc.borderUpColor : cc.borderDownColor,
            wickColor: up ? cc.wickUpColor : cc.wickDownColor,
          };
        });
      }
    }
  }

  volumeData(candles) {
    const t = this.app.themeColors();
    return candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? t.volUp : t.volDown }));
  }

  async load() {
    const loadId = ++this.loadId;
    this.loading = true;
    this.derivedKey = null;
    this.stopFootprint();
    this.exhausted = false;
    this.unsub?.();
    this.unsub = null;
    this.tradeUnsub?.();
    this.tradeUnsub = null;
    this.infoUnsub?.();
    this.infoUnsub = null;
    this.info = null;
    this.renderLegend();
    this.lastTradeTime = 0;
    this.exitReplay(false);
    this.setOverlay('Loading…');
    this.updateWatermark();
    this.drawings.load(this.symbol);
    this.main.applyOptions({ priceFormat: this.priceFormat() });
    try {
      const { raw } = parseSymbol(this.symbol);
      const prov = this.dataProvider();
      this.app.ensureSymbols?.(this.symbol);
      const candles = await prov.fetchKlines(raw, this.interval, { limit: 1000 });
      if (loadId !== this.loadId) return;
      if (!candles.length) throw new Error(`No data for ${this.symbol}`);
      this.candles = candles;
      if (this.type === 'baseline') this.main.applyOptions({ baseValue: { type: 'price', price: candles[0].close } });
      this.applyData();
      this.chart.timeScale().applyOptions({ barSpacing: 7 });
      this.chart.timeScale().scrollToRealTime();
      this.setOverlay(null);
      this.unsub = prov.streamBars(raw, this.interval, (bar, E) => this.onBar(bar, E));
      // Tick-by-tick candle updates from individual trades (the kline stream only pushes ~every 2s).
      this.tradeUnsub = prov.streamTrades?.(raw, (tr) => this.onTrade(tr)) ?? null;
      // Funding/mark for perpetuals; mark, IV and greeks for options.
      this.infoUnsub = prov.streamInfo?.(raw, (info) => {
        this.info = info;
        if (this.crosshairTime === null) this.scheduleInfo();
      }) ?? null;
      this.trade.refreshPanel(true);
      this.app.syncBrokerWatch?.();
      const pending = this.pendingCompares;
      this.pendingCompares = [];
      this.reloadCompares();
      for (const sym of pending) this.addCompare(sym, false);
      this.app.refreshOverlays(this);
      this.app.emitObjects(this);
      if (this.type === 'footprint') this.loadFootprint();
    } catch (error) {
      if (loadId !== this.loadId) return;
      this.setOverlay(error instanceof Error ? error.message : 'Unable to load market data');
    } finally {
      if (loadId === this.loadId) this.loading = false;
    }
  }

  // Candle source: options default to mark-price candles (see markProvider in providers.js).
  isOption() { return Boolean(parseOption(this.symbol)); }

  dataProvider() {
    if (this.isOption() && this.optPrice !== 'last') {
      if (this.markProv?.symbol !== this.symbol) this.markProv = { symbol: this.symbol, prov: markProvider(this.symbol) };
      return this.markProv.prov;
    }
    return providerFor(this.symbol);
  }

  setOptionPrice(mode) {
    if (mode === this.optPrice) return;
    this.optPrice = mode;
    this.markProv = null;
    this.load();
    this.app.saveLayout();
  }

  async loadMore() {
    if (!this.candles.length || this.candles.length >= MAX_BARS) return;
    this.loadingMore = true;
    const loadId = this.loadId;
    try {
      const older = await this.dataProvider().fetchKlines(parseSymbol(this.symbol).raw, this.interval, { limit: 1000, endTime: this.candles[0].time * 1000 - 1 });
      if (loadId !== this.loadId) return;
      if (!older.length) {
        this.exhausted = true;
        return;
      }
      const range = this.chart.timeScale().getVisibleLogicalRange();
      this.candles = [...older, ...this.candles];
      if (this.replay) this.replay.index += older.length;
      this.applyData();
      if (range) this.chart.timeScale().setVisibleLogicalRange({ from: range.from + older.length, to: range.to + older.length });
      if (older.length < 1000) this.exhausted = true;
    } catch (error) {
      console.warn('History load failed', error);
    } finally {
      this.loadingMore = false;
    }
  }

  scheduleInfo() {
    if (this.infoTimer) return;
    this.infoTimer = setTimeout(() => {
      this.infoTimer = null;
      if (this.crosshairTime === null) this.renderLegend();
    }, 500);
  }

  onBar(bar, E) {
    const last = this.candles.at(-1);
    if (!last) return;
    if (bar.time < last.time) {
      // The closing kline of the previous bar can arrive after the first trade of the next one:
      // it is final, so it replaces the trade-built values.
      const n = this.candles.length;
      if (n > 1 && this.candles[n - 2].time === bar.time) {
        this.candles[n - 2] = bar;
        if (!this.replay) this.scheduleLive();
      }
      return;
    }
    if (bar.time === last.time) {
      // Klines arrive ~every 250ms-2s and can lag the trade stream. The kline already counts the
      // trades up to its event time E, so only trades after E are added on top (adding all of
      // them double counted volume). Keep the newer close and the wider high/low.
      const after = (this.liveTrades ?? []).filter((x) => x[0] > E && x[0] >= bar.time * 1000);
      this.liveTrades = after;
      const newerTrades = this.lastTradeTime > E;
      this.candles[this.candles.length - 1] = {
        ...bar,
        high: Math.max(bar.high, last.high),
        low: Math.min(bar.low, last.low),
        close: newerTrades ? last.close : bar.close,
        volume: bar.volume + after.reduce((v, x) => v + x[1], 0),
        takerBuy: (bar.takerBuy ?? 0) + after.reduce((v, x) => v + (x[2] ? x[1] : 0), 0),
      };
    } else {
      this.liveTrades = [];
      this.candles.push(bar);
    }
    if (this.replay) return;
    this.scheduleLive();
  }

  onTrade(tr) {
    const { price, qty, time: t } = tr;
    if (!(price > 0) || t < this.lastTradeTime) return;
    this.lastTradeTime = t;
    const step = this.stepSec();
    const barTime = Math.floor(t / 1000 / step) * step;
    const last = this.candles.at(-1);
    if (!last || barTime < last.time) return;
    if (barTime === last.time) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += qty;
      if (!tr.buyerMaker) last.takerBuy = (last.takerBuy ?? 0) + qty;
      (this.liveTrades ??= []).push([t, qty, !tr.buyerMaker]);
    } else if (step < 604800) {
      this.liveTrades = [[t, qty, !tr.buyerMaker]];
      // A new bar opens on the first trade after the boundary (weekly/monthly wait for klines).
      this.candles.push({ time: barTime, open: price, high: price, low: price, close: price, volume: qty, quoteVolume: price * qty, trades: 1, takerBuy: tr.buyerMaker ? 0 : qty });
    }
    pushPrice(this.symbol, price);
    if (this.replay) return;
    this.scheduleLive();
  }

  // Repaint on the next animation frame, at most ~12 times a second (indicators recompute too).
  scheduleLive() {
    if (this.liveTimer) return;
    const wait = Math.max(0, 80 - (performance.now() - (this.lastLive ?? 0)));
    this.liveTimer = setTimeout(() => requestAnimationFrame(() => {
      this.liveTimer = null;
      this.lastLive = performance.now();
      this.applyLive();
    }), wait);
  }

  applyLive() {
    if (this.destroyed) return;
    const candles = this.displayCandles();
    const last = candles.at(-1);
    if (!last) return;
    const ct = chartTypeById(this.type);
    if (ct.derived || ct.custom) {
      this.main.setData(this.mainData(candles));
      this.volume.setData(this.volumeData(candles));
    } else {
      this.main.update(this.mainData([last], candles.length - 1)[0]);
      this.volume.update(this.volumeData([last])[0]);
    }
    this.computeIndicators(true);
    this.drawings.update();
    this.updateCountdown();
    if (this.crosshairTime === null) this.renderLegend();
  }

  // ---------------------------------------------------------------- volume footprint data
  // Recent bars are exact: every aggregated trade (price, size, aggressor side) from Binance.
  // Older bars, beyond the request budget, are estimated from the finest sub-interval klines
  // (taker-buy volume spread over each sub-bar's range) and marked "≈". Live trades are
  // subscribed before history loads and de-duplicated by trade id, so none are lost or doubled.
  async loadFootprint() {
    this.stopFootprint();
    const prov = providerFor(this.symbol);
    if (!prov.footprint) {
      toast('Volume footprint needs buy/sell volume, available for Binance spot and perpetuals only.', 'info', 5000);
      return;
    }
    const token = (this.fpToken = {});
    const raw = parseSymbol(this.symbol).raw;
    const bar = this.stepSec();
    const keyOf = (ms) => bucketStart(Math.floor(ms / 1000), this.interval);
    const recent = this.candles.slice(-Math.min(this.app.settings.fpBars ?? 200, this.candles.length));
    if (!recent.length) return;
    const avgRange = recent.reduce((x, c) => x + (c.high - c.low), 0) / recent.length;
    const rowSize = niceStep(avgRange / 12, this.tick());
    const fp = (this.footprint = { rowSize, bars: new Map(), approx: new Set() });
    const add = (tr) => {
      const t = keyOf(tr.time);
      if (!fp.bars.has(t)) fp.bars.set(t, []);
      // m = buyer is the maker, so the aggressor was a seller.
      addTradeToRows(fp.bars.get(t), tr.price, tr.qty, !tr.buyerMaker, rowSize);
    };

    let pending = [];
    let lastId = -1;
    let liveFrom = 0;
    this.fpUnsub = prov.streamTrades?.(raw, (tr) => {
      if (token !== this.fpToken) return;
      if (pending) { pending.push(tr); return; }
      if (tr.id !== undefined ? tr.id > lastId : tr.time >= liveFrom) { add(tr); this.scheduleLive(); }
    });

    this.setOverlay('Loading footprint from trades…');
    try {
      // 1) Exact bars, newest first, within a request budget (futures aggTrades weigh 20x more).
      //    Plan from each bar's trade count (Binance aggregates ~4 trades per aggTrade, so 0.4
      //    leaves headroom), then load the planned bars in parallel. Each bar stops where the
      //    next bar's first trade id begins, so bars never overlap.
      const n = recent.length;
      const endMs = (i) => (i + 1 < n ? recent[i + 1].time : recent[i].time + bar) * 1000;
      let budget = prov.id === 'perp' ? 30 : 200;
      const plan = [];
      for (let i = n - 1; i >= 0; i--) {
        const pages = Math.ceil(((recent[i].trades || 1000) * 0.4) / 1000) + 1;
        if (1 + pages > budget) break;
        budget -= 1 + pages;
        plan.push({ i, cap: pages * 2 });
      }
      const pool = async (items, fn, size = 8) => {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
          while (next < items.length && token === this.fpToken) await fn(items[next++]);
        }));
      };
      const firstIds = new Map();
      await pool(plan, async ({ i }) => {
        const head = await prov.fetchAggTrades(raw, { startTime: recent[i].time * 1000, endTime: Math.min(endMs(i), recent[i].time * 1000 + 3_600_000) - 1, limit: 1 });
        firstIds.set(i, head[0]?.id ?? null);
      });
      if (token !== this.fpToken) return;
      // Only the contiguous run from the newest bar back to the first bar without a known start.
      const run = [];
      for (const step of plan) { if (firstIds.get(step.i) == null) break; run.push(step); }
      const exact = new Map();
      await pool(run, async ({ i, cap }) => {
        const stopId = i + 1 < n ? firstIds.get(i + 1) : null;
        const t1 = endMs(i);
        const rows = [];
        let from = firstIds.get(i);
        let last = from - 1;
        for (let k = 0; ; k++) {
          if (k >= cap) return; // far more trades than expected: leave it to the estimate
          const page = await prov.fetchAggTrades(raw, { fromId: from });
          if (token !== this.fpToken) return;
          let done = page.length < 1000;
          for (const tr of page) {
            if ((stopId != null && tr.id >= stopId) || tr.time >= t1) { done = true; break; }
            addTradeToRows(rows, tr.price, tr.qty, !tr.buyerMaker, rowSize);
            last = tr.id;
          }
          if (done) break;
          from = page.at(-1).id + 1;
        }
        exact.set(i, { rows, last });
      });
      if (token !== this.fpToken) return;
      for (const [i, { rows }] of exact) fp.bars.set(recent[i].time, rows);
      if (exact.has(n - 1)) lastId = exact.get(n - 1).last;
      // Live trades that arrived meanwhile: keep only those after the loaded history.
      const buffered = pending;
      pending = null;
      if (!exact.has(n - 1)) liveFrom = Date.now(); // newest bar not exact (kline-estimated)
      for (const tr of buffered) if (tr.id !== undefined ? tr.id > lastId : tr.time >= liveFrom) add(tr);
      this.applyData();

      // 2) Estimated bars: finest sub-interval klines that fit 15 requests (fetched in parallel);
      //    if even the coarsest does not cover everything, the newest bars get it. Bars with no
      //    finer data (e.g. 1m futures) spread their own candle over their range.
      const older = recent.filter((_, i) => !exact.has(i));
      if (older.length) {
        const SUBS = [['1s', 1], ['1m', 60], ['3m', 180], ['5m', 300], ['15m', 900], ['30m', 1800], ['1h', 3600], ['4h', 14400]]
          .filter(([, sec]) => sec >= (prov.minKlineSec ?? 60) && sec < bar && bar / sec >= 3);
        const MAX_REQ = 15;
        const [sub, subSec] = SUBS.find(([, sec]) => (older.length * bar) / sec / 1000 <= MAX_REQ) ?? SUBS.at(-1) ?? [];
        const byBar = new Map();
        if (sub) {
          this.setOverlay(`Estimating ${older.length} older bars (${sub} detail)…`);
          const endAll = endMs(recent.indexOf(older.at(-1)));
          const startAll = Math.max(older[0].time * 1000, endAll - MAX_REQ * 1000 * subSec * 1000);
          const windows = [];
          for (let t = startAll; t < endAll; t += 1000 * subSec * 1000) windows.push(t);
          const chunks = [];
          await pool(windows, async (t) => {
            chunks.push(await prov.fetchKlines(raw, sub, { limit: 1000, startTime: t, endTime: Math.min(endAll, t + 1000 * subSec * 1000) - 1 }));
          }, 4);
          if (token !== this.fpToken) return;
          for (const k of chunks.flat()) {
            const t = keyOf(k.time * 1000);
            if (!byBar.has(t)) byBar.set(t, []);
            byBar.get(t).push(k);
          }
        }
        for (const c of older) {
          const parts = byBar.get(c.time);
          fp.bars.set(c.time, footprintRows(parts?.length ? parts : [c], rowSize));
          fp.approx.add(c.time);
        }
      }
    } catch (error) {
      if (pending) { pending = null; liveFrom = Date.now(); }
      toast(`Footprint history failed: ${error.message}`, 'error');
    } finally {
      if (token === this.fpToken) this.setOverlay(null);
    }
    if (token !== this.fpToken || this.type !== 'footprint') return;
    this.applyData();
  }

  stopFootprint() {
    this.fpToken = null;
    this.fpUnsub?.();
    this.fpUnsub = null;
  }

  applyData() {
    const candles = this.displayCandles();
    this.main.setData(this.mainData(candles));
    this.volume.setData(this.volumeData(candles));
    this.computeIndicators();
    this.markersApi?.setMarkers(this.markers);
    this.drawings.update();
    this.updatePrevClose();
    this.updateHighLow();
    this.updateCountdown();
    this.renderLegend();
  }

  setOverlay(text) {
    this.overlay.hidden = !text;
    this.overlay.textContent = text ?? '';
  }

  setSymbol(symbol) {
    if (!symbol || symbol === this.symbol) return;
    this.symbol = symbol;
    this.setMarkers([]);
    this.load();
    this.app.saveLayout();
    this.app.onPaneSymbolChange(this);
  }

  setInterval(interval) {
    if (interval === this.interval) return;
    this.interval = interval;
    this.setMarkers([]);
    this.load();
    for (const inst of this.indicators) this.applyIndicatorStyle(inst, false);
    this.app.saveLayout();
    this.app.onPaneSymbolChange(this);
  }

  setScaleMode(mode) {
    this.scaleMode = mode;
    this.chart.priceScale('right').applyOptions({ mode });
    this.app.saveLayout();
    this.app.onPaneSymbolChange(this);
  }

  // ---------------------------------------------------------------- extra price lines
  setExtraLine(key, opts) {
    const existing = this.extraLines[key];
    if (!opts) {
      if (existing) this.main.removePriceLine(existing);
      delete this.extraLines[key];
      return;
    }
    if (existing) existing.applyOptions(opts);
    else this.extraLines[key] = this.main.createPriceLine(opts);
  }

  // Countdown to bar close, shown as a second axis label under the last price (TradingView style).
  // Countdown to bar close, drawn as a second axis label directly under the last-price label
  // (TradingView style) instead of a separate price line that repeated the price.
  updateCountdown() {
    if (this.destroyed) return;
    const last = this.displayCandles().at(-1);
    const s = this.app.settings;
    if (!s.countdown || !last || this.replay || s.showLastLabel === false || chartTypeById(this.type).derived) {
      this.countdown = null;
    } else {
      const left = Math.max(0, last.time + this.stepSec() - Math.floor(Date.now() / 1000));
      const hh = Math.floor(left / 3600);
      const mm = Math.floor((left % 3600) / 60);
      const ss = left % 60;
      const text = left >= 86400
        ? `${Math.floor(left / 86400)}d ${hh % 24}h`
        : `${hh ? `${String(hh).padStart(2, '0')}:` : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      this.countdown = { text, price: last.close, up: last.close >= last.open };
    }
    this.drawings.requestUpdate?.();
  }

  axisViews() {
    const cd = this.countdown;
    if (!cd) return [];
    const pane = this;
    const fontSize = this.app.settings.scaleFont ?? 11;
    return [{
      coordinate: () => {
        const y = pane.main.priceToCoordinate(cd.price);
        return y === null ? -100 : y + fontSize + 8;
      },
      text: () => cd.text,
      textColor: () => '#FFFFFF',
      backColor: () => (cd.up ? pane.app.settings.upColor : pane.app.settings.downColor),
      visible: () => true,
      tickVisible: () => false,
    }];
  }

  updatePrevClose() {
    const candles = this.displayCandles();
    if (!this.app.settings.showPrevClose || !candles.length) {
      this.setExtraLine('prevClose', null);
      return;
    }
    const dayStart = Math.floor(candles.at(-1).time / 86400) * 86400;
    const idx = lowerBound(candles, dayStart, (c) => c.time) - 1;
    const prev = candles[idx];
    if (!prev) { this.setExtraLine('prevClose', null); return; }
    this.setExtraLine('prevClose', { price: prev.close, color: '#787B86', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Prev close' });
  }

  updateHighLow() {
    if (!this.app.settings.showHighLow || !this.candles.length) {
      this.setExtraLine('high', null);
      this.setExtraLine('low', null);
      return;
    }
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const candles = this.displayCandles();
    const i0 = Math.max(0, Math.floor(range?.from ?? 0));
    const i1 = Math.min(candles.length - 1, Math.ceil(range?.to ?? candles.length - 1));
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = i0; i <= i1; i++) {
      hi = Math.max(hi, candles[i].high);
      lo = Math.min(lo, candles[i].low);
    }
    if (!Number.isFinite(hi)) return;
    this.setExtraLine('high', { price: hi, color: '#787B86', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'High' });
    this.setExtraLine('low', { price: lo, color: '#787B86', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'Low' });
  }

  // ---------------------------------------------------------------- indicators
  addIndicator(id, saved = {}, save = true) {
    const def = indicatorById(id);
    if (!def) return null;
    const userDefaults = store.get(`indDefaults.${id}`, null) ?? {};
    const inst = {
      uid: uid(),
      def,
      params: { ...defaultParams(def), ...userDefaults.params, ...saved.params },
      styles: JSON.parse(JSON.stringify({ ...userDefaults.styles, ...saved.styles })),
      visible: saved.visible ?? true,
      precision: saved.precision ?? 'default',
      showLabels: saved.showLabels ?? true,
      showValues: saved.showValues ?? true,
      levelsCfg: saved.levelsCfg ?? (def.levels ?? []).map((price) => ({ price, color: this.app.themeColors().levels, on: true })),
      vis: saved.vis ?? defaultVisibility(),
      series: [],
      levelLines: [],
    };
    const paneIndex = def.overlay ? 0 : this.chart.panes().length;
    if (def.candl) this.setupCustomIndicator(inst, paneIndex);
    for (const plot of def.plots) {
      const series = plot.type === 'histogram'
        ? this.chart.addSeries(HistogramSeries, { color: plot.color, priceLineVisible: false, lastValueVisible: false, priceFormat: id === 'volma' ? { type: 'volume' } : { type: 'price', precision: 4, minMove: 0.0001 } }, paneIndex)
        : this.chart.addSeries(LineSeries, {
          color: plot.color,
          lineWidth: plot.lineWidth ?? 1.5,
          priceLineVisible: false,
          crosshairMarkerVisible: !plot.dots,
          ...(plot.dots ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.6 } : {}),
          ...(def.overlay ? {} : { priceFormat: id === 'obv' ? { type: 'volume' } : { type: 'price', precision: 2, minMove: 0.01 } }),
        }, paneIndex);
      inst.series.push(series);
    }
    if (!def.overlay) {
      // Main pane keeps ~3x the height of each indicator pane, however many are added.
      const panes = this.chart.panes();
      panes[0]?.setStretchFactor(3);
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
    }
    this.indicators.push(inst);
    this.applyIndicatorStyle(inst, false);
    if (this.candles.length) this.computeIndicator(inst);
    this.renderLegend();
    if (save) {
      this.app.saveLayout();
      this.app.emitObjects(this);
    }
    return inst;
  }

  // Push an indicator's style/visibility/levels settings onto its series.
  applyIndicatorStyle(inst, recompute = true) {
    const def = inst.def;
    const shownOnInterval = visibleOnInterval(inst.vis, this.interval);
    if (def.candl) {
      inst.shown = shownOnInterval;
      for (const out of inst.lastOutputs ?? []) inst.outSeries.get(out.name)?.applyOptions(outputSeriesOptions(out, inst, def.overlay));
      inst.primitive?.update();
      if (recompute) {
        this.computeIndicator(inst);
        this.renderLegend();
        this.app.saveLayout();
        this.app.emitObjects(this);
      }
      return;
    }
    def.plots.forEach((plot, i) => {
      const st = { color: plot.color, lineWidth: plot.lineWidth ?? 1.5, lineStyle: 0, visible: true, ...inst.styles[plot.key] };
      const opts = {
        color: st.color,
        visible: inst.visible && st.visible !== false && shownOnInterval,
        lastValueVisible: inst.showLabels !== false && (plot.type !== 'histogram' || def.id === 'macd') && (!def.overlay || def.plots.length === 1),
      };
      if (plot.type !== 'histogram') Object.assign(opts, { lineWidth: st.lineWidth, lineStyle: st.lineStyle ?? 0 });
      if (inst.precision !== 'default' && inst.precision !== undefined && !def.overlay) {
        const p = Number(inst.precision);
        opts.priceFormat = { type: 'price', precision: p, minMove: 10 ** -p };
      }
      inst.series[i].applyOptions(opts);
    });
    const host = inst.series.at(-1);
    for (const line of inst.levelLines) host.removePriceLine(line);
    inst.levelLines = (inst.levelsCfg ?? []).filter((l) => l.on).map((l) => host.createPriceLine({
      price: l.price, color: l.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false,
    }));
    if (recompute) {
      this.computeIndicator(inst);
      this.renderLegend();
      this.app.saveLayout();
      this.app.emitObjects(this);
    }
  }

  resetIndicator(inst) {
    inst.params = defaultParams(inst.def);
    inst.styles = {};
    inst.precision = 'default';
    inst.showLabels = true;
    inst.showValues = true;
    inst.levelsCfg = (inst.def.levels ?? []).map((price) => ({ price, color: this.app.themeColors().levels, on: true }));
    inst.vis = defaultVisibility();
    this.applyIndicatorStyle(inst, true);
  }

  removeIndicator(instUid) {
    const inst = this.indicators.find((i) => i.uid === instUid);
    if (!inst) return;
    // Out of the list first: removing a series can fire a crosshair update that re-renders legends.
    this.indicators = this.indicators.filter((i) => i !== inst);
    if (inst.primitive && !inst.host) this.main.detachPrimitive(inst.primitive);
    clearTimeout(inst.liveTimer);
    inst.removed = true;
    for (const s of inst.series) this.chart.removeSeries(s);
    const panes = this.chart.panes();
    for (let i = panes.length - 1; i > 0; i--) {
      if (!panes[i].getSeries().length) this.chart.removePane(i);
    }
    this.renderLegend();
    this.app.saveLayout();
    this.app.emitObjects(this);
  }

  removeAllIndicators() {
    for (const inst of [...this.indicators]) this.removeIndicator(inst.uid);
  }

  toggleIndicator(instUid) {
    const inst = this.indicators.find((i) => i.uid === instUid);
    if (!inst) return;
    inst.visible = !inst.visible;
    this.applyIndicatorStyle(inst, true);
  }

  setIndicatorsVisible(visible) {
    for (const inst of this.indicators) {
      inst.visible = visible;
      this.applyIndicatorStyle(inst, false);
    }
    this.renderLegend();
    this.app.saveLayout();
  }

  editIndicator(instUid) {
    const inst = this.indicators.find((i) => i.uid === instUid);
    if (inst) openIndicatorSettings(this, inst);
  }

  computeIndicators(live = false) {
    for (const inst of this.indicators) this.computeIndicator(inst, live);
  }

  computeIndicator(inst, live = false) {
    if (inst.def.candl) {
      this.computeCustomIndicator(inst, live);
      return;
    }
    const candles = this.displayCandles();
    if (!candles.length) return;
    let result;
    try {
      result = inst.def.calc(candles, inst.params);
    } catch (error) {
      console.error(`Indicator ${inst.def.id} failed`, error);
      return;
    }
    inst.last = result;
    inst.def.plots.forEach((plot, i) => {
      const st = { ...plot, ...inst.styles[plot.key] };
      const down = st.downColor ?? plot.downColor;
      const values = result[plot.key] ?? [];
      const data = [];
      for (let k = 0; k < candles.length; k++) {
        const v = values[k];
        if (v === undefined || !Number.isFinite(v)) continue;
        const point = { time: candles[k].time, value: v };
        if (plot.colorBy === 'dir') point.color = result.dir?.[k] === -1 ? down : st.color;
        else if (plot.colorBy === 'sign') point.color = v >= 0 ? st.color : down;
        else if (plot.colorBy === 'candle') point.color = candles[k].close >= candles[k].open ? st.color : down;
        data.push(point);
      }
      inst.series[i].setData(data);
    });
  }

  indicatorLabel(inst, withArgs = true) {
    if (inst.def.candl) return inst.def.short;
    const vals = Object.values(inst.params).filter((v) => v !== 'close' && v !== 'Session');
    return `${inst.def.short}${withArgs && vals.length ? ` ${vals.join(' ')}` : ''}`;
  }

  valuesAt(inst, time) {
    const candles = this.displayCandles();
    if (!inst.last || !candles.length) return [];
    let idx = candles.length - 1;
    if (time !== null && time !== undefined) {
      idx = lowerBound(candles, time, (c) => c.time);
      if (candles[idx]?.time !== time) return [];
    }
    if (inst.def.candl) {
      return (inst.lastOutputs ?? []).filter((o) => inst.styles[o.name]?.visible !== false).slice(0, 8)
        .map((o) => ({ plot: { key: o.name, title: o.name }, value: o.values[idx] ?? undefined, color: inst.styles[o.name]?.color ?? o.color }));
    }
    return inst.def.plots.map((plot) => ({ plot, value: inst.last[plot.key]?.[idx], color: inst.styles[plot.key]?.color ?? plot.color }));
  }

  // ---------------------------------------------------------------- custom (CandL) indicators
  // Pane indicators get a host series in their own pane (it keeps the pane alive, carries the
  // fixed range and hosts the canvas primitive); overlays draw on the main series.
  setupCustomIndicator(inst, paneIndex) {
    const def = inst.def;
    inst.outSeries = new Map();
    if (!def.overlay) {
      inst.host = this.chart.addSeries(LineSeries, {
        color: 'rgba(0,0,0,0)', lineVisible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        ...(def.range ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: def.range[0], maxValue: def.range[1] } }) } : {}),
      }, paneIndex);
      inst.series.push(inst.host);
    }
    if (def.canvas || def.signals) {
      inst.primitive = new CandlPrimitive(this, inst);
      (inst.host ?? this.main).attachPrimitive(inst.primitive);
    }
    if (def.id === 'dom_heatmap') startDomFeed(this.symbol, () => inst.primitive?.update());
  }

  // What CandL hands its indicators: market name, chart type, interval, Renko box and, at draw
  // time, the right-gutter and bar-centre helpers.
  candlContext(drawTime = false) {
    const ctx = { symbol: candlSymbol(this.symbol), chartType: this.type, interval: this.interval, renkoBox: 0 };
    if (this.type === 'renko') {
      const bricks = this.displayCandles();
      ctx.renkoBox = bricks.length ? Math.abs(bricks.at(-1).close - bricks.at(-1).open) : 0;
    }
    if (drawTime) {
      const ts = this.chart.timeScale();
      ctx.barX = (index) => ts.logicalToCoordinate(index) ?? NaN;
      ctx.ensureRightGutter = (px) => this.ensureRightGutter(px);
    }
    return ctx;
  }

  ensureRightGutter(px) {
    const ts = this.chart.timeScale();
    const need = Math.ceil(px / Math.max(1, ts.options().barSpacing));
    if ((ts.options().rightOffset ?? 0) >= need || this.gutterPending) return;
    this.gutterPending = true;
    setTimeout(() => {
      this.gutterPending = false;
      if (!this.destroyed) ts.applyOptions({ rightOffset: need });
    }, 0);
  }

  computeCustomIndicator(inst, live = false) {
    // Live ticks: at most ~3 recomputes a second per custom indicator (some model whole sessions).
    if (live) {
      const wait = 350 - (performance.now() - (inst.computedAt ?? 0));
      if (wait > 0) {
        if (!inst.liveTimer) inst.liveTimer = setTimeout(() => { inst.liveTimer = null; this.computeCustomIndicator(inst); }, wait);
        return;
      }
    }
    if (this.destroyed || inst.removed) return;
    const candles = this.displayCandles();
    if (!candles.length) return;
    inst.computedAt = performance.now();
    const def = inst.def;
    const cc = toCandl(candles);
    inst.candlCandles = cc;
    if ((def.id === 'bullseye_of' || def.id === 'the_map_v3') && this.footprint) publishFootprint(this);
    let outs = [];
    try {
      outs = def.candl.compute(cc, inst.params) ?? [];
    } catch (error) {
      console.error(`Custom indicator ${def.id} failed`, error);
    }
    inst.lastOutputs = outs;
    inst.last = Object.fromEntries(outs.map((o) => [o.name, o.values]));
    const paneIndex = def.overlay ? 0 : inst.host.getPane().paneIndex();
    const seen = new Set();
    for (const out of outs) {
      seen.add(out.name);
      let series = inst.outSeries.get(out.name);
      if (!series) {
        series = createOutputSeries(this.chart, out, paneIndex);
        inst.outSeries.set(out.name, series);
        inst.series.push(series);
      }
      const opts = outputSeriesOptions(out, inst, def.overlay);
      series.applyOptions(opts);
      series.setData(outputData(out, candles, opts.color));
    }
    for (const [name, series] of inst.outSeries) {
      if (seen.has(name)) continue;
      this.chart.removeSeries(series);
      inst.outSeries.delete(name);
      inst.series = inst.series.filter((x) => x !== series);
    }
    const sig = getSignalSource(def.id);
    if (sig) {
      try { inst.signalList = sig(cc, inst.params); } catch (error) { console.error(`Custom indicator ${def.id} signals failed`, error); }
    }
    const src = getCanvasSource(def.id);
    if (src && def.id !== 'dom_heatmap') {
      try {
        const res = src.compute(cc, inst.params, this.candlContext(false));
        if (res && typeof res.then === 'function') {
          res.then((m) => { if (inst.candlCandles === cc) { inst.model = m; inst.primitive?.update(); } })
            .catch((error) => console.error(`Custom indicator ${def.id} failed`, error));
        } else {
          inst.model = res;
        }
      } catch (error) {
        console.error(`Custom indicator ${def.id} failed`, error);
      }
    }
    inst.drawError = false;
    inst.primitive?.update();
  }

  // ---------------------------------------------------------------- compare
  async addCompare(symbol, save = true) {
    if (symbol === this.symbol || this.compares.some((c) => c.symbol === symbol)) return;
    const color = COMPARE_COLORS[this.compares.length % COMPARE_COLORS.length];
    const series = this.chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: symbol }, 0);
    const cmp = { symbol, series, color };
    this.compares.push(cmp);
    if (this.scaleMode !== PriceScaleMode.Percentage) this.setScaleMode(PriceScaleMode.Percentage);
    await this.loadCompare(cmp);
    this.renderLegend();
    if (save) {
      this.app.saveLayout();
      this.app.emitObjects(this);
    }
  }

  async loadCompare(cmp) {
    cmp.unsub?.();
    try {
      const from = this.candles[0]?.time;
      const { raw } = parseSymbol(cmp.symbol);
      const candles = await providerFor(cmp.symbol).fetchKlines(raw, this.interval, { limit: 1000 });
      if (!this.compares.includes(cmp)) return;
      cmp.series.setData(candles.filter((c) => !from || c.time >= from).map((c) => ({ time: c.time, value: c.close })));
      cmp.unsub = providerFor(cmp.symbol).streamBars(raw, this.interval, (bar) => {
        cmp.series.update({ time: bar.time, value: bar.close });
      });
    } catch (error) {
      toast(`Compare ${cmp.symbol} failed: ${error.message}`, 'error');
    }
  }

  reloadCompares() {
    for (const cmp of this.compares) this.loadCompare(cmp);
  }

  removeCompare(symbol) {
    const cmp = this.compares.find((c) => c.symbol === symbol);
    if (!cmp) return;
    cmp.unsub?.();
    this.chart.removeSeries(cmp.series);
    this.compares = this.compares.filter((c) => c !== cmp);
    if (!this.compares.length && this.scaleMode === PriceScaleMode.Percentage) this.setScaleMode(PriceScaleMode.Normal);
    this.renderLegend();
    this.app.saveLayout();
    this.app.emitObjects(this);
  }

  // ---------------------------------------------------------------- overlays: alerts, positions, markers
  setAlertLines(alerts) {
    const s = this.app.settings;
    const wanted = new Set();
    for (const alert of alerts) {
      if (alert.symbol !== this.symbol || !alert.active || s.showAlertLines === false) continue;
      wanted.add(alert.id);
      const opts = { price: alert.price, color: s.alertColor ?? '#FF9800', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Alert' };
      const line = this.alertLines.get(alert.id);
      if (line) line.applyOptions(opts);
      else this.alertLines.set(alert.id, this.main.createPriceLine(opts));
    }
    for (const [id, line] of this.alertLines) {
      if (!wanted.has(id)) {
        this.main.removePriceLine(line);
        this.alertLines.delete(id);
      }
    }
  }

  // Positions, orders, TP/SL and executions are painted by the TradeOverlay.
  setPositionLines() {
    this.drawings.update();
    this.trade?.refreshPanel();
  }

  setMarkers(markers) {
    this.markers = markers;
    this.markersApi?.setMarkers(markers);
  }

  // ---------------------------------------------------------------- status line (legend)
  barAt(time) {
    const candles = this.displayCandles();
    if (time !== null && time !== undefined) {
      const idx = lowerBound(candles, time, (c) => c.time);
      if (candles[idx]?.time === time) return { bar: candles[idx], prev: candles[idx - 1] };
    }
    return { bar: candles.at(-1), prev: candles.at(-2) };
  }

  toggleLegend(force) {
    this.legendCollapsed = force ?? !this.legendCollapsed;
    this.updateLegendToggle(this.legendRest?.childElementCount ?? 0);
    this.app.persistLayout?.();
  }

  updateLegendToggle(count) {
    if (!this.legendToggle) return;
    const collapsed = this.legendCollapsed;
    this.legendFold.classList.toggle('collapsed', collapsed);
    this.legendFold.inert = collapsed;
    this.legendToggle.hidden = count === 0;
    this.legendToggle.classList.toggle('collapsed', collapsed);
    this.legendToggle.title = collapsed ? 'Show indicator legend' : 'Hide indicator legend';
    this.legendToggle.setAttribute('aria-expanded', String(!collapsed));
    const key = `${collapsed}|${count}`;
    if (this.legendToggle.dataset.key === key) return;
    this.legendToggle.dataset.key = key;
    this.legendToggle.replaceChildren(
      h('span', { class: 'legend-chev', 'aria-hidden': 'true', html: '<svg viewBox="0 0 18 18" width="14" height="14"><path d="M5 7.5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
    );
    if (collapsed) this.legendToggle.append(h('span', { class: 'legend-count' }, String(count)));
  }

  renderLegend(param) {
    if (this.destroyed) return;
    const s = this.app.settings;
    const time = param?.time ?? null;
    const { bar, prev } = this.barAt(time);
    const d = this.digits();
    const change = bar && prev ? bar.close - prev.close : null;
    const changePct = change !== null ? (change / prev.close) * 100 : null;
    const cls = signClass(bar ? bar.close - bar.open : 0);
    const info = this.app.symbolInfo(this.symbol);
    const ticker = info ? `${info.base}/${info.quote}` : this.symbol;
    const description = info ? `${info.base} / ${info.quote}` : this.symbol;
    const optTitle = optionTitle(this.symbol);
    const tickerTitle = optTitle ?? (parseSymbol(this.symbol).provider === 'perp' ? `${ticker} Perpetual` : ticker);
    const title = s.legendTitle === 'description' ? optTitle ?? description : s.legendTitle === 'both' ? `${this.symbol} · ${optTitle ?? description}` : tickerTitle;
    const top = h('div', { class: 'legend-row legend-main', 'data-key': `top|${this.symbol}` },
      h('button', { type: 'button', class: 'legend-symbol', title: 'Change symbol', onclick: () => { this.activate(); this.app.openSymbolSearch(); } }, h('strong', {}, title)),
      h('span', { class: 'legend-meta' }, `${intervalLabel(this.interval)} · ${PROVIDER_INFO[parseSymbol(this.symbol).provider].short}`),
      this.isOption() ? h('span', { class: 'opt-price-toggle', role: 'group', 'aria-label': 'Candle price' },
        ...[['mark', 'Mark', 'Mark-price candles: history modelled from the underlying with the current mark IV (anchored to the exchange mark now); live bars are the exchange mark price'],
          ['last', 'Last', 'Last-trade candles from the exchange (options trade rarely, so these are sparse)']]
          .map(([id, label, tip]) => h('button', { type: 'button', class: this.optPrice === id ? 'active' : '', title: tip, onclick: () => this.setOptionPrice(id) }, label))) : null,
      h('span', { class: `legend-dot ${this.app.hubStatus === 'live' ? 'live' : ''}`, title: `Stream: ${this.app.hubStatus}` }),
      this.replay ? h('span', { class: 'legend-badge' }, 'REPLAY') : null,
      bar && s.showOHLC !== false ? h('span', { class: `legend-ohlc ${cls}` },
        h('span', {}, 'O', h('b', {}, formatPrice(bar.open, d))),
        h('span', {}, 'H', h('b', {}, formatPrice(bar.high, d))),
        h('span', {}, 'L', h('b', {}, formatPrice(bar.low, d))),
        h('span', {}, 'C', h('b', {}, formatPrice(bar.close, d))),
        change !== null && s.showBarChange !== false ? h('b', {}, `${change >= 0 ? '+' : ''}${formatPrice(change, d)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`) : null) : null);
    const rows = [top];
    const infoRow = this.infoRow();
    if (s.showVolume && s.showVolumeLegend !== false && bar) {
      rows.push(h('div', { class: 'legend-row', 'data-key': 'volume' }, h('span', { class: 'legend-name' }, 'Volume'), h('b', { class: cls }, formatCompact(bar.volume))));
    }
    for (const cmp of this.compares) {
      rows.push(h('div', { class: 'legend-row', 'data-key': `cmp|${cmp.symbol}` },
        h('span', { class: 'legend-swatch', style: { background: cmp.color } }),
        h('span', { class: 'legend-name' }, cmp.symbol),
        h('span', { class: 'legend-actions' }, h('button', { type: 'button', title: 'Remove compare', 'aria-label': `Remove ${cmp.symbol}`, onclick: () => this.removeCompare(cmp.symbol) }, '✕'))));
    }
    for (const inst of this.indicators.filter((i) => i.def.overlay)) rows.push(this.indicatorLegendRow(inst, time));
    this.legend.classList.toggle('with-bg', Boolean(s.legendBg));
    // Fixed slots: symbol line, then the Sell/Buy panel, then everything else. The panel node is
    // never re-inserted, so typing a quantity is not interrupted by live legend updates, and it
    // flows under the symbol line instead of overlapping it on narrow panes.
    if (!this.legendRest) {
      this.legendTop = h('div', { class: 'legend-slot' });
      this.legendRest = h('div', { class: 'legend-slot' });
      // Grid-row animation (0fr ↔ 1fr) gives a smooth height transition without measuring.
      this.legendFold = h('div', { class: 'legend-fold' }, this.legendRest);
      this.legendToggle = h('button', { type: 'button', class: 'legend-toggle', onclick: () => this.toggleLegend() });
      this.legend.replaceChildren(this.legendTop, ...(this.trade?.panel ? [this.trade.panel] : []), this.legendFold, this.legendToggle);
    }
    patchChildren(this.legendTop, [rows[0], infoRow].filter(Boolean));
    const rest = rows.slice(1);
    patchChildren(this.legendRest, rest);
    this.updateLegendToggle(rest.length);
    this.renderSubLegends(time);
  }

  // Second status line: mark/funding for perpetuals, mark/IV/greeks for options.
  infoRow() {
    const i = this.info;
    if (!i) return null;
    const d = this.digits();
    const fmt = (v, digits = 4) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
    const parts = [];
    if (Number.isFinite(i.mark)) parts.push(['Mark', formatPrice(i.mark, d)]);
    if (Number.isFinite(i.index)) parts.push(['Index', formatPrice(i.index, i.index >= 100 ? 2 : 4)]);
    if (i.option || Number.isFinite(i.delta)) {
      if (Number.isFinite(i.iv)) parts.push(['IV', `${(i.iv * 100).toFixed(1)}%`]);
      parts.push(['Δ', fmt(i.delta, 3)], ['Γ', fmt(i.gamma, 5)], ['Θ', fmt(i.theta, 2)], ['V', fmt(i.vega, 2)]);
      if (Number.isFinite(i.bid) && Number.isFinite(i.ask)) parts.push(['Bid/Ask', `${formatPrice(i.bid, d)} / ${formatPrice(i.ask, d)}`]);
    } else if (Number.isFinite(i.funding)) {
      const left = i.nextFunding ? Math.max(0, i.nextFunding - Date.now()) : null;
      const hhmmss = left === null ? '' : ` in ${new Date(left).toISOString().slice(11, 19)}`;
      parts.push(['Funding', `${(i.funding * 100).toFixed(4)}%${hhmmss}`]);
    }
    if (!parts.length) return null;
    return h('div', { class: 'legend-row legend-info' }, ...parts.map(([k, v]) => h('span', {}, k, ' ', h('b', {}, v))));
  }

  indicatorLegendRow(inst, time) {
    const s = this.app.settings;
    const values = inst.visible && inst.showValues !== false && s.showIndValues !== false ? this.valuesAt(inst, time) : [];
    const label = s.showIndTitles === false ? '' : this.indicatorLabel(inst, s.showIndArgs !== false);
    return h('div', { class: `legend-row indicator${inst.visible ? '' : ' muted'}`, 'data-key': inst.uid },
      label ? h('button', { type: 'button', class: 'legend-name legend-ind', title: 'Settings', onclick: () => this.editIndicator(inst.uid) }, label) : null,
      ...values.filter((v) => v.value !== undefined && Number.isFinite(v.value))
        .map((v) => h('b', { style: { color: v.color } }, inst.def.overlay ? formatPrice(v.value, this.digits()) : formatIndicatorValue(v.value, inst.precision))),
      h('span', { class: 'legend-actions' },
        h('button', { type: 'button', title: inst.visible ? 'Hide' : 'Show', 'aria-label': inst.visible ? 'Hide' : 'Show', onclick: () => this.toggleIndicator(inst.uid) }, inst.visible ? '◉' : '○'),
        h('button', { type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: () => this.editIndicator(inst.uid) }, '⚙'),
        h('button', { type: 'button', title: 'Remove', 'aria-label': 'Remove', onclick: () => this.removeIndicator(inst.uid) }, '✕')));
  }

  renderSubLegends(time) {
    const subs = this.indicators.filter((i) => !i.def.overlay);
    patchChildren(this.subLegends, subs.map((inst) => h('div', { class: 'sub-legend', 'data-uid': inst.uid, 'data-key': inst.uid, 'data-keep': 'style hidden' }, this.indicatorLegendRow(inst, time))));
    this.layoutSubLegends();
    requestAnimationFrame(() => this.layoutSubLegends());
  }

  layoutSubLegends() {
    const panes = this.chart.panes();
    for (const el of this.subLegends.children) {
      const inst = this.indicators.find((i) => i.uid === el.dataset.uid);
      let paneIndex;
      try { paneIndex = inst?.series[0]?.getPane().paneIndex(); } catch { paneIndex = undefined; }
      if (paneIndex === undefined || paneIndex <= 0) {
        el.hidden = true;
        continue;
      }
      let top = 0;
      for (let i = 0; i < paneIndex; i++) top += panes[i].getHeight() + 1;
      el.hidden = false;
      el.style.top = `${top + 4}px`;
    }
  }

  // ---------------------------------------------------------------- bar replay
  startReplaySelect() {
    if (!this.candles.length) return;
    this.exitReplay(false);
    this.chartEl.classList.add('replay-select');
    toast('Click a bar to start the replay from there', 'info', 3000);
    this.onPaneClick = (x) => {
      const shown = Math.round(this.chart.timeScale().coordinateToLogical(x) ?? -1);
      // Map the plotted bar (which may be a Renko brick etc.) back to its source candle.
      const t = this.displayCandles()[shown]?.time;
      const l = t === undefined ? -1 : Math.min(this.candles.length - 1, lowerBound(this.candles, Math.floor(t / this.stepSec()) * this.stepSec(), (c) => c.time));
      this.onPaneClick = null;
      this.chartEl.classList.remove('replay-select');
      if (l < 1 || l >= this.candles.length - 1) {
        toast('Pick a bar before the latest one', 'error');
        return true;
      }
      this.replay = { index: l, playing: false, speed: 1 };
      const range = this.chart.timeScale().getVisibleLogicalRange();
      this.applyData();
      if (range) this.chart.timeScale().setVisibleLogicalRange(range);
      this.app.onReplayChange(this);
      return true;
    };
  }

  replayStep(n = 1) {
    if (!this.replay) return;
    const next = Math.min(this.replay.index + n, this.candles.length - 1);
    if (next === this.replay.index) {
      this.replayPause();
      toast('Replay reached the latest bar', 'info');
      return;
    }
    this.replay.index = next;
    const candles = this.displayCandles();
    if (this.type === 'heikin') this.main.setData(this.mainData(candles));
    else this.main.update(this.mainData([candles.at(-1)], candles.length - 1)[0]);
    this.volume.update(this.volumeData([candles.at(-1)])[0]);
    this.computeIndicators();
    this.drawings.update();
    this.renderLegend();
    this.app.onReplayChange(this);
  }

  replayBack() {
    if (!this.replay || this.replay.index <= 1) return;
    this.replay.index -= 1;
    this.applyData();
    this.app.onReplayChange(this);
  }

  replayPlay() {
    if (!this.replay) return;
    clearInterval(this.replay.timer);
    this.replay.playing = true;
    this.replay.timer = setInterval(() => this.replayStep(1), 1000 / this.replay.speed);
    this.app.onReplayChange(this);
  }

  replayPause() {
    if (!this.replay) return;
    clearInterval(this.replay.timer);
    this.replay.playing = false;
    this.app.onReplayChange(this);
  }

  replaySpeed(speed) {
    if (!this.replay) return;
    this.replay.speed = speed;
    if (this.replay.playing) this.replayPlay();
    else this.app.onReplayChange(this);
  }

  exitReplay(notify = true) {
    this.onPaneClick = null;
    this.chartEl.classList.remove('replay-select');
    if (!this.replay) return;
    clearInterval(this.replay.timer);
    this.replay = null;
    this.applyData();
    this.chart.timeScale().scrollToRealTime();
    if (notify) this.app.onReplayChange(this);
  }

  // ---------------------------------------------------------------- misc
  setVisibleSpan(span) {
    const bars = this.displayCandles();
    const last = bars.at(-1);
    if (!last) return;
    this.chart.priceScale('right').setAutoScale(true);
    if (span === 'all') {
      this.chart.timeScale().fitContent();
      return;
    }
    const from = span === 'ytd' ? Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000 : last.time - span;
    const firstIdx = lowerBound(bars, from, (c) => c.time);
    this.chart.timeScale().setVisibleLogicalRange({ from: firstIdx, to: bars.length - 1 + 5 });
    if (this.candles[0].time > from && !this.exhausted) this.loadMore();
  }

  goToDate(sec) {
    const bars = this.displayCandles();
    const idx = lowerBound(bars, sec, (c) => c.time);
    if (idx <= 0 && this.candles[0]?.time > sec) {
      toast('That date is before the loaded history. Scroll left to load more.', 'info');
      this.loadMore();
      return;
    }
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const span = range ? range.to - range.from : 120;
    this.chart.timeScale().setVisibleLogicalRange({ from: idx - span / 2, to: idx + span / 2 });
  }

  syncCrosshairTo(time) {
    if (time === null || time === undefined) {
      this.chart.clearCrosshairPosition();
      return;
    }
    const candles = this.displayCandles();
    const idx = Math.min(lowerBound(candles, time, (c) => c.time), candles.length - 1);
    const bar = candles[idx];
    if (!bar) return;
    this.chart.setCrosshairPosition(bar.close, bar.time, this.main);
  }

  screenshot() {
    return this.chart.takeScreenshot(true);
  }

  serialize() {
    return {
      symbol: this.symbol,
      interval: this.interval,
      type: this.type,
      scaleMode: this.scaleMode,
      indicators: this.indicators.map((i) => ({
        id: i.def.id, params: i.params, styles: i.styles, visible: i.visible, precision: i.precision, showLabels: i.showLabels, showValues: i.showValues, levelsCfg: i.levelsCfg, vis: i.vis,
      })),
      compare: [...this.compares.map((c) => c.symbol), ...(this.pendingCompares ?? [])],
      legendCollapsed: this.legendCollapsed,
      optPrice: this.optPrice,
    };
  }

  destroy() {
    this.destroyed = true;
    this.unsub?.();
    this.infoUnsub?.();
    clearTimeout(this.infoTimer);
    this.tradeUnsub?.();
    this.trade?.panel?.remove();
    this.stopFootprint();
    for (const cmp of this.compares) cmp.unsub?.();
    clearTimeout(this.liveTimer);
    clearInterval(this.countdownTimer);
    if (this.replay) clearInterval(this.replay.timer);
    this.resizeObserver.disconnect();
    this.chart.remove();
    this.host.remove();
  }
}
