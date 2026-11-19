// Drawing engine: a lightweight-charts series primitive that paints every drawing on each chart
// repaint, plus the pointer state machine for creating, selecting, dragging and erasing drawings.
// Tool geometry lives in drawtools.js; dialogs and the floating toolbar live in drawui.js.

import {
  defaultProps, defaultVisibility, G, hitPrim, makeFmt, toolById, TOOLS, visibleOnInterval,
} from './drawtools.js';
import { FloatingToolbar, openDrawingSettings } from './drawui.js';
import { h, lowerBound, store, uid } from './util.js';

export { TOOLS, toolById };

const HANDLE_R = 5;
const OLD_DASH = { 0: 0, 1: 2, 2: 1 };

// Migrate drawings saved by the first version ({style:{color,width,dash}}) to TradingView-style props.
function migrate(d) {
  if (d.props) return d;
  const tool = toolById(d.type);
  if (!tool) return d;
  const props = defaultProps(tool);
  if (d.style) {
    if ('lineColor' in props) props.lineColor = d.style.color;
    if ('lineWidth' in props) props.lineWidth = d.style.width;
    if ('lineStyle' in props) props.lineStyle = OLD_DASH[d.style.dash] ?? 0;
    if (d.type === 'text') props.textColor = d.style.color;
  }
  if (d.text) props.text = d.text;
  if (d.type === 'fib' && d.extend) props.extend = 'right';
  return { id: d.id, type: d.type, points: d.points, props, vis: defaultVisibility(), locked: d.locked, hidden: d.hidden };
}

export class DrawingLayer {
  constructor(pane) {
    this.pane = pane;
    this.drawings = [];
    this.selectedId = null;
    this.hoverId = null;
    this.tool = 'cross';
    this.draft = null;
    this.drag = null;
    this.undoStack = [];
    this.redoStack = [];
    this.symbol = null;
    this.magnet = store.get('magnetMode', 'off');
    this.keepDrawing = false;
    this.hidden = false;
    this.locked = false;
    this.listeners = new Set();
    this.series = null;
    this.requestUpdate = null;
    this.hits = new Map();
    this.trail = [];
    this.zoomRect = null;

    const layer = this;
    const renderer = {
      draw(target) {
        target.useMediaCoordinateSpace(({ context, mediaSize }) => layer.render(context, mediaSize.width, mediaSize.height));
      },
    };
    const view = { zOrder: () => 'top', renderer: () => renderer };
    this.primitive = {
      attached({ requestUpdate }) { layer.requestUpdate = requestUpdate; },
      detached() { layer.requestUpdate = null; },
      updateAllViews() {},
      paneViews() { return [view]; },
      priceAxisViews() { return layer.pane.axisViews?.() ?? []; },
    };
    this.toolbar = new FloatingToolbar(this);
    this.bindPointer();
  }

  get app() { return this.pane.app; }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    this.listeners.forEach((fn) => fn());
    this.update();
  }

  attach(series) {
    if (this.series) {
      try { this.series.detachPrimitive(this.primitive); } catch { /* the series was already removed */ }
    }
    this.series = series;
    series.attachPrimitive(this.primitive);
  }

  update() {
    this.requestUpdate?.();
    this.toolbar.render();
  }

  // ---------------------------------------------------------------- persistence & history
  load(symbol) {
    this.symbol = symbol;
    this.drawings = store.get(`drawings.${symbol}`, []).map(migrate).filter((d) => toolById(d.type));
    this.selectedId = null;
    this.draft = null;
    this.undoStack = [];
    this.redoStack = [];
    this.changed();
  }

  save() {
    if (this.symbol) store.set(`drawings.${this.symbol}`, this.drawings.filter((d) => !d.temp));
  }

  checkpoint() {
    this.undoStack.push(JSON.stringify(this.drawings.filter((d) => !d.temp)));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.drawings));
    this.drawings = JSON.parse(this.undoStack.pop());
    this.selectedId = null;
    this.save();
    this.changed();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.drawings));
    this.drawings = JSON.parse(this.redoStack.pop());
    this.selectedId = null;
    this.save();
    this.changed();
    return true;
  }

  // ---------------------------------------------------------------- coordinates
  times() { return this.pane.displayTimes(); }

  timeToLogical(t) {
    const times = this.times();
    const n = times.length;
    if (!n) return 0;
    const step = this.pane.stepSec();
    if (t <= times[0]) return (t - times[0]) / step;
    if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / step;
    const i = lowerBound(times, t);
    if (times[i] === t) return i;
    return i - 1 + (t - times[i - 1]) / (times[i] - times[i - 1]);
  }

  logicalToTime(l) {
    const times = this.times();
    const n = times.length;
    if (!n) return 0;
    const step = this.pane.stepSec();
    if (l <= 0) return times[0] + l * step;
    if (l >= n - 1) return times[n - 1] + (l - (n - 1)) * step;
    const i = Math.floor(l);
    return times[i] + (l - i) * (times[i + 1] - times[i]);
  }

  toXY(pt) {
    if (!this.series) return null;
    const x = this.pane.chart.timeScale().logicalToCoordinate(this.timeToLogical(pt.time));
    const y = this.series.priceToCoordinate(pt.price);
    if (x === null || y === null) return null;
    return { x, y };
  }

  // Pixel → {time, price}; snaps to bar centres and applies the magnet mode.
  fromXY(x, y, snap = true) {
    let l = this.pane.chart.timeScale().coordinateToLogical(x);
    let price = this.series?.coordinateToPrice(y);
    if (l === null || price === null || price === undefined) return null;
    if (snap) l = Math.round(l);
    if (snap && this.magnet !== 'off') {
      const bar = this.pane.displayCandles()[l];
      if (bar) {
        let best = null;
        let bestDist = Infinity;
        for (const v of [bar.open, bar.high, bar.low, bar.close]) {
          const cy = this.series.priceToCoordinate(v);
          const dd = cy === null ? Infinity : Math.abs(cy - y);
          if (dd < bestDist) { bestDist = dd; best = v; }
        }
        if (best !== null && (this.magnet === 'strong' || bestDist < 30)) price = best;
      }
    }
    return { time: this.logicalToTime(l), price };
  }

  tick() {
    const info = this.app.symbolInfo(this.pane.symbol);
    const d = this.pane.digits() ?? 2;
    return info?.tick || 10 ** -d;
  }

  env(d, P, w, hgt) {
    const ts = this.pane.chart.timeScale();
    const series = this.series;
    return {
      L: this,
      d,
      P,
      candles: this.pane.displayCandles(),
      tick: this.tick(),
      fmt: makeFmt(this.pane.digits()),
      fmtTime: (t) => this.app.timeFormatter.full(Math.round(t)),
      bg: this.app.themeColors().bg,
      selected: d.id === this.selectedId,
      hover: d.id === this.hoverId,
      y: (price) => series.priceToCoordinate(price),
      xl: (l) => ts.logicalToCoordinate(l),
      lx: (x) => ts.coordinateToLogical(x) ?? 0,
      w,
      h: hgt,
    };
  }

  // ---------------------------------------------------------------- rendering
  isVisible(d) {
    return !d.hidden && visibleOnInterval(d.vis, this.pane.interval);
  }

  render(ctx, w, hgt) {
    this.size = { w, h: hgt };
    this.hits.clear();
    const list = this.draft ? [...this.drawings, this.draft] : this.drawings;
    if (!this.hidden) {
      for (const d of list) {
        if (!this.isVisible(d)) continue;
        const tool = toolById(d.type);
        if (!tool?.draw) continue;
        const P = d.points.map((p) => this.toXY(p));
        if (P.some((p) => !p)) continue;
        const hits = [];
        const g = new G(ctx, w, hgt, hits, this.env(d, P, w, hgt));
        ctx.save();
        try {
          tool.draw(g);
        } catch (error) {
          console.error(`Drawing ${d.type} failed`, error);
        }
        ctx.restore();
        this.hits.set(d.id, { hits, handles: tool.handles ? tool.handles(g) : P });
        if (d.id === this.selectedId || d === this.draft) this.drawHandles(ctx, d);
      }
    }
    this.pane.trade?.render(ctx, w, hgt);
    if (this.zoomRect) {
      const r = this.zoomRect;
      ctx.save();
      ctx.fillStyle = 'rgba(41,98,255,.12)';
      ctx.strokeStyle = 'rgba(41,98,255,.8)';
      ctx.setLineDash([4, 3]);
      ctx.fillRect(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), Math.abs(r.x1 - r.x0), Math.abs(r.y1 - r.y0));
      ctx.strokeRect(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), Math.abs(r.x1 - r.x0), Math.abs(r.y1 - r.y0));
      ctx.restore();
    }
    this.renderTrail(ctx);
  }

  drawHandles(ctx, d) {
    const entry = this.hits.get(d.id);
    if (!entry) return;
    const color = d.props?.lineColor ?? d.props?.fillColor ?? '#2962FF';
    ctx.save();
    ctx.setLineDash([]);
    for (const p of entry.handles) {
      if (!p || p.y === null) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = this.app.theme === 'light' ? '#ffffff' : '#131722';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color.startsWith('rgba') && color.endsWith(', 0.2)') ? '#2962FF' : color;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Demonstration cursor: a fading laser trail.
  renderTrail(ctx) {
    if (!this.trail.length) return;
    const now = performance.now();
    this.trail = this.trail.filter((p) => now - p.t < 700);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      const age = 1 - (now - b.t) / 700;
      ctx.strokeStyle = `rgba(242, 54, 69, ${Math.max(0, age) * 0.9})`;
      ctx.lineWidth = 2 + age * 4;
      ctx.shadowColor = 'rgba(242,54,69,.8)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
    if (this.trail.length && !this.trailRaf) {
      this.trailRaf = requestAnimationFrame(() => {
        this.trailRaf = null;
        this.requestUpdate?.();
      });
    }
  }

  // ---------------------------------------------------------------- hit testing
  hitTest(x, y) {
    if (this.hidden) return null;
    const p = { x, y };
    for (let k = this.drawings.length - 1; k >= 0; k--) {
      const d = this.drawings[k];
      if (!this.isVisible(d)) continue;
      const entry = this.hits.get(d.id);
      if (!entry) continue;
      if (d.id === this.selectedId) {
        for (let i = 0; i < entry.handles.length; i++) {
          const hp = entry.handles[i];
          if (hp && Math.hypot(hp.x - x, hp.y - y) <= HANDLE_R + 3) return { d, handle: i };
        }
      }
      if (entry.hits.some((prim) => hitPrim(prim, p))) return { d, handle: -1 };
    }
    return null;
  }

  // ---------------------------------------------------------------- interaction
  setTool(id) {
    this.tool = id;
    this.finishMulti(false);
    this.draft = null;
    const tool = toolById(id);
    const el = this.pane.chartEl;
    el.classList.toggle('drawing-mode', Boolean(tool && !tool.cursor) || id === 'zoom' || id === 'quickmeasure');
    el.dataset.cursor = tool?.cursor ? id : '';
    this.pane.applyCursorMode(tool?.cursor ? id : 'cross');
    this.update();
  }

  inPane(x, y) {
    const size = this.pane.chart.paneSize(0);
    return x >= 0 && y >= 0 && x <= size.width && y <= size.height;
  }

  localXY(event) {
    const rect = this.pane.chartEl.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  isDrawingTool() {
    const tool = toolById(this.tool);
    return Boolean(tool && !tool.cursor) || this.tool === 'zoom' || this.tool === 'quickmeasure';
  }

  bindPointer() {
    const el = this.pane.chartEl;
    let consuming = false;
    // lightweight-charts pans on mousedown/touchstart; swallow them when a drawing gesture claimed
    // the matching pointerdown.
    const swallow = (event) => {
      if (!consuming) return;
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    };
    el.addEventListener('mousedown', swallow, true);
    el.addEventListener('touchstart', swallow, { capture: true, passive: false });

    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const { x, y } = this.localXY(event);
      this.pane.activate();
      if (!this.inPane(x, y)) return;
      const claim = () => {
        consuming = true;
        event.stopPropagation();
        try { el.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
      };
      if (this.pane.onPaneClick?.(x, y)) { claim(); return; }
      if (!this.isDrawingTool() && this.pane.trade?.pointerDown(x, y)) { claim(); return; }
      // A finished quick-measure disappears on the next click.
      if (this.drawings.some((d) => d.temp) && !this.draft) {
        this.drawings = this.drawings.filter((d) => !d.temp);
        this.update();
      }
      if (this.tool === 'zoom') {
        claim();
        this.zoomRect = { x0: x, y0: y, x1: x, y1: y };
        return;
      }
      if (this.tool === 'eraser') {
        const hit = this.hitTest(x, y);
        if (hit) { claim(); this.remove(hit.d.id); }
        return;
      }
      if (this.tool === 'demo') return;
      if (this.isDrawingTool() || (event.shiftKey && !this.draft)) {
        if (this.locked) return;
        claim();
        this.onToolDown(x, y, event.shiftKey && !this.isDrawingTool() ? 'quickmeasure' : this.tool);
        return;
      }
      const hit = this.hitTest(x, y);
      if (!hit) {
        if (this.selectedId) {
          this.selectedId = null;
          this.changed();
        }
        consuming = false;
        return;
      }
      claim();
      this.selectedId = hit.d.id;
      if (!hit.d.locked && !this.locked) {
        this.drag = {
          id: hit.d.id,
          handle: hit.handle,
          start: this.fromXY(x, y, false),
          startLogical: this.pane.chart.timeScale().coordinateToLogical(x),
          original: JSON.parse(JSON.stringify(hit.d.points)),
          moved: false,
        };
      }
      this.changed();
    }, true);

    el.addEventListener('pointermove', (event) => {
      const { x, y } = this.localXY(event);
      if (this.tool === 'demo' && event.buttons) {
        this.trail.push({ x, y, t: performance.now() });
        this.requestUpdate?.();
      }
      if (this.pane.trade?.pointerMove(y)) return;
      if (this.zoomRect) {
        this.zoomRect.x1 = x;
        this.zoomRect.y1 = y;
        this.requestUpdate?.();
        return;
      }
      if (this.drag) { this.onDragMove(x, y); return; }
      if (this.draft) { this.onDraftMove(x, y); return; }
      if (!this.isDrawingTool() && this.inPane(x, y)) {
        const hit = this.hitTest(x, y);
        el.classList.toggle('drawing-hover', Boolean(hit) && this.tool !== 'eraser');
        el.classList.toggle('eraser-hover', Boolean(hit) && this.tool === 'eraser');
        const tc = hit ? null : this.pane.trade?.cursorAt(x, y);
        el.classList.toggle('trade-ns', tc === 'ns-resize');
        el.classList.toggle('trade-pointer', tc === 'pointer');
        const hoverId = hit?.d.id ?? null;
        if (hoverId !== this.hoverId) {
          this.hoverId = hoverId;
          this.requestUpdate?.();
        }
      }
    });

    el.addEventListener('pointerup', (event) => {
      const { x, y } = this.localXY(event);
      if (this.pane.trade?.pointerUp()) {
        setTimeout(() => { consuming = false; }, 0);
        return;
      }
      if (this.zoomRect) {
        this.applyZoom();
      } else if (this.drag) {
        const { moved } = this.drag;
        this.drag = null;
        if (moved) {
          this.save();
          this.app.onDrawingMoved?.(this.pane);
        }
        this.changed();
      } else if (this.draft) {
        this.onDraftUp(x, y);
      }
      setTimeout(() => { consuming = false; }, 0);
    });

    el.addEventListener('dblclick', (event) => {
      const { x, y } = this.localXY(event);
      if (this.draft && toolById(this.draft.type)?.n === 'multi') {
        this.draft.points.pop();
        this.finishMulti(true);
        return;
      }
      const hit = this.hitTest(x, y);
      if (!hit) return;
      event.stopPropagation();
      if (toolById(hit.d.type)?.editText) this.editText(hit.d);
      else this.openSettings(hit.d);
    }, true);
  }

  applyZoom() {
    const r = this.zoomRect;
    this.zoomRect = null;
    if (Math.abs(r.x1 - r.x0) > 8) {
      const ts = this.pane.chart.timeScale();
      const l0 = ts.coordinateToLogical(Math.min(r.x0, r.x1));
      const l1 = ts.coordinateToLogical(Math.max(r.x0, r.x1));
      if (l0 !== null && l1 !== null) ts.setVisibleLogicalRange({ from: l0, to: l1 });
      if (Math.abs(r.y1 - r.y0) > 8) {
        const p0 = this.series.coordinateToPrice(Math.max(r.y0, r.y1));
        const p1 = this.series.coordinateToPrice(Math.min(r.y0, r.y1));
        if (p0 !== null && p1 !== null) {
          const scale = this.pane.chart.priceScale('right');
          scale.setAutoScale(false);
          scale.setVisibleRange({ from: Math.min(p0, p1), to: Math.max(p0, p1) });
        }
      }
    }
    this.app.setTool('cross');
    this.requestUpdate?.();
  }

  onToolDown(x, y, toolId) {
    // Quick measure (Shift+click or the Measure button) is a temporary Date & price range.
    const quick = toolId === 'quickmeasure';
    const tool = toolById(quick ? 'measure' : toolId);
    if (!tool) return;
    const pt = this.fromXY(x, y, tool.n !== -1);
    if (!pt) return;
    if (!this.draft) {
      const d = {
        id: uid(),
        type: tool.id,
        points: [pt],
        props: defaultProps(tool, store.get(`tooldefaults.${tool.id}`, null)),
        vis: defaultVisibility(),
        downXY: { x, y },
      };
      if (quick) d.temp = true;
      this.draft = d;
      if (tool.n === 1) {
        this.finishDraft();
        return;
      }
      if (tool.n !== -1) d.points.push({ ...pt });
      this.update();
      return;
    }
    // Click-click creation: fix the current point and start the next one.
    this.draft.points[this.draft.points.length - 1] = pt;
    this.draft.downXY = { x, y };
    if (tool.n === 'multi') {
      this.draft.points.push({ ...pt });
      this.update();
      return;
    }
    if (this.draft.points.length >= tool.n) this.finishDraft();
    else {
      this.draft.points.push({ ...pt });
      this.update();
    }
  }

  onDraftMove(x, y) {
    const tool = toolById(this.draft.type);
    const pt = this.fromXY(x, y, tool.n !== -1);
    if (!pt) return;
    if (tool.n === -1) {
      const last = this.draft.points.at(-1);
      const lastXY = last && this.toXY(last);
      if (!lastXY || Math.hypot(lastXY.x - x, lastXY.y - y) > 2) this.draft.points.push(pt);
    } else {
      this.draft.points[this.draft.points.length - 1] = pt;
    }
    this.update();
  }

  onDraftUp(x, y) {
    const d = this.draft;
    const tool = toolById(d.type);
    if (tool.n === -1) {
      if (d.points.length > 1) this.finishDraft();
      else this.draft = null;
      this.update();
      return;
    }
    if (tool.n === 'multi') return;
    // Drag-to-create: releasing after a drag places the current point.
    const moved = Math.hypot(x - d.downXY.x, y - d.downXY.y) > 6;
    if (!moved) return;
    if (d.points.length >= tool.n) this.finishDraft();
    else {
      d.points.push({ ...d.points.at(-1) });
      d.downXY = { x, y };
    }
  }

  finishMulti(commit) {
    const d = this.draft;
    if (!d || toolById(d.type)?.n !== 'multi') return false;
    // Remove the trailing rubber-band point, then commit when at least two points remain.
    if (d.points.length > 1) d.points.pop();
    if (commit && d.points.length >= 2) this.finishDraft();
    else this.draft = null;
    this.update();
    return true;
  }

  finishDraft() {
    const d = this.draft;
    this.draft = null;
    delete d.downXY;
    const tool = toolById(d.type);
    tool.create?.(d, this);
    const n = typeof tool.n === 'number' ? tool.n : 0;
    while (n > 0 && d.points.length < n) d.points.push({ ...d.points.at(-1) });
    if (d.temp) {
      this.drawings.push(d);
      this.app.setTool(this.keepDrawing && this.tool === 'quickmeasure' ? 'quickmeasure' : 'cross');
      this.update();
      return;
    }
    this.commit(d);
    if (tool.editText) this.editText(d);
  }

  commit(d) {
    this.checkpoint();
    this.drawings.push(d);
    this.selectedId = d.id;
    this.save();
    if (!this.keepDrawing) this.app.setTool('cross');
    this.changed();
  }

  onDragMove(x, y) {
    const drag = this.drag;
    const d = this.drawings.find((item) => item.id === drag.id);
    if (!d) return;
    const tool = toolById(d.type);
    const pt = this.fromXY(x, y, drag.handle >= 0);
    if (!pt || !drag.start) return;
    if (!drag.moved) {
      this.checkpoint();
      drag.moved = true;
    }
    if (drag.handle >= 0) {
      if (tool.moveHandle) tool.moveHandle(d, drag.handle, pt, this);
      else if (d.points[drag.handle]) d.points[drag.handle] = pt;
    } else {
      const l = this.pane.chart.timeScale().coordinateToLogical(x);
      const dl = Math.round(l - drag.startLogical);
      const dp = pt.price - drag.start.price;
      d.points = drag.original.map((p) => ({
        time: tool.axis === 'price' ? p.time : this.logicalToTime(this.timeToLogical(p.time) + dl),
        price: tool.axis === 'time' ? p.price : p.price + dp,
      }));
    }
    this.update();
  }

  // Escape: finish a multi-point path, else cancel the draft, else deselect.
  cancel() {
    if (this.draft) {
      if (this.finishMulti(true)) return true;
      this.draft = null;
      this.update();
      return true;
    }
    if (this.drawings.some((d) => d.temp)) {
      this.drawings = this.drawings.filter((d) => !d.temp);
      this.update();
      return true;
    }
    if (this.selectedId) {
      this.selectedId = null;
      this.changed();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- mutations
  selected() { return this.drawings.find((d) => d.id === this.selectedId); }

  mutate(id, fn, { remember = true } = {}) {
    const d = this.drawings.find((item) => item.id === id);
    if (!d) return;
    this.checkpoint();
    fn(d);
    // TradingView remembers the last-used style of each tool for new drawings.
    if (remember && d.props) {
      const { text, ...style } = d.props;
      store.set(`tooldefaults.${d.type}`, style);
    }
    this.save();
    this.changed();
  }

  mutateSelected(fn) {
    if (this.selectedId) this.mutate(this.selectedId, fn);
  }

  setProps(id, patch) {
    this.mutate(id, (d) => Object.assign(d.props, patch));
  }

  deleteSelected() {
    if (!this.selectedId) return false;
    this.remove(this.selectedId);
    return true;
  }

  remove(id) {
    this.checkpoint();
    this.drawings = this.drawings.filter((d) => d.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.save();
    this.changed();
  }

  clear(includeLocked = true) {
    const keep = includeLocked ? [] : this.drawings.filter((d) => d.locked);
    if (keep.length === this.drawings.length) return;
    this.checkpoint();
    this.drawings = keep;
    this.selectedId = null;
    this.save();
    this.changed();
  }

  clone(id = this.selectedId) {
    const d = this.drawings.find((x) => x.id === id);
    if (!d) return;
    const copy = JSON.parse(JSON.stringify(d));
    copy.id = uid();
    const shift = this.pane.stepSec() * 5;
    copy.points.forEach((p) => { p.time += shift; });
    this.checkpoint();
    this.drawings.push(copy);
    this.selectedId = copy.id;
    this.save();
    this.changed();
  }

  reorder(id, where) {
    const i = this.drawings.findIndex((d) => d.id === id);
    if (i < 0) return;
    this.checkpoint();
    const [d] = this.drawings.splice(i, 1);
    if (where === 'front') this.drawings.push(d);
    else if (where === 'back') this.drawings.unshift(d);
    else if (where === 'forward') this.drawings.splice(Math.min(this.drawings.length, i + 1), 0, d);
    else this.drawings.splice(Math.max(0, i - 1), 0, d);
    this.save();
    this.changed();
  }

  copySelected() {
    const d = this.selected();
    if (d) this.app.clipboard = JSON.parse(JSON.stringify(d));
    return Boolean(d);
  }

  paste() {
    const src = this.app.clipboard;
    if (!src || !toolById(src.type)) return false;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid();
    if (src.__symbol === this.symbol || !src.__symbol) {
      const shift = this.pane.stepSec() * 3;
      copy.points.forEach((p) => { p.time += shift; });
    }
    this.checkpoint();
    this.drawings.push(copy);
    this.selectedId = copy.id;
    this.save();
    this.changed();
    return true;
  }

  addHorizontalLine(price) {
    const time = this.times().at(-1) ?? 0;
    const tool = toolById('hline');
    this.commit({ id: uid(), type: 'hline', points: [{ time, price }], props: defaultProps(tool, store.get('tooldefaults.hline', null)), vis: defaultVisibility() });
  }

  openSettings(d = this.selected(), tab) {
    if (d) openDrawingSettings(this, d, tab);
  }

  editText(d) {
    const pt = this.toXY(d.points[d.type === 'callout' ? 1 : 0]);
    const input = h('textarea', {
      class: 'draw-text-input',
      rows: 2,
      placeholder: 'Add text, Enter to save · Shift+Enter for a new line',
      style: { left: `${Math.max(4, (pt?.x ?? 40) - 10)}px`, top: `${Math.max(4, (pt?.y ?? 40) - 16)}px` },
    });
    input.value = d.props.text ?? '';
    this.pane.host.append(input);
    input.focus();
    input.select();
    const done = (keep) => {
      if (!input.isConnected) return;
      const value = input.value.trim();
      input.remove();
      if (keep && value !== (d.props.text ?? '')) this.mutate(d.id, (x) => { x.props.text = value; }, { remember: false });
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); done(true); }
      if (event.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  }
}
