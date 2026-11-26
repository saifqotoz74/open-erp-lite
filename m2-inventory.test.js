'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

async function setup(s) {
  const a = s.admin;
  const cid = (await a.post('/api/customers', { name: 'عميل' })).body.id;
  const pid = (await a.post('/api/products', { sku: 'P1', name_ar: 'صنف', price: 1000, tax_rate: 0, reorder_level: 5 })).body.id;
  const sid = (await a.post('/api/products', { sku: 'S1', name_ar: 'خدمة', price: 1000, track_stock: 0 })).body.id;
  const wh = (await a.get('/api/warehouses')).body.items[0].id;
  return { a, cid, pid, sid, wh };
}
const inv = (a, cid, lines) => a.post('/api/invoices', { customer_id: cid, date: '2026-11-26', lines }).then(r => r.body.id);
const level = async (a, pid) => (await a.get('/api/stock')).body.items.find(i => i.id === pid);

test('receive, adjust, and stock levels derive from movements', async () => {
  const s = await start();
  try {
    const { a, pid, wh } = await setup(s);
    assert.equal((await a.get('/api/warehouses')).body.items[0].name, 'Main'); // default warehouse seeded
    assert.equal((await level(a, pid)).total, 0);
    assert.equal((await a.post('/api/stock/receive', { product_id: pid, warehouse_id: wh, qty: 10 })).body.on_hand, 10);
    assert.equal((await a.post('/api/stock/receive', { product_id: pid, warehouse_id: wh, qty: -1 })).status, 400);
    assert.equal((await a.post('/api/stock/adjust', { product_id: pid, warehouse_id: wh, qty: -3 })).status, 400); // note required
    assert.equal((await a.post('/api/stock/adjust', { product_id: pid, warehouse_id: wh, qty: -3, note: 'damaged' })).body.on_hand, 7);
    assert.equal((await a.post('/api/stock/adjust', { product_id: pid, warehouse_id: wh, qty: -8, note: 'count' })).status, 409); // cannot go negative
    const l = await level(a, pid);
    assert.equal(l.total, 7); assert.equal(l.low, false);
    assert.equal((await a.get('/api/stock/moves')).body.items.length, 2);
  } finally { s.close(); }
});

test('transfer moves stock between warehouses and cannot overdraw', async () => {
  const s = await start();
  try {
    const { a, pid, wh } = await setup(s);
    const wh2 = (await a.post('/api/warehouses', { name: 'Branch' })).body.id;
    assert.equal((await a.post('/api/warehouses', { name: 'Branch' })).status, 409);
    await a.post('/api/stock/receive', { product_id: pid, warehouse_id: wh, qty: 10 });
    const r = await a.post('/api/stock/transfer', { product_id: pid, from_warehouse_id: wh, to_warehouse_id: wh2, qty: 4 });
    assert.deepEqual(r.body, { from: 6, to: 4 });
    assert.equal((await a.post('/api/stock/transfer', { product_id: pid, from_warehouse_id: wh, to_warehouse_id: wh2, qty: 7 })).status, 409);
    assert.equal((await a.post('/api/stock/transfer', { product_id: pid, from_warehouse_id: wh, to_warehouse_id: wh, qty: 1 })).status, 400);
    const l = await level(a, pid); assert.equal(l.total, 10); assert.equal(l.by_warehouse[wh2], 4);
  } finally { s.close(); }
});

test('issuing an invoice deducts stock; insufficient stock blocks it atomically; void returns stock', async () => {
  const s = await start();
  try {
    const { a, cid, pid, sid, wh } = await setup(s);
    await a.post('/api/stock/receive', { product_id: pid, warehouse_id: wh, qty: 5 });
    // too many: issue fails, invoice stays draft, no number consumed, no stock moved
    const big = await inv(a, cid, [{ product_id: pid, description: 'x', qty: 6, unit_price: 1000 }]);
    assert.equal((await a.post(`/api/invoices/${big}/issue`)).status, 409);
    assert.equal((await a.get('/api/invoices/' + big)).body.status, 'draft');
    assert.equal((await level(a, pid)).total, 5);
    // two lines of the same product are summed; service items are ignored
    const ok = await inv(a, cid, [{ product_id: pid, description: 'x', qty: 2, unit_price: 1000 }, { product_id: pid, description: 'y', qty: 2, unit_price: 1000 }, { product_id: sid, description: 'svc', qty: 99, unit_price: 1000 }]);
    const r = await a.post(`/api/invoices/${ok}/issue`);
    assert.equal(r.body.number, 'INV-000001'); // the failed attempt did not burn a number
    let l = await level(a, pid); assert.equal(l.total, 1); assert.equal(l.low, true);
    assert.equal((await a.post(`/api/invoices/${big}/issue`)).status, 409); // still not enough
    await a.post(`/api/invoices/${ok}/void`);
    l = await level(a, pid); assert.equal(l.total, 5);
    const types = (await a.get('/api/stock/moves?product_id=' + pid)).body.items.map(m => m.type);
    assert.ok(types.includes('sale') && types.includes('void_return'));
  } finally { s.close(); }
});

test('warehouse role can manage stock but not invoices; sales can only read stock', async () => {
  const s = await start();
  try {
    const { a, pid, wh } = await setup(s);
    await a.post('/api/users', { username: 'w1', name: 'W', password: 'warehouse1', role: 'warehouse' });
    await a.post('/api/users', { username: 's1', name: 'S', password: 'salespass1', role: 'sales' });
    const w = s.client(); await w.post('/api/login', { username: 'w1', password: 'warehouse1' });
    const sl = s.client(); await sl.post('/api/login', { username: 's1', password: 'salespass1' });
    assert.equal((await w.post('/api/stock/receive', { product_id: pid, warehouse_id: wh, qty: 3 })).status, 200);
    assert.equal((await w.post('/api/invoices', { customer_id: 1, date: '2026-01-01', lines: [] })).status, 403);
    assert.equal((await sl.get('/api/stock')).status, 200);
    assert.equal((await sl.post('/api/stock/receive', { product_id: pid, warehouse_id: wh, qty: 3 })).status, 403);
  } finally { s.close(); }
});
