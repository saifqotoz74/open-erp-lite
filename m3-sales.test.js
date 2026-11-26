'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

const lines = pid => [{ product_id: pid, description: 'صنف', qty: 3, unit_price: 10000, tax_rate: 14 }];
async function setup(s) {
  const a = s.admin;
  const cid = (await a.post('/api/customers', { name: 'عميل' })).body.id;
  const pid = (await a.post('/api/products', { sku: 'P1', name_ar: 'صنف', price: 10000, tax_rate: 14 })).body.id;
  return { a, cid, pid };
}

test('quote -> accepted -> order -> draft invoice -> issue deducts stock', async () => {
  const s = await start();
  try {
    const { a, cid, pid } = await setup(s);
    await a.post('/api/stock/receive', { product_id: pid, warehouse_id: 1, qty: 10 });
    const qid = (await a.post('/api/sales', { kind: 'quote', customer_id: cid, date: '2026-11-26', lines: lines(pid) })).body.id;
    let q = (await a.get('/api/sales/' + qid)).body;
    assert.equal(q.number, 'QT-000001'); assert.equal(q.status, 'draft'); assert.equal(q.total, 34200);
    assert.equal((await a.post(`/api/sales/${qid}/to-order`)).status, 409); // not accepted yet
    assert.equal((await a.post(`/api/sales/${qid}/status`, { status: 'accepted' })).status, 409); // must be sent first
    assert.equal((await a.post(`/api/sales/${qid}/status`, { status: 'sent' })).status, 200);
    assert.equal((await a.put('/api/sales/' + qid, { customer_id: cid, date: '2026-11-26', lines: lines(pid) })).status, 409); // sent quotes are locked
    assert.equal((await a.del('/api/sales/' + qid)).status, 409);
    assert.equal((await a.post(`/api/sales/${qid}/status`, { status: 'accepted' })).status, 200);
    const o = (await a.post(`/api/sales/${qid}/to-order`)).body;
    assert.equal(o.number, 'SO-000001');
    assert.equal((await a.post(`/api/sales/${qid}/to-order`)).status, 409); // no double conversion
    assert.equal((await a.get('/api/sales/' + qid)).body.status, 'converted');
    const order = (await a.get('/api/sales/' + o.id)).body;
    assert.equal(order.total, 34200); assert.equal(order.from_quote_id, qid); assert.equal(order.lines.length, 1);
    const { invoice_id } = (await a.post(`/api/sales/${o.id}/to-invoice`)).body;
    assert.equal((await a.post(`/api/sales/${o.id}/to-invoice`)).status, 409); // no double invoicing
    const inv = (await a.get('/api/invoices/' + invoice_id)).body;
    assert.equal(inv.status, 'draft'); assert.equal(inv.total, 34200);
    assert.equal((await a.get('/api/stock')).body.items[0].total, 10); // nothing deducted yet
    await a.post(`/api/invoices/${invoice_id}/issue`);
    assert.equal((await a.get('/api/stock')).body.items[0].total, 7);
    assert.equal((await a.get('/api/sales/' + o.id)).body.status, 'invoiced');
    assert.equal((await a.get('/api/sales?kind=order')).body.items.length, 1);
  } finally { s.close(); }
});

test('rejected quotes stay rejected; draft quotes can be edited and deleted; open orders can be cancelled', async () => {
  const s = await start();
  try {
    const { a, cid, pid } = await setup(s);
    const q1 = (await a.post('/api/sales', { kind: 'quote', customer_id: cid, date: '2026-11-26', lines: lines(pid) })).body.id;
    assert.equal((await a.put('/api/sales/' + q1, { customer_id: cid, date: '2026-11-27', lines: [{ description: 'x', qty: 1, unit_price: 500, tax_rate: 0 }] })).status, 200);
    assert.equal((await a.get('/api/sales/' + q1)).body.total, 500);
    assert.equal((await a.del('/api/sales/' + q1)).status, 200);
    const q2 = (await a.post('/api/sales', { kind: 'quote', customer_id: cid, date: '2026-11-26', lines: lines(pid) })).body.id;
    await a.post(`/api/sales/${q2}/status`, { status: 'sent' });
    await a.post(`/api/sales/${q2}/status`, { status: 'rejected' });
    assert.equal((await a.post(`/api/sales/${q2}/status`, { status: 'accepted' })).status, 409);
    assert.equal((await a.post(`/api/sales/${q2}/to-order`)).status, 409);
    const o = (await a.post('/api/sales', { kind: 'order', customer_id: cid, date: '2026-11-26', lines: lines(pid) })).body.id; // direct order
    assert.equal((await a.post(`/api/sales/${o}/cancel`)).status, 200);
    assert.equal((await a.post(`/api/sales/${o}/to-invoice`)).status, 409);
    assert.equal((await a.post('/api/sales', { kind: 'quote', customer_id: cid, date: '2026-11-26', lines: [] })).status, 400);
  } finally { s.close(); }
});

test('permissions: viewer reads only; sales role converts orders to invoices; warehouse has no sales access', async () => {
  const s = await start();
  try {
    const { a, cid, pid } = await setup(s);
    await a.post('/api/users', { username: 'v1', name: 'V', password: 'viewerpass1', role: 'viewer' });
    await a.post('/api/users', { username: 'w1', name: 'W', password: 'warehouse1', role: 'warehouse' });
    const v = s.client(); await v.post('/api/login', { username: 'v1', password: 'viewerpass1' });
    const w = s.client(); await w.post('/api/login', { username: 'w1', password: 'warehouse1' });
    const oid = (await a.post('/api/sales', { kind: 'order', customer_id: cid, date: '2026-11-26', lines: lines(pid) })).body.id;
    assert.equal((await v.get('/api/sales?kind=order')).status, 200);
    assert.equal((await v.post('/api/sales', { kind: 'quote', customer_id: cid, date: '2026-11-26', lines: lines(pid) })).status, 403);
    assert.equal((await w.get('/api/sales?kind=order')).status, 403);
    assert.equal((await v.post(`/api/sales/${oid}/to-invoice`)).status, 403);
  } finally { s.close(); }
});
