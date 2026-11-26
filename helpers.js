'use strict';
const { build } = require('./server');
async function start() {
  process.env.ADMIN_PASSWORD = 'AdminPass123';
  const app = build(':memory:');
  await new Promise(r => app.server.listen(0, r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  function client() {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    return { get: p => call('GET', p), post: (p, b) => call('POST', p, b || {}), put: (p, b) => call('PUT', p, b), del: p => call('DELETE', p) };
  }
  const admin = client();
  await admin.post('/api/login', { username: 'admin', password: 'AdminPass123' });
  return { app, base, client, admin, close: () => app.server.close() };
}
module.exports = { start };
