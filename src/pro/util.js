// Shared helpers: formatting, storage, events, small DOM utilities.

export const INTERVALS = [
  { id: '1m', label: '1m', group: 'Minutes', sec: 60 },
  { id: '3m', label: '3m', group: 'Minutes', sec: 180 },
  { id: '5m', label: '5m', group: 'Minutes', sec: 300 },
  { id: '15m', label: '15m', group: 'Minutes', sec: 900 },
  { id: '30m', label: '30m', group: 'Minutes', sec: 1800 },
  { id: '1h', label: '1H', group: 'Hours', sec: 3600 },
  { id: '2h', label: '2H', group: 'Hours', sec: 7200 },
  { id: '4h', label: '4H', group: 'Hours', sec: 14400 },
  { id: '6h', label: '6H', group: 'Hours', sec: 21600 },
  { id: '8h', label: '8H', group: 'Hours', sec: 28800 },
  { id: '12h', label: '12H', group: 'Hours', sec: 43200 },
  { id: '1d', label: '1D', group: 'Days', sec: 86400 },
  { id: '3d', label: '3D', group: 'Days', sec: 259200 },
  { id: '1w', label: '1W', group: 'Days', sec: 604800 },
  { id: '1M', label: '1M', group: 'Days', sec: 2592000 },
];
export const FAVORITE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
export const intervalSec = (id) => INTERVALS.find((i) => i.id === id)?.sec ?? 3600;
export const intervalLabel = (id) => INTERVALS.find((i) => i.id === id)?.label ?? id;

export const PALETTE = ['#2f80ed', '#f5a623', '#e8505b', '#27ae60', '#9b51e0', '#00b8d9', '#f2c94c', '#eb5ea8', '#a0aec0', '#ffffff'];

export function formatPrice(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const d = digits ?? priceDigits(value);
  return value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function priceDigits(value) {
  const v = Math.abs(value);
  if (v >= 1000) return 2;
  if (v >= 10) return 3;
  if (v >= 1) return 4;
  if (v >= 0.01) return 5;
  return 8;
}

export function formatCompact(value) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

export function formatPct(value, signed = true) {
  if (!Number.isFinite(value)) return '—';
  return `${signed && value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function signClass(value) {
  if (!Number.isFinite(value) || value === 0) return 'neutral';
  return value > 0 ? 'up' : 'down';
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`orbit.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`orbit.${key}`, JSON.stringify(value));
    } catch {
      // Storage may be unavailable (private mode); the app still works without it.
    }
  },
};

export class Emitter {
  constructor() { this.handlers = new Map(); }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }
  emit(event, payload) {
    this.handlers.get(event)?.forEach((fn) => {
      try { fn(payload); } catch (error) { console.error(`[${event}]`, error); }
    });
  }
}

export const bus = new Emitter();

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') el.innerHTML = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastHost;
export function toast(message, kind = 'info', ms = 4200) {
  toastHost ??= document.body.appendChild(h('div', { class: 'toast-host', 'aria-live': 'polite' }));
  const el = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

let audioCtx;
export function beep(freq = 880, duration = 0.18) {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch {
    // Audio is optional.
  }
}

export function throttleFrame(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Pop-up menus anchored to a button or a DOMRect.
let openMenu = null;
export function closeMenus() {
  openMenu?.remove();
  openMenu = null;
}
export function showMenu(anchor, items, { align = 'left', className = '' } = {}) {
  closeMenus();
  const menu = h('div', { class: `menu ${className}`, role: 'menu' });
  for (const item of items) {
    if (item === '-') { menu.append(h('div', { class: 'menu-sep' })); continue; }
    if (item.header) { menu.append(h('div', { class: 'menu-header' }, item.header)); continue; }
    const btn = h('button', {
      type: 'button',
      role: 'menuitem',
      class: `menu-item${item.active ? ' active' : ''}${item.danger ? ' danger' : ''}`,
      disabled: item.disabled,
    },
    h('span', { class: 'menu-icon' }, item.icon ?? ''),
    h('span', { class: 'menu-label' }, item.label),
    item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null);
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenus();
      item.action?.();
    });
    menu.append(btn);
  }
  document.body.append(menu);
  const rect = anchor instanceof DOMRect ? anchor : anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = align === 'right' ? rect.right - mw : rect.left;
  let top = rect.bottom + 4;
  left = Math.max(6, Math.min(left, window.innerWidth - mw - 6));
  if (top + mh > window.innerHeight - 6) top = Math.max(6, rect.top - mh - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  openMenu = menu;
  return closeMenus;
}
document.addEventListener('pointerdown', (event) => {
  if (openMenu && !openMenu.contains(event.target)) closeMenus();
});
window.addEventListener('blur', closeMenus);

// Modal dialog. `body` is a Node; returns { el, close }.
export function modal(title, body, { width = 520, onClose, footer } = {}) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: { width: `min(${width}px, calc(100vw - 32px))` } },
    h('div', { class: 'modal-head' },
      h('h3', {}, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  backdrop.append(dialog);
  backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  return { el: dialog, close };
}

export function downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
}

export function lowerBound(arr, value, key = (x) => x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
