'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');
const { computeTotals } = require('./invoices');

test('totals are computed in integer minor units with per-line tax', () => {
  const t = computeTotals([{ qty: 3, unit_price: 1000, tax_rate: 14 }, { qty: 0.5, unit_price: 999, tax_rate: 0 }]);
  assert.deepEqual(t, { subtotal: 3000 + 500, tax: 420, total: 3920 });
});

test('auth: login required, bad password rejected, passwords hashed', async () => {
  const s = await start();
  try {
    const anon = s.client();
    assert.equal((await anon.get('/api/customers')).status, 401);
    assert.equal((await anon.post('/api/login', { username: 'admin', password: 'wrong' })).status, 401);
    assert.equal((await s.admin.get('/api/me')).body.user.role, 'admin');
    const row = s.app.db.prepare("SELECT pass_hash FROM users WHERE username='admin'").get();
    assert.match(row.pass_hash, /^scrypt\$/);
    assert.ok(!row.pass_hash.includes('AdminPass123'));
  } finally { s.close(); }
});

test('roles: viewer can read but not write; sales cannot manage users', async () => {
  const s = await start();
  try {
    assert.equal((await s.admin.post('/api/users', { username: 'v1', name: 'Viewer', password: 'viewerpass1', role: 'viewer' })).status, 200);
    assert.equal((await s.admin.post('/api/users', { username: 's1', name: 'Sales', password: 'salespass1', role: 'sales' })).status, 200);
    assert.equal((await s.admin.post('/api/users', { username: 'x', name: 'X', password: 'short', role: 'viewer' })).status, 400);
    const viewer = s.client(); await viewer.post('/api/login', { username: 'v1', password: 'viewerpass1' });
    assert.equal((await viewer.get('/api/customers')).status, 200);
    assert.equal((await viewer.post('/api/customers', { name: 'A' })).status, 403);
    const sales = s.client(); await sales.post('/api/login', { username: 's1', password: 'salespass1' });
    assert.equal((await sales.post('/api/customers', { name: 'A' })).status, 200);
    assert.equal((await sales.get('/api/users')).status, 403);
  } finally { s.close(); }
});

test('invoice lifecycle: draft -> issue (gapless number, locked) -> partial -> paid; overpay blocked', async () => {
  const s = await start();
  try {
    const a = s.admin;
    const cid = (await a.post('/api/customers', { name: 'شركة النور', phone: '0100' })).body.id;
    const lines = [{ description: 'خدمة', qty: 2, unit_price: 50000, tax_rate: 14 }];
    const bad = await a.post('/api/invoices', { customer_id: cid, date: '2026-11-26', lines: [] });
    assert.equal(bad.status, 400);
    const id = (await a.post('/api/invoices', { customer_id: cid, date: '2026-11-26', lines })).body.id;
    let inv = (await a.get('/api/invoices/' + id)).body;
    assert.equal(inv.status, 'draft'); assert.equal(inv.total, 114000); assert.equal(inv.number, null);
    // edit while draft recomputes totals
    await a.put('/api/invoices/' + id, { customer_id: cid, date: '2026-11-26', lines: [{ description: 'خدمة', qty: 1, unit_price: 100000, tax_rate: 0 }] });
    assert.equal((await a.get('/api/invoices/' + id)).body.total, 100000);
    assert.equal((await a.post(`/api/invoices/${id}/payments`, { date: '2026-11-26', amount: 1 })).status, 409); // not issued yet
    const n1 = (await a.post(`/api/invoices/${id}/issue`)).body.number;
    assert.equal(n1, 'INV-000001');
    assert.equal((await a.put('/api/invoices/' + id, { customer_id: cid, date: '2026-11-26', lines })).status, 409); // locked
    assert.equal((await a.del('/api/invoices/' + id)).status, 409);
    assert.equal((await a.post(`/api/invoices/${id}/issue`)).status, 409);
    let r = await a.post(`/api/invoices/${id}/payments`, { date: '2026-11-27', amount: 40000, method: 'bank' });
    assert.equal(r.body.status, 'partial');
    assert.equal((await a.post(`/api/invoices/${id}/payments`, { date: '2026-11-27', amount: 60001 })).status, 400);
    assert.equal((await a.get('/api/customers')).body.items[0].balance, 60000);
    assert.equal((await a.get('/api/reports/receivables')).body.items[0].due, 60000);
    r = await a.post(`/api/invoices/${id}/payments`, { date: '2026-11-28', amount: 60000 });
    assert.equal(r.body.status, 'paid');
    assert.equal((await a.post(`/api/invoices/${id}/void`)).status, 409); // paid invoices cannot be voided
    // second invoice gets next number; void works on issued-unpaid
    const id2 = (await a.post('/api/invoices', { customer_id: cid, date: '2026-11-28', lines })).body.id;
    assert.equal((await a.post(`/api/invoices/${id2}/issue`)).body.number, 'INV-000002');
    assert.equal((await a.post(`/api/invoices/${id2}/void`)).status, 200);
    assert.equal((await a.get('/api/invoices/' + id2)).body.status, 'void');
    assert.ok((await a.get('/api/audit')).body.items.some(x => x.action === 'issue'));
  } finally { s.close(); }
});

test('validation: bad dates, negative qty, unknown customer, duplicate sku', async () => {
  const s = await start();
  try {
    const a = s.admin;
    const cid = (await a.post('/api/customers', { name: 'C' })).body.id;
    const ln = [{ description: 'x', qty: 1, unit_price: 100 }];
    assert.equal((await a.post('/api/invoices', { customer_id: cid, date: 'nope', lines: ln })).status, 400);
    assert.equal((await a.post('/api/invoices', { customer_id: cid, date: '2026-01-01', lines: [{ description: 'x', qty: -1, unit_price: 100 }] })).status, 400);
    assert.equal((await a.post('/api/invoices', { customer_id: 999, date: '2026-01-01', lines: ln })).status, 400);
    assert.equal((await a.post('/api/products', { sku: 'A1', name_ar: 'صنف', price: 100 })).status, 200);
    assert.equal((await a.post('/api/products', { sku: 'A1', name_ar: 'صنف', price: 100 })).status, 409);
  } finally { s.close(); }
});
