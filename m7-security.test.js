'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

test('login lockout after repeated failures, correct password still works for other users', async () => {
  const s = await start();
  try {
    await s.admin.post('/api/users', { username: 'u2', name: 'U', password: 'user2-pass-ok', role: 'viewer' });
    const c = s.client();
    for (let i = 0; i < 8; i++) assert.equal((await c.post('/api/login', { username: 'u2', password: 'nope' })).status, 401);
    assert.equal((await c.post('/api/login', { username: 'u2', password: 'user2-pass-ok' })).status, 429); // locked even with the right password
    assert.equal((await s.client().post('/api/login', { username: 'admin', password: 'AdminPass123' })).status, 200);
  } finally { s.close(); }
});

test('static server only serves UI files; source, db and traversal are 404; security headers set', async () => {
  const s = await start();
  try {
    for (const p of ['/server.js', '/erp.db', '/package.json', '/..%2fserver.js', '/%2e%2e/server.js', '/auth.js']) assert.equal((await fetch(s.base + p)).status, 404, p);
    const r = await fetch(s.base + '/');
    assert.equal(r.status, 200); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(s.base + '/api/customers')).status, 401);
  } finally { s.close(); }
});

test('logged-out session token stops working; deactivated user is locked out at once', async () => {
  const s = await start();
  try {
    const a = s.admin;
    const uid = (await a.post('/api/users', { username: 'u3', name: 'U', password: 'user3-pass-ok', role: 'sales' })).body.id;
    const c = s.client(); await c.post('/api/login', { username: 'u3', password: 'user3-pass-ok' });
    assert.equal((await c.get('/api/customers')).status, 200);
    await a.put('/api/users/' + uid, { active: 0 });
    assert.equal((await c.get('/api/customers')).status, 401);
    await a.put('/api/users/' + uid, { active: 1 });
    const d = s.client(); await d.post('/api/login', { username: 'u3', password: 'user3-pass-ok' });
    await d.post('/api/logout');
    assert.equal((await d.get('/api/customers')).status, 401);
  } finally { s.close(); }
});
