'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');
const { openDb } = require('./db');
const { build } = require('./server');

const login = async (s, u, p) => { const c = s.client(); await c.post('/api/login', { username: u, password: p }); return c; };

test('custom role: create, assign, permissions take effect immediately, edit and revoke', async () => {
  const s = await start();
  try {
    const a = s.admin;
    assert.equal((await a.post('/api/roles-admin', { name: 'cashier', perms: ['customers:read', 'invoices:read', 'invoices:write'] })).status, 200);
    assert.equal((await a.post('/api/users', { username: 'c1', name: 'C', password: 'cashier-pass', role: 'cashier' })).status, 200);
    const c = await login(s, 'c1', 'cashier-pass');
    assert.equal((await c.get('/api/invoices')).status, 200);
    assert.equal((await c.get('/api/products')).status, 403);
    assert.equal((await c.get('/api/employees')).status, 403);
    await a.put('/api/roles-admin/cashier', { perms: ['products:read'] }); // takes effect on the next request, no re-login
    assert.equal((await c.get('/api/products')).status, 200);
    assert.equal((await c.get('/api/invoices')).status, 403);
    assert.equal((await a.del('/api/roles-admin/cashier')).status, 409); // in use
    assert.ok((await a.get('/api/roles-admin')).body.items.find(r => r.name === 'cashier').users === 1);
  } finally { s.close(); }
});

test('validation and protection: admin is fixed, bad names and unknown permissions rejected, non-admin cannot edit roles', async () => {
  const s = await start();
  try {
    const a = s.admin;
    assert.equal((await a.put('/api/roles-admin/admin', { perms: [] })).status, 409);
    assert.equal((await a.del('/api/roles-admin/admin')).status, 409);
    assert.equal((await a.post('/api/roles-admin', { name: 'Bad Name', perms: [] })).status, 400);
    assert.equal((await a.post('/api/roles-admin', { name: 'sales', perms: [] })).status, 409); // exists
    assert.equal((await a.post('/api/roles-admin', { name: 'ghost', perms: ['nothing:read'] })).status, 400);
    assert.equal((await a.post('/api/roles-admin', { name: 'ghost', perms: ['reports:write'] })).status, 400); // reports has only read
    assert.equal((await a.post('/api/roles-admin', { name: 'ghost', perms: ['*'] })).status, 400); // '*' is admin-only
    await a.post('/api/users', { username: 'ac1', name: 'A', password: 'account-pass', role: 'accountant' });
    const ac = await login(s, 'ac1', 'account-pass');
    assert.equal((await ac.get('/api/roles-admin')).status, 403);
    assert.equal((await ac.post('/api/roles-admin', { name: 'x1', perms: ['users:write'] })).status, 403);
  } finally { s.close(); }
});

test('built-in roles can be changed and reset; custom roles can be deleted when unused; changes persist across restart', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const file = path.join(os.tmpdir(), 'erp-roles-' + process.pid + '.db');
  try { fs.unlinkSync(file); } catch { }
  process.env.ADMIN_PASSWORD = 'AdminPass123';
  const boot = async () => { const app = build(file); await new Promise(r => app.server.listen(0, r)); return app; };
  const call = async (app, cookie, method, p, body) => {
    const res = await fetch('http://127.0.0.1:' + app.server.address().port + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  let app = await boot();
  let ck = (await call(app, '', 'POST', '/api/login', { username: 'admin', password: 'AdminPass123' })).cookie;
  await call(app, ck, 'PUT', '/api/roles-admin/viewer', { perms: ['customers:read'] });
  await call(app, ck, 'POST', '/api/roles-admin', { name: 'temp_role', perms: ['reports:read'] });
  assert.equal((await call(app, ck, 'DELETE', '/api/roles-admin/temp_role')).status, 200); // unused custom role deleted
  await call(app, ck, 'POST', '/api/roles-admin', { name: 'keeper', perms: ['reports:read'] });
  app.server.close(); app.db.close();
  app = await boot(); // restart: overrides come back from the database
  ck = (await call(app, '', 'POST', '/api/login', { username: 'admin', password: 'AdminPass123' })).cookie;
  const items = (await call(app, ck, 'GET', '/api/roles-admin')).body.items;
  assert.deepEqual(items.find(r => r.name === 'viewer').perms, ['customers:read']);
  assert.ok(items.find(r => r.name === 'keeper'));
  assert.ok(!items.find(r => r.name === 'temp_role'));
  assert.equal((await call(app, ck, 'DELETE', '/api/roles-admin/viewer')).body.reset, true); // reset to default
  assert.ok((await call(app, ck, 'GET', '/api/roles-admin')).body.items.find(r => r.name === 'viewer').perms.includes('products:read'));
  app.server.close(); app.db.close();
  for (const f of [file, file + '-wal', file + '-shm']) try { fs.unlinkSync(f); } catch { }
});
