// Option chain (TradingView style): calls | strike | puts for one expiry, live from Binance options
// (mark/bid/ask/IV/greeks stream) or Deribit (book summary refreshed every 5 s, delta via Black–Scholes).
// Clicking a contract opens it on a chart, beside its underlying, as a straddle across charts,
// or places a paper trade.

import { bsDelta, boptQuoteFrom, optionTitle, PROVIDERS } from './providers.js';
import { escapeHtml, formatCompact, formatPrice, h, modal, showMenu, store } from './util.js';

const UNDERLYINGS = { bopt: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'], deribit: ['BTC', 'ETH'] };
const YEAR_MS = 365 * 86400_000;

export function openOptionChain(app, { provider, base } = {}) {
  let prov = provider ?? store.get('chainProvider', 'bopt');
  let under = base ?? store.get('chainBase', 'BTC');
  let range = store.get('chainRange', 12);
  let expiry = null;
  let contracts = [];
  let quotes = new Map();
  let index = NaN;
  let unsub = null;
  let timer = null;
  let queued = false;
  let lastRender = 0;

  const provTabs = h('div', { class: 'segmented' });
  const underSel = h('select', { 'aria-label': 'Underlying' });
  const rangeSel = h('select', { 'aria-label': 'Strikes shown' }, ...[[8, '±8 strikes'], [12, '±12 strikes'], [20, '±20 strikes'], [0, 'All strikes']].map(([v, l]) => h('option', { value: v, selected: v === range }, l)));
  const expTabs = h('div', { class: 'chain-expiries' });
  const status = h('span', { class: 'muted small' });
  const table = h('div', { class: 'chain-table' });
  const body = h('div', { class: 'option-chain' }, h('div', { class: 'chain-controls' }, provTabs, underSel, rangeSel, h('span', { class: 'spacer' }), status), expTabs, table);
  const stop = () => {
    unsub?.();
    unsub = null;
    clearTimeout(timer);
  };
  const dialog = modal('Option chain', body, { width: 1100, onClose: stop });
  dialog.el.classList.add('chain-dialog');

  const scheduleRender = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => requestAnimationFrame(() => {
      queued = false;
      lastRender = performance.now();
      renderTable();
    }), Math.max(0, 500 - (performance.now() - lastRender)));
  };
  const underlyingSymbol = () => (prov === 'bopt' ? `${under}USDT.P` : `DERIBIT:${under}-PERPETUAL`);

  async function load() {
    stop();
    quotes = new Map();
    index = NaN;
    status.textContent = 'Loading…';
    table.replaceChildren(h('div', { class: 'empty big' }, 'Loading option chain…'));
    const list = await app.loadMarket(prov);
    contracts = list.filter((c) => c.type === 'option' && c.base === under && !c.symbol.includes('_USDC'));
    const expiries = [...new Set(contracts.map((c) => c.expiry))].sort((a, b) => a - b);
    if (!expiries.includes(expiry)) expiry = expiries[0] ?? null;
    renderExpiries(expiries);
    if (prov === 'bopt') {
      try {
        const [marks, tick] = await Promise.all([PROVIDERS.bopt.markSnapshot(), PROVIDERS.bopt.tickerSnapshot()]);
        const vol = new Map(tick.map((t) => [t.symbol, Number(t.volume)]));
        for (const r of marks) {
          if (!r.symbol.startsWith(`${under}-`)) continue;
          quotes.set(r.symbol, { ...boptQuoteFrom({ s: r.symbol, mp: r.markPrice, bo: 0, ao: 0, vo: r.markIV, d: r.delta, g: r.gamma, t: r.theta, v: r.vega }), volume: vol.get(r.symbol) });
        }
      } catch (error) {
        status.textContent = `Snapshot failed: ${error.message}`;
      }
      unsub = PROVIDERS.bopt.subscribeChain(`${under}USDT`, (rows) => {
        for (const r of rows) {
          quotes.set(r.s, { ...boptQuoteFrom(r), volume: quotes.get(r.s)?.volume });
          index = Number(r.i);
        }
        status.textContent = `Live · index ${formatPrice(index, 2)}`;
        scheduleRender();
      });
    } else {
      const poll = async () => {
        try {
          const rows = await PROVIDERS.deribit.chainSnapshot(under);
          for (const r of rows) {
            quotes.set(`DERIBIT:${r.instrument_name}`, { bid: r.bid_price, ask: r.ask_price, mark: r.mark_price, iv: r.mark_iv / 100, oi: r.open_interest, volume: r.volume, underlying: r.underlying_price });
            index = r.estimated_delivery_price ?? index;
          }
          status.textContent = `Updated ${new Date().toLocaleTimeString()} · index ${formatPrice(index, 2)} · premiums in ${under}`;
          scheduleRender();
        } catch (error) {
          status.textContent = `Refresh failed: ${error.message}`;
        }
        timer = setTimeout(poll, 5000);
      };
      poll();
    }
    renderTable();
  }

  function renderControls() {
    provTabs.replaceChildren(...[['bopt', 'Binance'], ['deribit', 'Deribit']].map(([id, label]) => h('button', {
      type: 'button',
      class: `seg${id === prov ? ' active' : ''}`,
      onclick: () => {
        prov = id;
        store.set('chainProvider', id);
        if (!UNDERLYINGS[id].includes(under)) under = UNDERLYINGS[id][0];
        renderControls();
        load();
      },
    }, label)));
    underSel.replaceChildren(...UNDERLYINGS[prov].map((u) => h('option', { value: u, selected: u === under }, u)));
  }
  underSel.addEventListener('change', () => {
    under = underSel.value;
    store.set('chainBase', under);
    expiry = null;
    load();
  });
  rangeSel.addEventListener('change', () => {
    range = Number(rangeSel.value);
    store.set('chainRange', range);
    renderTable();
  });

  function renderExpiries(expiries) {
    expTabs.replaceChildren(...expiries.map((e) => h('button', {
      type: 'button',
      class: `chain-exp${e === expiry ? ' active' : ''}`,
      onclick: () => {
        expiry = e;
        renderExpiries(expiries);
        renderTable();
      },
    }, new Date(e).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }), h('small', {}, `${Math.max(0, Math.ceil((e - Date.now()) / 86400_000))}d`))));
  }

  function contractMenu(anchor, c) {
    const pair = contracts.find((x) => x.expiry === c.expiry && x.strike === c.strike && x.side !== c.side);
    const [call, put] = c.side === 'C' ? [c.symbol, pair?.symbol] : [pair?.symbol, c.symbol];
    const qty = store.get(`qty.${c.symbol}`, 0.1);
    app.broker.watch([...app.panes.map((p) => p.symbol), c.symbol]);
    showMenu(anchor, [
      { header: optionTitle(c.symbol) },
      { label: 'Open chart', icon: '📈', action: () => { app.activePane.setSymbol(c.symbol); dialog.close(); } },
      { label: 'Open beside current chart', icon: '◫', action: () => { app.openInNewPane(c.symbol); dialog.close(); } },
      { label: `Open with underlying (${underlyingSymbol()})`, icon: '⊞', action: () => { app.openSymbols([underlyingSymbol(), c.symbol]); dialog.close(); } },
      pair ? { label: 'Straddle: call + put in 2 charts', icon: '⫽', action: () => { app.openSymbols([call, put]); dialog.close(); } } : null,
      pair ? { label: 'Underlying + call + put (3 charts)', icon: '◰', action: () => { app.openSymbols([underlyingSymbol(), call, put]); dialog.close(); } } : null,
      '-',
      { label: `Paper buy ${qty} at ask`, icon: '▲', action: () => app.broker.placeOrder({ symbol: c.symbol, side: 'buy', type: 'market', qty }) },
      { label: `Paper sell ${qty} at bid`, icon: '▼', action: () => app.broker.placeOrder({ symbol: c.symbol, side: 'sell', type: 'market', qty }) },
      { label: 'Add to watchlist', icon: '☆', action: () => app.sidebar.addToWatchlist(c.symbol) },
    ].filter(Boolean), { className: 'glass-pop' });
  }

  function renderTable() {
    const list = contracts.filter((c) => c.expiry === expiry);
    if (!list.length) {
      table.replaceChildren(h('div', { class: 'empty big' }, contracts.length ? 'No contracts for this expiry.' : 'No option contracts found.'));
      return;
    }
    const byStrike = new Map();
    for (const c of list) {
      if (!byStrike.has(c.strike)) byStrike.set(c.strike, {});
      byStrike.get(c.strike)[c.side] = c;
    }
    let strikes = [...byStrike.keys()].sort((a, b) => a - b);
    const S = quotes.get(list[0].symbol)?.underlying || index;
    let atm = strikes[0];
    if (Number.isFinite(S)) for (const k of strikes) if (Math.abs(k - S) < Math.abs(atm - S)) atm = k;
    if (range > 0) {
      const i = strikes.indexOf(atm);
      strikes = strikes.slice(Math.max(0, i - range), i + range + 1);
    }
    const years = Math.max(1e-6, (expiry - Date.now()) / YEAR_MS);
    const digits = prov === 'deribit' ? 4 : 2;
    const cells = (c, side) => {
      if (!c) return '<td></td>'.repeat(7);
      const q = quotes.get(c.symbol) ?? {};
      const delta = Number.isFinite(q.delta) ? q.delta : bsDelta(side, q.underlying || S, c.strike, years, q.iv);
      const v = (x) => (Number.isFinite(x) && x > 0 ? formatPrice(x, digits) : '—');
      const vals = [
        `<td class="c-oi">${Number.isFinite(q.oi) ? formatCompact(q.oi) : '—'}</td>`,
        `<td class="c-vol">${Number.isFinite(q.volume) ? formatCompact(q.volume) : '—'}</td>`,
        `<td>${Number.isFinite(q.iv) ? `${(q.iv * 100).toFixed(1)}%` : '—'}</td>`,
        `<td>${Number.isFinite(delta) ? delta.toFixed(2) : '—'}</td>`,
        `<td class="bid">${v(q.bid)}</td>`,
        `<td class="ask">${v(q.ask)}</td>`,
        `<td class="mark">${v(q.mark)}</td>`,
      ];
      return (side === 'C' ? vals : vals.reverse()).join('');
    };
    const callHead = ['OI', 'Vol', 'IV', 'Δ', 'Bid', 'Ask', 'Mark'];
    const cls = (x) => (x === 'OI' ? 'c-oi' : x === 'Vol' ? 'c-vol' : '');
    const head = '<tr><th colspan="7" class="side-head">Calls</th><th></th><th colspan="7" class="side-head">Puts</th></tr>'
      + `<tr>${callHead.map((x) => `<th class="${cls(x)}">${x}</th>`).join('')}<th>Strike</th>${[...callHead].reverse().map((x) => `<th class="${cls(x)}">${x}</th>`).join('')}</tr>`;
    const rows = strikes.map((k) => {
      const pair = byStrike.get(k);
      const callItm = Number.isFinite(S) && k < S;
      const putItm = Number.isFinite(S) && k > S;
      return `<tr class="${k === atm ? 'atm' : ''}">`
        + `${cells(pair.C, 'C').replace(/<td/g, `<td data-sym="${escapeHtml(pair.C?.symbol ?? '')}" data-itm="${callItm}"`)}`
        + `<td class="strike">${k.toLocaleString('en-US')}</td>`
        + `${cells(pair.P, 'P').replace(/<td/g, `<td data-sym="${escapeHtml(pair.P?.symbol ?? '')}" data-itm="${putItm}"`)}</tr>`;
    }).join('');
    const prevTop = table.querySelector('.chain-scroll')?.scrollTop;
    table.innerHTML = `<div class="chain-scroll"><table class="chain">${head}${rows}</table></div>`;
    const scroller = table.querySelector('.chain-scroll');
    if (prevTop !== undefined) scroller.scrollTop = prevTop;
    else scroller.querySelector('tr.atm')?.scrollIntoView({ block: 'center' });
  }

  table.addEventListener('click', (event) => {
    const cell = event.target.closest('td[data-sym]');
    if (!cell?.dataset.sym) return;
    const c = contracts.find((x) => x.symbol === cell.dataset.sym);
    if (c) contractMenu(new DOMRect(event.clientX, event.clientY, 0, 0), c);
  });

  renderControls();
  load();
}
