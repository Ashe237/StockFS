// Zero-dependency Node 18+ server. Data comes from SEC EDGAR (free, no API key).
// Run:  SEC_USER_AGENT="YourApp you@example.com" node server.js
// SEC requires a User-Agent that identifies you, so set SEC_USER_AGENT to your own contact.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { build } = require('./fundamentals');

const PORT = process.env.PORT || 3000;
const UA = process.env.SEC_USER_AGENT || 'StockViewer set-your-contact@example.com';
const PUBLIC = path.join(__dirname, 'public');

const DAY_MS = 864e5;
const cache = new Map(); // key -> {t, v}
async function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

async function secJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) {
    const e = new Error('SEC returned ' + r.status);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

async function tickers() {
  return cached('tickers', DAY_MS, async () => {
    const raw = await secJson('https://www.sec.gov/files/company_tickers.json');
    return Object.values(raw).map((c) => ({
      cik: String(c.cik_str).padStart(10, '0'),
      ticker: c.ticker,
      name: c.title,
    }));
  });
}

async function search(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const all = await tickers();
  const exact = all.filter((c) => c.ticker.toLowerCase() === q);
  const prefix = all.filter((c) => c.ticker.toLowerCase().startsWith(q) && !exact.includes(c));
  const byName = all.filter(
    (c) => c.name.toLowerCase().includes(q) && !exact.includes(c) && !prefix.includes(c)
  );
  return [...exact, ...prefix, ...byName].slice(0, 10);
}

async function company(ticker) {
  const all = await tickers();
  const hit = all.find((c) => c.ticker.toLowerCase() === ticker.toLowerCase());
  if (!hit) {
    const e = new Error('Unknown ticker: ' + ticker);
    e.status = 404;
    throw e;
  }
  return cached('co:' + hit.cik, 12 * 60 * 60 * 1000, async () => {
    const facts = await secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${hit.cik}.json`);
    return { ticker: hit.ticker, cik: hit.cik, ...build(facts) };
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/search') {
      return send(res, 200, await search(url.searchParams.get('q') || ''));
    }
    if (url.pathname === '/api/company') {
      const t = url.searchParams.get('ticker');
      if (!t) return send(res, 400, { error: 'ticker required' });
      return send(res, 200, await company(t));
    }
    // static files
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Stock viewer running on http://localhost:${PORT}`));
