// Vite config for the Orbit chart app (`npm run chart`).
// Adds a tiny local API so paper-trading data is stored on disk, not only in the browser:
//   GET  /api/paper          → data/paper/account.json (404 if none yet)
//   PUT  /api/paper          → overwrite data/paper/account.json
//   POST /api/paper/trades   → append closed trades to data/paper/trades.csv (+ trades.jsonl)
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const DIR = path.resolve('data/paper');
const ACCOUNT = path.join(DIR, 'account.json');
const CSV = path.join(DIR, 'trades.csv');
const JSONL = path.join(DIR, 'trades.jsonl');
const CSV_HEADER = 'id,symbol,side,qty,leverage,entry_time,entry_price,exit_time,exit_price,exit_reason,gross_pnl,fees,net_pnl,return_pct,duration_min\n';
const MAX_BODY = 5 * 1024 * 1024;

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function paperApi() {
  const handler = async (req, res, next) => {
    const url = req.url?.split('?')[0];
    if (!url?.startsWith('/api/paper')) return next();
    try {
      fs.mkdirSync(DIR, { recursive: true });
      if (url === '/api/paper' && req.method === 'GET') {
        if (!fs.existsSync(ACCOUNT)) return send(res, 404, { error: 'No paper account yet' });
        return send(res, 200, JSON.parse(fs.readFileSync(ACCOUNT, 'utf8')));
      }
      if (url === '/api/paper' && req.method === 'PUT') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || !Number.isFinite(body.balance)) return send(res, 400, { error: 'Invalid account' });
        // Optimistic concurrency: a tab holding an older revision must reload instead of overwriting.
        const current = fs.existsSync(ACCOUNT) ? JSON.parse(fs.readFileSync(ACCOUNT, 'utf8')) : null;
        if (current && Number.isFinite(current.rev) && body.baseRev !== current.rev) return send(res, 409, current);
        body.rev = (current?.rev ?? 0) + 1;
        delete body.baseRev;
        const tmp = `${ACCOUNT}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
        fs.renameSync(tmp, ACCOUNT);
        return send(res, 200, { ok: true, rev: body.rev });
      }
      if (url === '/api/paper/trades' && req.method === 'POST') {
        const trades = await readBody(req);
        if (!Array.isArray(trades)) return send(res, 400, { error: 'Expected an array' });
        if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, CSV_HEADER);
        for (const t of trades) {
          fs.appendFileSync(JSONL, `${JSON.stringify(t)}\n`);
          const row = [
            t.id, t.symbol, t.side, t.qty, t.leverage, new Date(t.opened).toISOString(), t.entry, new Date(t.closed).toISOString(), t.exit,
            t.reason, t.gross?.toFixed(4), t.fees?.toFixed(4), t.pnl?.toFixed(4), t.returnPct?.toFixed(3), ((t.closed - t.opened) / 60000).toFixed(1),
          ];
          fs.appendFileSync(CSV, `${row.map(csvCell).join(',')}\n`);
        }
        return send(res, 200, { ok: true, appended: trades.length });
      }
      return send(res, 405, { error: 'Unsupported' });
    } catch (error) {
      return send(res, 500, { error: error.message });
    }
  };
  return {
    name: 'orbit-paper-storage',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

// Market data endpoints without CORS headers (Binance options REST, Deribit chart data).
const PROXY = {
  '/eapi': { target: 'https://eapi.binance.com', changeOrigin: true },
  '/deribit': { target: 'https://www.deribit.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/deribit/, '') },
  // CandL recorders (~/Desktop/candl/prodserv: npm run recorder:map / recorder:book) for the
  // MAP V3 and DOM Heatmap custom indicators. When they are not running those indicators say so.
  '/maplevels': { target: process.env.MAP_URL ?? 'http://127.0.0.1:8788', changeOrigin: true },
  '/book': { target: process.env.BOOK_URL ?? 'http://127.0.0.1:8789', changeOrigin: true },
};

export default defineConfig({
  plugins: [paperApi()],
  server: {
    watch: { ignored: ['**/data/**'] },
    // Binance options REST sends no CORS headers, so the browser reaches it through this proxy.
    proxy: PROXY,
  },
  preview: { proxy: PROXY },
});
