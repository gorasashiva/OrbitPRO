// TradingView-style UI for drawings, indicators and the chart: colour picker, floating drawing
// toolbar, and the settings dialogs (Style / Text / Inputs / Coordinates / Visibility, templates).

import {
  defaultProps, defaultVisibility, FONT_SIZES, LINE_STYLES, parseColor, positionStats, toHex, toolById, toRgba, VIS_GROUPS,
} from './drawtools.js';
import { closeMenus, h, modal, showMenu, store, toast } from './util.js';

// ---------------------------------------------------------------- colour picker
// TradingView palette: a grey ramp, the base hues, then tints and shades of each hue.
export const PALETTE_ROWS = [
  ['#FFFFFF', '#D1D4DC', '#B2B5BE', '#9598A1', '#787B86', '#5D606B', '#434651', '#2A2E39', '#131722', '#000000'],
  ['#F23645', '#FF9800', '#FFEB3B', '#4CAF50', '#089981', '#00BCD4', '#2962FF', '#673AB7', '#9C27B0', '#E91E63'],
  ['#FCCBCD', '#FFE0B2', '#FFF9C4', '#C8E6C9', '#ACE5DC', '#B2EBF2', '#BBD9FB', '#D1C4E9', '#E1BEE7', '#F8BBD0'],
  ['#FAA1A4', '#FFCC80', '#FFF59D', '#A5D6A7', '#70CCBD', '#80DEEA', '#90BFF9', '#B39DDB', '#CE93D8', '#F48FB1'],
  ['#F77C80', '#FFB74D', '#FFF176', '#81C784', '#42BDA8', '#4DD0E1', '#5B9CF6', '#9575CD', '#BA68C8', '#F06292'],
  ['#F7525F', '#FFA726', '#FFEE58', '#66BB6A', '#22AB94', '#26C6DA', '#3179F5', '#7E57C2', '#AB47BC', '#EC407A'],
  ['#B22833', '#F57C00', '#FBC02D', '#388E3C', '#056656', '#0097A7', '#1848CC', '#512DA8', '#7B1FA2', '#C2185B'],
  ['#801922', '#E65100', '#F57F17', '#1B5E20', '#00332A', '#006064', '#0C3299', '#311B92', '#4A148C', '#880E4F'],
];

let pickerEl = null;
export function closePicker() {
  pickerEl?.remove();
  pickerEl = null;
}
document.addEventListener('pointerdown', (event) => {
  if (pickerEl && !pickerEl.contains(event.target) && !event.target.closest('[data-picker-anchor]')) closePicker();
}, true);

// Palette popover; onChange receives an rgba() string on every change.
export function colorPicker(anchor, value, onChange, { opacity = true } = {}) {
  closeMenus();
  closePicker();
  let [r, g, b, a] = parseColor(value);
  const custom = store.get('customColors', []);
  const emit = () => onChange(toRgba([r, g, b, a]));
  const el = h('div', { class: 'color-picker glass-pop', role: 'dialog', 'aria-label': 'Color picker' });
  const swatch = (hex) => {
    const btn = h('button', { type: 'button', class: 'cp-swatch', style: { background: hex }, title: hex, 'aria-label': hex });
    if (toHex(toRgba([r, g, b, 1])).toLowerCase() === hex.toLowerCase()) btn.classList.add('active');
    btn.addEventListener('click', () => {
      [r, g, b] = parseColor(hex);
      emit();
      render();
    });
    return btn;
  };
  const render = () => {
    const input = h('input', { type: 'color', value: toHex(toRgba([r, g, b, 1])), 'aria-label': 'Custom color' });
    input.addEventListener('change', () => {
      [r, g, b] = parseColor(input.value);
      const next = [input.value, ...custom.filter((c) => c !== input.value)].slice(0, 10);
      store.set('customColors', next);
      custom.splice(0, custom.length, ...next);
      emit();
      render();
    });
    const children = [
      h('div', { class: 'cp-grid' }, ...PALETTE_ROWS.flat().map(swatch)),
      h('div', { class: 'cp-sep' }),
      h('div', { class: 'cp-custom' }, ...custom.map(swatch), h('label', { class: 'cp-add', title: 'Add custom color' }, '+', input)),
    ];
    if (opacity) {
      const slider = h('input', { type: 'range', min: 0, max: 100, value: Math.round(a * 100), 'aria-label': 'Opacity' });
      const out = h('span', { class: 'cp-pct' }, `${Math.round(a * 100)}%`);
      slider.style.setProperty('--cp-color', toRgba([r, g, b, 1]));
      slider.addEventListener('input', () => {
        a = Number(slider.value) / 100;
        out.textContent = `${slider.value}%`;
        emit();
      });
      children.push(h('div', { class: 'cp-opacity' }, h('span', {}, 'Opacity'), slider, out));
    }
    el.replaceChildren(...children);
  };
  render();
  document.body.append(el);
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(6, Math.min(rect.left, window.innerWidth - el.offsetWidth - 6));
  let top = rect.bottom + 6;
  if (top + el.offsetHeight > window.innerHeight - 6) top = Math.max(6, rect.top - el.offsetHeight - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  pickerEl = el;
}

export function colorButton(value, onChange, { opacity = true, title = 'Color' } = {}) {
  const btn = h('button', { type: 'button', class: 'color-btn', title, 'aria-label': title, 'data-picker-anchor': '' }, h('span', { class: 'color-chip', style: { background: value } }));
  btn.addEventListener('click', () => colorPicker(btn, value, (c) => {
    value = c;
    btn.firstChild.style.background = c;
    onChange(c);
  }, { opacity }));
  return btn;
}

function select(options, value, onChange, attrs = {}) {
  const el = h('select', attrs, ...options.map(([v, label]) => h('option', { value: String(v), selected: String(v) === String(value) }, label)));
  el.addEventListener('change', () => {
    const opt = options.find(([v]) => String(v) === el.value);
    onChange(opt ? opt[0] : el.value);
  });
  return el;
}

function numberInput(value, onChange, { min, max, step = 'any' } = {}) {
  const el = h('input', { type: 'number', value, min, max, step });
  el.addEventListener('input', () => {
    const v = Number(el.value);
    if (el.value !== '' && Number.isFinite(v)) onChange(v);
  });
  return el;
}

function checkbox(value, onChange) {
  const el = h('input', { type: 'checkbox', checked: Boolean(value) });
  el.addEventListener('change', () => onChange(el.checked));
  return el;
}

const row = (label, ...controls) => h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, label), h('span', { class: 'set-controls' }, ...controls));

function lineControls(obj, c, w, s, set) {
  return [
    colorButton(obj[c], (v) => set({ [c]: v })),
    select([1, 2, 3, 4].map((v) => [v, `${v}px`]), obj[w] ?? 1, (v) => set({ [w]: v }), { class: 'w-select', 'aria-label': 'Line width' }),
    select(LINE_STYLES.map((l) => [l.v, `${l.icon}  ${l.label}`]), obj[s] ?? 0, (v) => set({ [s]: v }), { class: 'w-select', 'aria-label': 'Line style' }),
  ];
}

function levelsEditor(levels, apply) {
  return h('div', { class: 'levels-grid' }, ...levels.map((lvl) => {
    const input = h('input', { type: 'number', step: 'any', value: lvl.v, class: 'level-value', 'aria-label': 'Level value' });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) { lvl.v = v; apply(); }
    });
    return h('div', { class: 'level-cell' }, checkbox(lvl.on, (v) => { lvl.on = v; apply(); }), input, colorButton(lvl.color, (c) => { lvl.color = c; apply(); }));
  }));
}

// One settings-schema field. `obj` is mutated in place; `apply` repaints the chart (live preview).
function buildField(spec, obj, apply, ctx) {
  const set = (patch) => { Object.assign(obj, patch); apply(); };
  switch (spec.t) {
    case 'section': return h('div', { class: 'set-section' }, spec.label);
    case 'line': return row(spec.label, ...lineControls(obj, spec.c, spec.w, spec.s, set));
    case 'color': return row(spec.label, colorButton(obj[spec.key], (v) => set({ [spec.key]: v })));
    case 'fill': {
      const controls = [];
      if (spec.on in obj) controls.push(checkbox(obj[spec.on], (v) => set({ [spec.on]: v })));
      controls.push(colorButton(obj[spec.c], (v) => set({ [spec.c]: v })));
      return row(spec.label, ...controls);
    }
    case 'check': return h('label', { class: 'set-row check-row' }, checkbox(obj[spec.key], (v) => set({ [spec.key]: v })), h('span', {}, spec.label));
    case 'select': return row(spec.label, select(spec.options, obj[spec.key], (v) => set({ [spec.key]: v })));
    case 'num': return row(spec.label, numberInput(obj[spec.key], (v) => set({ [spec.key]: Math.min(spec.max, Math.max(spec.min, v)) }), { min: spec.min, max: spec.max, step: spec.step }));
    case 'levels': return h('div', { class: 'set-block' }, h('div', { class: 'set-section' }, spec.label), levelsEditor(obj[spec.key], apply));
    case 'textarea': {
      const ta = h('textarea', { rows: 4, class: 'set-textarea', placeholder: 'Add text', 'aria-label': 'Text' });
      ta.value = obj[spec.key] ?? '';
      ta.addEventListener('input', () => set({ [spec.key]: ta.value }));
      return ta;
    }
    case 'font': {
      const toggle = (key, content, title) => {
        const b = h('button', { type: 'button', class: `fmt-btn${obj[key] ? ' on' : ''}`, 'aria-pressed': String(Boolean(obj[key])), title, 'aria-label': title }, content);
        b.addEventListener('click', () => {
          obj[key] = !obj[key];
          b.classList.toggle('on', obj[key]);
          b.setAttribute('aria-pressed', String(obj[key]));
          apply();
        });
        return b;
      };
      return row('Text', colorButton(obj.textColor, (v) => set({ textColor: v })),
        select(FONT_SIZES.map((v) => [v, String(v)]), obj.fontSize, (v) => set({ fontSize: v }), { class: 'w-select', 'aria-label': 'Font size' }),
        toggle('bold', h('b', {}, 'B'), 'Bold'), toggle('italic', h('i', {}, 'I'), 'Italic'));
    }
    case 'align':
      return row('Text alignment',
        select([['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], obj.vAlign, (v) => set({ vAlign: v }), { class: 'w-select', 'aria-label': 'Vertical alignment' }),
        select([['left', 'Left'], ['center', 'Center'], ['right', 'Right']], obj.hAlign, (v) => set({ hAlign: v }), { class: 'w-select', 'aria-label': 'Horizontal alignment' }));
    case 'positionPrices': return positionPriceFields(ctx.d, ctx.layer, apply);
    default: return h('span');
  }
}

// Long/short position Inputs: entry, profit and stop levels editable in ticks or price.
function positionPriceFields(d, layer, apply) {
  const tick = layer.tick();
  const wrap = h('div', { class: 'set-block' });
  const render = () => {
    const entry = d.points[0].price;
    wrap.replaceChildren(h('div', { class: 'set-section' }, 'Levels'), ...[['Entry price', 0], ['Profit level', 1], ['Stop level', 2]].map(([label, i]) => {
      const price = h('input', { type: 'number', step: 'any', value: +d.points[i].price.toFixed(8), 'aria-label': `${label} price` });
      price.addEventListener('change', () => {
        const v = Number(price.value);
        if (v > 0) { d.points[i].price = v; apply(); render(); }
      });
      if (i === 0) return row(label, h('span', { class: 'unit-input' }, price, h('small', {}, 'price')));
      const ticks = h('input', { type: 'number', step: 1, value: Math.round(Math.abs(d.points[i].price - entry) / tick), 'aria-label': `${label} ticks` });
      ticks.addEventListener('change', () => {
        const v = Math.abs(Number(ticks.value));
        if (!Number.isFinite(v)) return;
        const dir = Math.sign(d.points[i].price - entry) || (i === 1 ? 1 : -1);
        d.points[i].price = entry + dir * v * tick;
        apply();
        render();
      });
      return row(label, h('span', { class: 'unit-input' }, ticks, h('small', {}, 'ticks')), h('span', { class: 'unit-input' }, price, h('small', {}, 'price')));
    }));
    const st = positionStats(d, undefined, 0, Infinity);
    wrap.append(h('div', { class: 'set-note' }, `Qty ${st.qty} · Risk/Reward ratio ${st.rr.toFixed(2)}`));
  };
  render();
  return wrap;
}

function toLocalInput(sec) {
  const d = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function coordinatesTab(d, apply) {
  const tool = toolById(d.type);
  return h('div', { class: 'set-pane' }, ...d.points.map((p, i) => {
    const price = h('input', { type: 'number', step: 'any', value: +p.price.toFixed(8), 'aria-label': `Point ${i + 1} price` });
    price.addEventListener('change', () => { const v = Number(price.value); if (Number.isFinite(v)) { p.price = v; apply(); } });
    const time = h('input', { type: 'datetime-local', value: toLocalInput(p.time), 'aria-label': `Point ${i + 1} time` });
    time.addEventListener('change', () => { const t = new Date(time.value).getTime() / 1000; if (Number.isFinite(t)) { p.time = t; apply(); } });
    const controls = [];
    if (tool.axis !== 'time') controls.push(h('span', { class: 'unit-input' }, price, h('small', {}, 'Price')));
    if (tool.axis !== 'price') controls.push(h('span', { class: 'unit-input' }, time, h('small', {}, 'Time')));
    return row(`#${i + 1}`, ...controls);
  }));
}

export function visibilityTab(vis, apply) {
  return h('div', { class: 'set-pane' }, ...VIS_GROUPS.map((g) => {
    const v = vis[g.id];
    const from = h('input', { type: 'number', min: g.min, max: g.max, value: v.from, class: 'vis-num', 'aria-label': `${g.label} from` });
    const to = h('input', { type: 'number', min: g.min, max: g.max, value: v.to, class: 'vis-num', 'aria-label': `${g.label} to` });
    from.addEventListener('change', () => { v.from = Math.max(g.min, Math.min(Number(from.value) || g.min, v.to)); from.value = v.from; apply(); });
    to.addEventListener('change', () => { v.to = Math.min(g.max, Math.max(Number(to.value) || g.max, v.from)); to.value = v.to; apply(); });
    return h('div', { class: 'set-row vis-row' },
      h('label', { class: 'check-row' }, checkbox(v.on, (on) => { v.on = on; apply(); }), h('span', {}, g.label)),
      h('span', { class: 'set-controls' }, from, h('span', { class: 'muted' }, '–'), to));
  }));
}

function tabbedDialog(title, tabs, { footerLeft, onOk, onCancel, width = 460, initial } = {}) {
  let active = tabs.find((t) => t.id === initial)?.id ?? tabs[0].id;
  const head = h('div', { class: 'dlg-tabs', role: 'tablist' });
  const body = h('div', { class: 'dlg-body' });
  const renderTabs = () => {
    head.replaceChildren(...tabs.map((t) => h('button', {
      type: 'button',
      role: 'tab',
      'aria-selected': String(t.id === active),
      class: `dlg-tab${t.id === active ? ' active' : ''}`,
      onclick: () => { active = t.id; renderTabs(); },
    }, t.label)));
    body.replaceChildren(tabs.find((t) => t.id === active).render());
  };
  let okd = false;
  const dialog = modal(title, h('div', { class: 'dlg' }, head, body), {
    width,
    onClose: () => { closePicker(); if (!okd) onCancel?.(); },
    footer: [
      footerLeft ?? h('span'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => dialog.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => { okd = true; onOk?.(); dialog.close(); } }, 'Ok'),
    ],
  });
  dialog.el.classList.add('settings-dialog');
  renderTabs();
  return { dialog, rerender: renderTabs };
}

// ---------------------------------------------------------------- drawing settings dialog
export function openDrawingSettings(layer, d, initialTab) {
  const tool = toolById(d.type);
  if (!tool) return;
  d.vis ??= defaultVisibility();
  const snapshot = JSON.stringify({ props: d.props, points: d.points, vis: d.vis });
  layer.checkpoint();
  const apply = () => layer.update();
  const ctx = { d, layer };
  const schemaTab = (fields) => () => h('div', { class: 'set-pane' }, ...fields.map((f) => buildField(f, d.props, apply, ctx)));
  const tabs = [];
  if (tool.inputs) tabs.push({ id: 'inputs', label: 'Inputs', render: schemaTab(tool.inputs) });
  if (tool.style?.length) tabs.push({ id: 'style', label: 'Style', render: schemaTab(tool.style) });
  if (tool.textTab) tabs.push({ id: 'text', label: 'Text', render: schemaTab(tool.textTab) });
  tabs.push({ id: 'coords', label: 'Coordinates', render: () => coordinatesTab(d, apply) });
  tabs.push({ id: 'visibility', label: 'Visibility', render: () => visibilityTab(d.vis, apply) });

  let ui;
  const templateBtn = h('button', { type: 'button', class: 'btn ghost template-btn' }, 'Template ▾');
  templateBtn.addEventListener('click', () => {
    const templates = store.get(`templates.${d.type}`, {});
    showMenu(templateBtn, [
      {
        label: 'Save drawing template as…',
        icon: '💾',
        action: () => {
          const name = prompt('Template name');
          if (!name) return;
          const { text, ...style } = d.props;
          store.set(`templates.${d.type}`, { ...templates, [name]: style });
          toast(`Template "${name}" saved`, 'success', 1800);
        },
      },
      {
        label: 'Save as default',
        icon: '★',
        action: () => {
          const { text, ...style } = d.props;
          store.set(`tooldefaults.${d.type}`, style);
          toast('Saved as the default for new drawings', 'success', 1800);
        },
      },
      {
        label: 'Reset settings',
        icon: '↺',
        action: () => {
          const text = d.props.text;
          d.props = defaultProps(tool);
          if (text !== undefined) d.props.text = text;
          store.set(`tooldefaults.${d.type}`, null);
          apply();
          ui.rerender();
        },
      },
      ...(Object.keys(templates).length ? ['-', { header: 'Templates' }] : []),
      ...Object.entries(templates).map(([name, style]) => ({
        label: name,
        icon: '▤',
        action: () => {
          d.props = { ...d.props, ...JSON.parse(JSON.stringify(style)) };
          apply();
          ui.rerender();
        },
      })),
    ]);
  });

  ui = tabbedDialog(tool.label, tabs, {
    initial: initialTab,
    footerLeft: templateBtn,
    onOk: () => {
      const { text, ...style } = d.props;
      store.set(`tooldefaults.${d.type}`, style);
      layer.save();
      layer.changed();
    },
    onCancel: () => {
      Object.assign(d, JSON.parse(snapshot));
      layer.undoStack.pop();
      layer.changed();
    },
  });
}

// ---------------------------------------------------------------- floating drawing toolbar
export class FloatingToolbar {
  constructor(layer) {
    this.layer = layer;
    this.el = h('div', { class: 'float-toolbar glass-pop', role: 'toolbar', 'aria-label': 'Drawing properties', hidden: true });
    layer.pane.host.append(this.el);
    this.pos = store.get('floatPos', null);
  }

  place() {
    const host = this.layer.pane.host;
    const w = this.el.offsetWidth;
    const maxX = Math.max(4, host.clientWidth - w - 4);
    const x = this.pos ? Math.min(Math.max(4, this.pos.x), maxX) : Math.max(4, (host.clientWidth - w) / 2);
    const y = this.pos ? Math.min(Math.max(4, this.pos.y), Math.max(4, host.clientHeight - 44)) : 10;
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  render() {
    const layer = this.layer;
    const d = layer.selected();
    if (!d || layer.drag || !d.props) {
      this.el.hidden = true;
      return;
    }
    const tool = toolById(d.type);
    const p = d.props;
    const handle = h('span', { class: 'ft-handle', title: 'Drag to move the toolbar', 'aria-hidden': 'true' }, '⋮⋮');
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const host = layer.pane.host.getBoundingClientRect();
      const box = this.el.getBoundingClientRect();
      const dx = event.clientX - box.left;
      const dy = event.clientY - box.top;
      const move = (ev) => {
        this.pos = { x: ev.clientX - host.left - dx, y: ev.clientY - host.top - dy };
        this.place();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        store.set('floatPos', this.pos);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    const items = [handle];
    const ftBtn = (title, content, onClick, extra = {}) => {
      const b = h('button', {
        type: 'button',
        class: `ft-btn${extra.on ? ' on' : ''}${extra.danger ? ' danger' : ''}`,
        title,
        'aria-label': title,
        'data-picker-anchor': extra.picker ? '' : undefined,
      }, content);
      b.addEventListener('click', (event) => onClick(event.currentTarget));
      return b;
    };
    const colorKey = ['lineColor', 'medianColor', 'plateColor', 'markerColor'].find((k) => k in p);
    if (colorKey) {
      items.push(ftBtn('Line color', h('span', { class: 'ft-color' }, h('span', { class: 'ft-glyph' }, '✎'), h('i', { style: { background: p[colorKey] } })), (b) => colorPicker(b, p[colorKey], (c) => layer.setProps(d.id, { [colorKey]: c })), { picker: true }));
    }
    if ('fillColor' in p) {
      items.push(ftBtn('Background color', h('span', { class: 'ft-color' }, h('span', { class: 'ft-glyph' }, '◧'), h('i', { style: { background: p.fillColor } })), (b) => colorPicker(b, p.fillColor, (c) => layer.setProps(d.id, { fillColor: c, ...('fill' in p ? { fill: true } : {}) })), { picker: true }));
    }
    if ('textColor' in p && tool.textTab) {
      items.push(ftBtn('Text color', h('span', { class: 'ft-color' }, h('span', { class: 'ft-glyph' }, 'T'), h('i', { style: { background: p.textColor } })), (b) => colorPicker(b, p.textColor, (c) => layer.setProps(d.id, { textColor: c })), { picker: true }));
    }
    if ('fontSize' in p && tool.textTab) {
      items.push(ftBtn('Font size', String(p.fontSize), (b) => showMenu(b, FONT_SIZES.map((s) => ({ label: String(s), active: s === p.fontSize, action: () => layer.setProps(d.id, { fontSize: s }) })))));
    }
    if ('lineWidth' in p && d.type !== 'highlighter') {
      items.push(ftBtn('Line width', h('span', { class: 'ft-width' }, h('i', { style: { height: `${Math.min(4, p.lineWidth)}px` } }), `${p.lineWidth}px`), (b) => showMenu(b, [1, 2, 3, 4].map((w) => ({
        label: `${w}px`, icon: h('span', { class: 'menu-line', style: { height: `${w}px` } }), active: w === p.lineWidth, action: () => layer.setProps(d.id, { lineWidth: w }),
      })))));
    }
    if ('lineStyle' in p) {
      items.push(ftBtn('Line style', LINE_STYLES[p.lineStyle]?.icon ?? '━━', (b) => showMenu(b, LINE_STYLES.map((s) => ({ label: s.label, icon: s.icon, active: s.v === p.lineStyle, action: () => layer.setProps(d.id, { lineStyle: s.v }) })))));
    }
    if (tool.editText) items.push(ftBtn('Edit text', 'Aa', () => layer.editText(d)));
    items.push(h('span', { class: 'ft-sep' }));
    items.push(ftBtn('Settings', '⚙', () => layer.openSettings(d)));
    if (tool.alertable) {
      items.push(ftBtn('Add alert', '⏰', () => layer.app.openAlertDialog(layer.pane.symbol, d.points[d.points.length - 1].price)));
    }
    items.push(ftBtn(d.locked ? 'Unlock' : 'Lock', d.locked ? '🔒' : '🔓', () => layer.mutate(d.id, (x) => { x.locked = !x.locked; }, { remember: false }), { on: d.locked }));
    items.push(ftBtn('Remove', '🗑', () => layer.deleteSelected(), { danger: true }));
    items.push(ftBtn('More', '⋯', (b) => showMenu(b, [
      { label: 'Clone', icon: '⧉', action: () => layer.clone(d.id) },
      { label: 'Copy', icon: '⎘', hint: 'Ctrl+C', action: () => layer.copySelected() },
      '-',
      { header: 'Visual order' },
      { label: 'Bring to front', icon: '⇈', action: () => layer.reorder(d.id, 'front') },
      { label: 'Bring forward', icon: '↑', action: () => layer.reorder(d.id, 'forward') },
      { label: 'Send backward', icon: '↓', action: () => layer.reorder(d.id, 'backward') },
      { label: 'Send to back', icon: '⇊', action: () => layer.reorder(d.id, 'back') },
      '-',
      { label: 'Hide', icon: '👁', action: () => layer.mutate(d.id, (x) => { x.hidden = true; }, { remember: false }) },
      { label: 'Visibility on intervals…', icon: '⏱', action: () => layer.openSettings(d, 'visibility') },
      { label: 'Coordinates…', icon: '⌖', action: () => layer.openSettings(d, 'coords') },
      '-',
      { label: 'Remove', icon: '🗑', danger: true, hint: 'Del', action: () => layer.deleteSelected() },
    ], { align: 'right' })));
    this.el.replaceChildren(...items);
    this.el.hidden = false;
    this.place();
  }
}

// ---------------------------------------------------------------- indicator settings dialog
export function openIndicatorSettings(pane, inst) {
  const def = inst.def;
  inst.vis ??= defaultVisibility();
  const snapshot = JSON.stringify({ params: inst.params, styles: inst.styles, precision: inst.precision, showLabels: inst.showLabels, showValues: inst.showValues, levelsCfg: inst.levelsCfg, vis: inst.vis });
  const apply = () => pane.applyIndicatorStyle(inst, true);

  // Custom (CandL) indicators: grouped inputs with toggles, dropdowns and ranges, as in CandL.
  // Number edits apply after a short pause so heavy studies are not recomputed per keystroke.
  let pending;
  const applySoon = () => { clearTimeout(pending); pending = setTimeout(apply, 250); };
  const customInputsTab = () => {
    const out = [];
    let group;
    for (const spec of def.paramSpecs) {
      if (spec.group && spec.group !== group) {
        group = spec.group;
        out.push(h('div', { class: 'set-section' }, group));
      }
      const key = spec.key;
      if (spec.toggle) {
        out.push(h('label', { class: 'set-row check-row' }, checkbox(inst.params[key] === 1, (v) => { inst.params[key] = v ? 1 : 0; apply(); }), h('span', {}, spec.label)));
      } else if (spec.options) {
        out.push(row(spec.label, select(spec.options.map((o) => [o.value, o.label]), inst.params[key], (v) => { inst.params[key] = Number(v); apply(); })));
      } else {
        out.push(row(spec.label, numberInput(inst.params[key], (v) => {
          let x = v;
          if (spec.min !== undefined) x = Math.max(spec.min, x);
          if (spec.max !== undefined) x = Math.min(spec.max, x);
          inst.params[key] = x;
          applySoon();
        }, { min: spec.min, max: spec.max, step: spec.step ?? 'any' })));
      }
    }
    if (!out.length) out.push(h('div', { class: 'set-note' }, 'This indicator has no inputs.'));
    if (def.description) out.unshift(h('div', { class: 'set-note custom-desc' }, def.description));
    return h('div', { class: 'set-pane' }, ...out);
  };

  // Outputs of a custom indicator (known after it has computed) as style rows.
  const customStyleTab = () => {
    const rows = (inst.lastOutputs ?? []).map((o) => {
      const st = { color: o.color, visible: true, ...inst.styles[o.name] };
      inst.styles[o.name] = st;
      const controls = [colorButton(st.color, (c) => { st.color = c; apply(); })];
      if (o.style !== 'histogram') {
        controls.push(select([1, 1.5, 2, 3, 4].map((v) => [v, `${v}px`]), st.lineWidth ?? 1.5, (v) => { st.lineWidth = Number(v); apply(); }, { class: 'w-select', 'aria-label': 'Line width' }));
        controls.push(select(LINE_STYLES.map((l) => [l.v, `${l.icon} ${l.label}`]), st.lineStyle ?? (o.style === 'dashed' ? 2 : 0), (v) => { st.lineStyle = Number(v); apply(); }, { class: 'w-select', 'aria-label': 'Line style' }));
      }
      return h('div', { class: 'set-row' }, h('label', { class: 'check-row' }, checkbox(st.visible, (v) => { st.visible = v; apply(); }), h('span', {}, o.name)), h('span', { class: 'set-controls' }, ...controls));
    });
    return h('div', { class: 'set-pane' },
      ...rows,
      def.canvas || def.signals ? h('div', { class: 'set-note' }, rows.length
        ? 'Labels, zones, boxes and signals are drawn by the indicator itself; their colours and switches are on the Inputs tab.'
        : 'This indicator draws everything itself (zones, labels, profiles, signals); colours and switches are on the Inputs tab.') : null,
      h('div', { class: 'set-section' }, 'Outputs'),
      h('label', { class: 'set-row check-row' }, checkbox(inst.showLabels !== false, (v) => { inst.showLabels = v; apply(); }), h('span', {}, 'Labels on price scale')),
      h('label', { class: 'set-row check-row' }, checkbox(inst.showValues !== false, (v) => { inst.showValues = v; apply(); }), h('span', {}, 'Values in status line')));
  };

  const inputsTab = () => (def.candl ? customInputsTab() : h('div', { class: 'set-pane' },
    ...Object.entries(def.inputs).map(([key, spec]) => {
      const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
      if (typeof spec === 'object' && spec.options) return row(label, select(spec.options.map((o) => [o, o]), inst.params[key], (v) => { inst.params[key] = v; apply(); }));
      return row(label, numberInput(inst.params[key], (v) => {
        if (v <= 0) return;
        inst.params[key] = Number.isInteger(spec) ? Math.max(1, Math.round(v)) : v;
        apply();
      }, { min: 0, step: Number.isInteger(spec) ? 1 : 'any' }));
    }),
    Object.keys(def.inputs).length ? null : h('div', { class: 'set-note' }, 'This indicator has no inputs.')));

  const styleTab = () => {
    if (def.candl) return customStyleTab();
    const rows = def.plots.map((plot) => {
      const st = { color: plot.color, lineWidth: plot.lineWidth ?? 1.5, lineStyle: 0, visible: true, ...inst.styles[plot.key] };
      inst.styles[plot.key] = st;
      const controls = [colorButton(st.color, (c) => { st.color = c; apply(); })];
      if (plot.downColor) {
        st.downColor ??= plot.downColor;
        controls.push(colorButton(st.downColor, (c) => { st.downColor = c; apply(); }, { title: 'Down color' }));
      }
      if (plot.type !== 'histogram') {
        controls.push(select([1, 1.5, 2, 3, 4].map((v) => [v, `${v}px`]), st.lineWidth, (v) => { st.lineWidth = v; apply(); }, { class: 'w-select', 'aria-label': 'Line width' }));
        controls.push(select(LINE_STYLES.map((l) => [l.v, `${l.icon} ${l.label}`]), st.lineStyle, (v) => { st.lineStyle = v; apply(); }, { class: 'w-select', 'aria-label': 'Line style' }));
      }
      return h('div', { class: 'set-row' }, h('label', { class: 'check-row' }, checkbox(st.visible, (v) => { st.visible = v; apply(); }), h('span', {}, plot.title)), h('span', { class: 'set-controls' }, ...controls));
    });
    const levelRows = (inst.levelsCfg ?? []).map((lvl) => h('div', { class: 'set-row' },
      h('label', { class: 'check-row' }, checkbox(lvl.on, (v) => { lvl.on = v; apply(); }), h('span', {}, 'Level')),
      h('span', { class: 'set-controls' }, numberInput(lvl.price, (v) => { lvl.price = v; apply(); }), colorButton(lvl.color, (c) => { lvl.color = c; apply(); }))));
    return h('div', { class: 'set-pane' },
      ...rows,
      levelRows.length ? h('div', { class: 'set-section' }, 'Levels') : null,
      ...levelRows,
      h('div', { class: 'set-section' }, 'Outputs'),
      row('Precision', select([['default', 'Default'], ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((v) => [v, String(v)])], inst.precision ?? 'default', (v) => { inst.precision = v; apply(); })),
      h('label', { class: 'set-row check-row' }, checkbox(inst.showLabels !== false, (v) => { inst.showLabels = v; apply(); }), h('span', {}, 'Labels on price scale')),
      h('label', { class: 'set-row check-row' }, checkbox(inst.showValues !== false, (v) => { inst.showValues = v; apply(); }), h('span', {}, 'Values in status line')));
  };

  let ui;
  const defaultsBtn = h('button', { type: 'button', class: 'btn ghost template-btn' }, 'Defaults ▾');
  defaultsBtn.addEventListener('click', () => showMenu(defaultsBtn, [
    { label: 'Reset settings', icon: '↺', action: () => { pane.resetIndicator(inst); ui.rerender(); } },
    {
      label: 'Save as default',
      icon: '★',
      action: () => {
        store.set(`indDefaults.${def.id}`, { params: inst.params, styles: inst.styles });
        toast(`${def.short} defaults saved`, 'success', 1800);
      },
    },
  ]));
  ui = tabbedDialog(def.name, [
    { id: 'inputs', label: 'Inputs', render: inputsTab },
    { id: 'style', label: 'Style', render: styleTab },
    { id: 'visibility', label: 'Visibility', render: () => visibilityTab(inst.vis, apply) },
  ], {
    footerLeft: defaultsBtn,
    width: 500,
    onOk: () => pane.app.saveLayout(),
    onCancel: () => {
      Object.assign(inst, JSON.parse(snapshot));
      pane.applyIndicatorStyle(inst, true);
    },
  });
}

// ---------------------------------------------------------------- chart settings dialog
export const CHART_DEFAULTS = {
  upColor: '#089981', downColor: '#F23645', borderVisible: true, borderUp: '#089981', borderDown: '#F23645', wickVisible: true, wickUp: '#089981', wickDown: '#F23645',
  colorOnPrevClose: false, precision: 'default',
  legendTitle: 'ticker', showOHLC: true, showBarChange: true, showVolumeLegend: true, showIndTitles: true, showIndArgs: true, showIndValues: true, legendBg: false,
  showLastLabel: true, showPriceLine: true, showPrevClose: false, showHighLow: false, countdown: true, invertScale: false,
  bgType: 'solid', bgColor: null, bgColor2: null, gridVertOn: true, gridHorzOn: true, gridVert: null, gridHorz: null,
  crosshairColor: null, crosshairWidth: 1, crosshairStyle: 2, watermarkOn: true, watermarkColor: null, scaleText: null, scaleFont: 11, scaleLines: null,
  marginTop: 8, marginBottom: 20, rightBars: 10,
  showPositions: true, showOrders: true, showBuySell: true, showAlertLines: true, alertColor: '#FF9800', alertSound: true, glass: true,
};

export function openChartSettings(app, initialTab) {
  const s = app.settings;
  const snapshot = JSON.stringify(s);
  const t = app.themeColors();
  const apply = () => app.applyChartSettings();
  const colorRow = (key, fallback, label, opacity = true) => row(label, colorButton(s[key] ?? fallback, (c) => { s[key] = c; apply(); }, { opacity }));
  const check = (key, label) => h('label', { class: 'set-row check-row' }, checkbox(s[key], (v) => { s[key] = v; apply(); }), h('span', {}, label));
  const checkColors = (label, onKey, keys) => h('div', { class: 'set-row' },
    h('label', { class: 'check-row' }, checkbox(s[onKey], (v) => { s[onKey] = v; apply(); }), h('span', {}, label)),
    h('span', { class: 'set-controls' }, ...keys.map(([key, fallback]) => colorButton(s[key] ?? fallback, (c) => { s[key] = c; apply(); }))));
  const sel = (key, label, options) => row(label, select(options, s[key], (v) => { s[key] = v; apply(); }));
  const num = (key, label, min, max) => row(label, numberInput(s[key], (v) => { s[key] = Math.min(max, Math.max(min, v)); apply(); }, { min, max, step: 1 }));

  const tabs = [
    {
      id: 'symbol',
      label: 'Symbol',
      render: () => h('div', { class: 'set-pane' },
        h('div', { class: 'set-section' }, 'Candles'),
        check('colorOnPrevClose', 'Color bars based on previous close'),
        row('Body', colorButton(s.upColor, (c) => { s.upColor = c; apply(); }), colorButton(s.downColor, (c) => { s.downColor = c; apply(); })),
        checkColors('Borders', 'borderVisible', [['borderUp', s.upColor], ['borderDown', s.downColor]]),
        checkColors('Wick', 'wickVisible', [['wickUp', s.upColor], ['wickDown', s.downColor]]),
        h('div', { class: 'set-section' }, 'Data modification'),
        sel('precision', 'Precision', [['default', 'Default'], ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((v) => [v, `${v} decimals`])]),
        sel('tz', 'Time zone', [['local', 'Local time'], ['UTC', 'UTC'], ['America/New_York', 'New York'], ['Europe/London', 'London'], ['Asia/Kolkata', 'Kolkata'], ['Asia/Singapore', 'Singapore'], ['Asia/Tokyo', 'Tokyo']]),
        ...chartTypeFields(app.activePane?.type, sel, num)),
    },
    {
      id: 'status',
      label: 'Status line',
      render: () => h('div', { class: 'set-pane' },
        h('div', { class: 'set-section' }, 'Symbol'),
        sel('legendTitle', 'Title', [['ticker', 'Ticker'], ['description', 'Description'], ['both', 'Ticker and description']]),
        check('showOHLC', 'OHLC values'),
        check('showBarChange', 'Bar change values'),
        check('showVolumeLegend', 'Volume'),
        h('div', { class: 'set-section' }, 'Indicators'),
        check('showIndTitles', 'Titles'),
        check('showIndArgs', 'Inputs'),
        check('showIndValues', 'Values'),
        check('legendBg', 'Background')),
    },
    {
      id: 'scales',
      label: 'Scales and lines',
      render: () => h('div', { class: 'set-pane' },
        h('div', { class: 'set-section' }, 'Price scale'),
        check('showLastLabel', 'Symbol last price label'),
        check('showPriceLine', 'Symbol last price line'),
        check('countdown', 'Countdown to bar close'),
        check('showPrevClose', 'Previous day close price line'),
        check('showHighLow', 'High and low price lines (visible range)'),
        check('invertScale', 'Invert scale'),
        h('div', { class: 'set-section' }, 'Crosshair'),
        row('Crosshair',
          colorButton(s.crosshairColor ?? t.crosshair, (c) => { s.crosshairColor = c; apply(); }),
          select([1, 2, 3, 4].map((v) => [v, `${v}px`]), s.crosshairWidth, (v) => { s.crosshairWidth = v; apply(); }, { class: 'w-select', 'aria-label': 'Crosshair width' }),
          select(LINE_STYLES.map((l) => [l.v, `${l.icon} ${l.label}`]), s.crosshairStyle, (v) => { s.crosshairStyle = v; apply(); }, { class: 'w-select', 'aria-label': 'Crosshair style' })),
        check('magnetCrosshair', 'Crosshair snaps to close')),
    },
    {
      id: 'canvas',
      label: 'Canvas',
      render: () => h('div', { class: 'set-pane' },
        h('div', { class: 'set-section' }, 'Chart basic styles'),
        row('Background',
          select([['solid', 'Solid'], ['gradient', 'Gradient']], s.bgType, (v) => { s.bgType = v; apply(); ui.rerender(); }, { class: 'w-select', 'aria-label': 'Background type' }),
          colorButton(s.bgColor ?? t.bg, (c) => { s.bgColor = c; apply(); }),
          s.bgType === 'gradient' ? colorButton(s.bgColor2 ?? t.bg, (c) => { s.bgColor2 = c; apply(); }) : null),
        checkColors('Vert grid lines', 'gridVertOn', [['gridVert', t.grid]]),
        checkColors('Horz grid lines', 'gridHorzOn', [['gridHorz', t.grid]]),
        checkColors('Watermark', 'watermarkOn', [['watermarkColor', 'rgba(138, 147, 166, 0.07)']]),
        h('div', { class: 'set-section' }, 'Scales'),
        colorRow('scaleText', t.text, 'Text', false),
        num('scaleFont', 'Font size', 9, 16),
        colorRow('scaleLines', t.border, 'Lines'),
        h('div', { class: 'set-section' }, 'Margins'),
        num('marginTop', 'Top (%)', 0, 40),
        num('marginBottom', 'Bottom (%)', 0, 40),
        num('rightBars', 'Right (bars)', 0, 200),
        h('div', { class: 'set-section' }, 'Interface'),
        sel('theme', 'Color theme', [['dark', 'Dark'], ['light', 'Light']]),
        check('glass', 'Glass (translucent) panels'),
        check('showVolume', 'Volume overlay')),
    },
    {
      id: 'trading',
      label: 'Trading',
      render: () => h('div', { class: 'set-pane' },
        h('div', { class: 'set-section' }, 'Paper trading'),
        check('showBuySell', 'Buy/Sell buttons'),
        check('showPositions', 'Positions, TP/SL and executions on chart'),
        check('showOrders', 'Orders on chart')),
    },
    {
      id: 'alerts',
      label: 'Alerts',
      render: () => h('div', { class: 'set-pane' },
        check('showAlertLines', 'Alert lines on chart'),
        colorRow('alertColor', '#FF9800', 'Alert line color'),
        check('alertSound', 'Play a sound when an alert fires')),
    },
  ];

  let ui;
  const tplBtn = h('button', { type: 'button', class: 'btn ghost template-btn' }, 'Template ▾');
  tplBtn.addEventListener('click', () => showMenu(tplBtn, [
    { label: 'Apply defaults', icon: '↺', action: () => { Object.assign(s, CHART_DEFAULTS); apply(); ui.rerender(); } },
    { label: 'Save as default', icon: '★', action: () => { store.set('chartTemplate', s); toast('Chart template saved', 'success', 1800); } },
    { label: 'Apply saved template', icon: '▤', disabled: !store.get('chartTemplate', null), action: () => { Object.assign(s, store.get('chartTemplate', {})); apply(); ui.rerender(); } },
  ]));
  ui = tabbedDialog('Chart settings', tabs, {
    width: 660,
    initial: initialTab,
    footerLeft: tplBtn,
    onOk: () => app.saveSettings(),
    onCancel: () => {
      Object.assign(app.settings, JSON.parse(snapshot));
      app.applyChartSettings();
    },
  });
  ui.dialog.el.classList.add('vertical-tabs');
}

// Per-chart-type construction settings (TradingView shows these in Chart settings › Symbol).
function chartTypeFields(type, sel, num) {
  const sizing = (prefix, label, extra = []) => [
    sel(`${prefix}Mode`, `${label} assignment`, [['atr', 'ATR'], ['fixed', 'Traditional (fixed)'], ...extra]),
    num(`${prefix}Atr`, 'ATR length', 1, 200),
  ];
  const head = (label) => h('div', { class: 'set-section' }, label);
  switch (type) {
    case 'renko':
      return [head('Renko'), ...sizing('renko', 'Box size'), num('renkoBox', 'Box size (fixed)', 0, 1e9), sel('renkoSource', 'Source', [['close', 'Close'], ['hl', 'High/Low']])];
    case 'linebreak':
      return [head('Line break'), num('lbLines', 'Number of lines', 1, 10)];
    case 'kagi':
      return [head('Kagi'), ...sizing('kagi', 'Reversal amount', [['percent', 'Percentage']]), num('kagiValue', 'Reversal (fixed / %)', 0, 1e9)];
    case 'pnf':
      return [head('Point & figure'), ...sizing('pnf', 'Box size'), num('pnfBox', 'Box size (fixed)', 0, 1e9), num('pnfReversal', 'Reversal amount (boxes)', 1, 10), sel('pnfSource', 'Source', [['hl', 'High/Low'], ['close', 'Close']])];
    case 'range':
      return [head('Range'), ...sizing('range', 'Range'), num('rangeValue', 'Range (fixed)', 0, 1e9)];
    case 'tpo':
      return [head('Time price opportunity'), num('tpoPeriod', 'Period (minutes)', 1, 1440), num('tpoRows', 'Row size (0 = auto)', 0, 1e9), num('tpoVA', 'Value area %', 10, 100)];
    case 'svp':
      return [head('Session volume profile'), num('svpRows', 'Number of rows', 4, 200), num('svpVA', 'Value area %', 10, 100), num('svpWidth', 'Width (% of session)', 10, 100)];
    case 'footprint':
      return [head('Volume footprint'), num('fpBars', 'Bars with footprint history', 10, 500)];
    default:
      return [];
  }
}
