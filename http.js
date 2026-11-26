'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { can, userFromToken } = require('./auth');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const SEC = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
const STATIC = ['index.html', 'ui.js', 'ui.css', 'i18n.js'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

function createApp(db, { publicDir } = {}) {
  const routes = [];
  const app = {
    db,
    // route('GET','/api/x/:id', 'perm:action' | null, handler(ctx))
    route(method, pattern, perm, handler) {
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
      routes.push({ method, re, keys, perm, handler });
    },
    HttpError,
  };
  app.server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
        if (!route) throw new HttpError(404, 'not_found');
        const m = url.pathname.match(route.re);
        const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const cookie = (req.headers.cookie || '').match(/erp_token=([a-f0-9]+)/);
        const token = cookie ? cookie[1] : null;
        const user = userFromToken(db, token);
        if (route.perm) {
          if (!user) throw new HttpError(401, 'login_required');
          if (route.perm !== 'auth:any' && !can(user.role, route.perm)) throw new HttpError(403, 'forbidden');
        }
        let body = {};
        if (req.method !== 'GET' && req.method !== 'DELETE') {
          const chunks = []; let size = 0;
          for await (const c of req) { size += c.length; if (size > 1e6) throw new HttpError(413, 'too_large'); chunks.push(c); }
          try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw new HttpError(400, 'bad_json'); }
        }
        const ctx = { params, query: Object.fromEntries(url.searchParams), body, user, token, res };
        const out = await route.handler(ctx);
        if (out && out.__csv !== undefined) { res.writeHead(200, { ...SEC, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${out.filename}"` }); return res.end('\uFEFF' + out.__csv); }
        if (!res.headersSent) { res.writeHead(200, { ...SEC, 'content-type': 'application/json', ...(ctx.headers || {}) }); res.end(JSON.stringify(out ?? { ok: true })); }
      } else if (publicDir) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!STATIC.includes(name)) throw new HttpError(404, 'not_found'); // only UI files are served, never source or the db
        res.writeHead(200, { ...SEC, 'content-type': MIME[path.extname(name)] || 'application/octet-stream' });
        fs.createReadStream(path.join(publicDir, name)).pipe(res);
      } else throw new HttpError(404, 'not_found');
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'server_error' : e.message }));
    }
  });
  return app;
}
// CSV for spreadsheets: quotes escaped, and cells that start with = + - @ are prefixed so Excel never runs them as formulas
function toCsv(rows) {
  const cell = x => { let s = x == null ? '' : String(x); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return rows.map(r => r.map(cell).join(',')).join('\r\n');
}
// small validation helpers
const v = {
  str(x, name, { max = 200, req = true } = {}) {
    if (x == null || x === '') { if (req) throw new HttpError(400, name + '_required'); return null; }
    if (typeof x !== 'string' || x.length > max) throw new HttpError(400, name + '_invalid');
    return x.trim();
  },
  int(x, name, { min = 0 } = {}) {
    if (!Number.isInteger(x) || x < min) throw new HttpError(400, name + '_invalid');
    return x;
  },
  num(x, name, { min = 0 } = {}) {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < min) throw new HttpError(400, name + '_invalid');
    return x;
  },
  date(x, name) {
    if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || isNaN(Date.parse(x))) throw new HttpError(400, name + '_invalid');
    return x;
  },
};
module.exports = { createApp, HttpError, v, toCsv };
