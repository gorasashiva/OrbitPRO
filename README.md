# Orbit Pro

A browser charting and paper-trading platform for crypto markets, built on
[Lightweight Charts](https://www.tradingview.com/lightweight-charts/) v5 and Vite. It uses public
market data only, so you need no API keys.

## Run it

```bash
npm install
npm run chart          # dev server on http://127.0.0.1:5173
npm run build:chart    # production build into dist/
npm run preview:chart  # serve the build
```

Open `http://127.0.0.1:5173/?sandbox` to test with a throwaway paper account kept in the browser.
Your saved account and trades are not touched.

## Features

- **Markets:**
  - Binance spot
  - Binance USDⓈ-M perpetuals (`BTCUSDT.P`)
  - Binance options (`BTC-261225-85000-C`)
  - Deribit options and futures (`DERIBIT:BTC-27NOV26-64000-C`)

  Each chart in a multi-chart layout can use a different market.
- **Option charts:**
  - an option chain with calls, strikes and puts
  - greeks, IV and funding in the status line
  - a **Mark / Last** candle switch. Mark history is modelled with Black–Scholes from the underlying's candles, using the exchange's current IV and anchored to its live mark price. Live mark bars come from the exchange's stream.
- **21 chart types:** including Heikin Ashi, Renko, Kagi, Point & Figure, Line Break, Range, TPO, session volume profile, and a **volume footprint**. The footprint builds recent bars from every aggregated trade and estimates older bars from sub-interval candles, marked "≈".
- **Drawing tools:** 76 tools in TradingView-style groups, with a floating toolbar, settings dialogs, magnet mode, and favourites.
- **Indicators:**
  - the built-ins, with TradingView-style settings
  - indicator templates
  - **44 custom indicators** ported from the CandL platform (see below)
- **Layouts:** multi-chart grids and named layouts with save, save as, autosave, and switching. Layouts and templates are stored in the browser's local storage.
- **Paper trading:**
  - netted positions, isolated margin, leverage and liquidation
  - bid/ask fills and fees
  - TP/SL and orders on the chart
  - trade history with a full breakdown and CSV export
- **Strategy tester:** built-in strategies plus the strategy-style custom indicators, with an equity curve and trade list.
- **Other:** alerts, watchlist, order book, recent trades, data window, object tree, and bar replay.
- **Layout:** a glass theme that fits any screen size.

## Custom indicators (CandL)

The original CandL TypeScript sources live unchanged under `src/candl/` and keep CandL's folder
layout. `src/pro/customind.js` adapts them to Orbit:

- converts CandL's millisecond timestamps to and from Orbit's seconds
- maps symbols to Delta names (BTCUSDT → BTCUSD, XAUTUSDT → XAUTUSD)
- draws canvas indicators through a series primitive
- feeds strategy trades to the tester

To update an indicator, copy the changed CandL file to the same path under `src/candl/`.

MAP V3 and the DOM Heatmap's history need the CandL recorders. The dev server forwards `/maplevels`
to `127.0.0.1:8788` and `/book` to `127.0.0.1:8789`; change these with the `MAP_URL` and `BOOK_URL`
environment variables.

## Project layout

```
index.html            app shell
vite.config.js        dev server: paper-trading API, exchange proxies (no-CORS endpoints)
src/chartApp.js       entry
src/chartStyles.css   theme and layout
src/pro/              application code (app, panes, providers, chart types, drawings, panels…)
src/candl/            vendored CandL indicator sources
```

## Data

- The paper account and trade history are written by the dev server to `data/paper/`
  (`account.json`, `trades.csv`, `trades.jsonl`). This folder is not part of the repository.
- Binance options REST and Deribit chart data have no CORS headers, so they go through the Vite
  proxies (`/eapi`, `/deribit`). Run Orbit with `npm run chart` or `npm run preview:chart`, not as
  static files.

Paper trading only. This is not investment advice.
