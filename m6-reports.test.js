'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

async function seed(a) {
  const c1 = (await a.post('/api/customers', { name: 'Alpha' })).body.id;
  const c2 = (await a.post('/api/customers', { name: '=HYPERLINK("http://evil")' })).body.id; // hostile name, must be neutralised in CSV
  const p = (await a.post('/api/products', { sku: 'P1', name_ar: 'صنف', price: 10000, cost: 4000, tax_rate: 10 })).body.id;
  await a.post('/api/stock/receive', { product_id: p, warehouse_id: 1, qty: 50 });
  const mk = async (cid, date, due, qty) => {
    const id = (await a.post('/api/invoices', { customer_id: cid, date, due_date: due, lines: [{ product_id: p, description: 'صنف', qty, unit_price: 10000, tax_rate: 10 }] })).body.id;
    await a.post(`/api/invoices/${id}/issue`); return id;
  };
  const i1 = await mk(c1, '2026-01-10', '2026-02-09', 1); // total 11000
  const i2 = await mk(c2, '2026-01-20', '2026-03-01', 2); // total 22000
  const i3 = await mk(c1, '2026-02-05', '2026-03-05', 3); // total 33000
  const draft = (await a.post('/api/invoices', { customer_id: c1, date: '2026-02-06', lines: [{ description: 'x', qty: 1, unit_price: 99900, tax_rate: 0 }] })).body.id; // draft: must not count
  const voided = await mk(c1, '2026-02-07', null, 1); await a.post(`/api/invoices/${voided}/void`);
  await a.post(`/api/invoices/${i1}/payments`, { date: '2026-02-01', amount: 1000 });
  return { i1, i2, i3, draft };
}

test('sales report counts only issued invoices, by month, with top customers and products', async () => {
  const s = await start();
  try {
    const a = s.admin; await seed(a);
    const r = (await a.get('/api/reports/sales?from=2026-01-01&to=2026-12-31')).body;
    assert.deepEqual(r.months.map(m => [m.month, m.invoices, m.subtotal, m.tax, m.total]), [['2026-01', 2, 30000, 3000, 33000], ['2026-02', 1, 30000, 3000, 33000]]);
    assert.deepEqual(r.totals, { invoices: 3, subtotal: 60000, tax: 6000, total: 66000 });
    assert.equal(r.customers[0].name, 'Alpha'); assert.equal(r.customers[0].total, 44000);
    assert.equal(r.products[0].qty, 6); assert.equal(r.products[0].revenue, 60000);
    assert.equal((await a.get('/api/reports/sales?from=2026-02-01&to=2026-02-28')).body.totals.total, 33000);
    assert.equal((await a.get('/api/reports/sales?from=2026-03-01&to=2026-01-01')).status, 400);
  } finally { s.close(); }
});

test('aging buckets use due date and the as_of date; payments reduce the balance', async () => {
  const s = await start();
  try {
    const a = s.admin; await seed(a);
    // as of 2026-04-10: i1 due 02-09 = 60 days over (bal 10000), i2 due 03-01 = 40 days (22000), i3 due 03-05 = 36 days (33000)
    const r = (await a.get('/api/reports/aging?as_of=2026-04-10')).body;
    assert.deepEqual(r.buckets, { current: 0, d1_30: 0, d31_60: 10000 + 22000 + 33000, d61_90: 0, d90_plus: 0 });
    const r2 = (await a.get('/api/reports/aging?as_of=2026-06-01')).body; // i1 112 days, i2 92, i3 88
    assert.deepEqual(r2.buckets, { current: 0, d1_30: 0, d31_60: 0, d61_90: 33000, d90_plus: 32000 });
    const r3 = (await a.get('/api/reports/aging?as_of=2026-02-20')).body; // i2 and i3 not yet due
    assert.equal(r3.buckets.current, 55000); assert.equal(r3.buckets.d1_30, 10000);
    assert.equal(r.total, 65000);
  } finally { s.close(); }
});

test('stock value = quantity x cost; payroll report shows finalized runs only', async () => {
  const s = await start();
  try {
    const a = s.admin; await seed(a);
    const sv = (await a.get('/api/reports/stock-value')).body; // received 50, sold 1+2+3 = 6 (void returned 1) => 44
    assert.equal(sv.items[0].qty, 44); assert.equal(sv.total, 44 * 4000);
    await a.post('/api/employees', { code: 'E1', name: 'X', hire_date: '2026-01-01', base_salary: 300000, allowance: 0 });
    await a.post('/api/payroll/run', { month: '2026-03' }); await a.post('/api/payroll/run', { month: '2026-04' });
    await a.post('/api/payroll/2026-03/finalize');
    const pr = (await a.get('/api/reports/payroll')).body.items;
    assert.equal(pr.length, 1); assert.equal(pr[0].month, '2026-03'); assert.equal(pr[0].net, 300000);
  } finally { s.close(); }
});

test('CSV export: header, BOM, quoting, and formula injection neutralised', async () => {
  const s = await start();
  try {
    const a = s.admin; await seed(a);
    const res = await fetch(s.base + '/api/reports/aging?as_of=2026-04-10&format=csv', { headers: { cookie: (await (async () => { const r = await fetch(s.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'AdminPass123' }) }); return r.headers.get('set-cookie').split(';')[0]; })()) } });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/csv/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]); // UTF-8 BOM so Excel shows Arabic correctly
    const text = buf.toString('utf8').slice(1);
    assert.ok(text.startsWith('invoice,customer,due,days_over,bucket,balance'));
    assert.ok(text.includes('"\'=HYPERLINK(""http://evil"")"')); // quoted, quotes doubled, formula prefixed with an apostrophe
    assert.ok(!/(^|,)=HYPERLINK/m.test(text));
  } finally { s.close(); }
});

test('permissions: sales role cannot read reports; accountant can but not payroll; hr can read payroll report only', async () => {
  const s = await start();
  try {
    const a = s.admin;
    for (const [u, r] of [['sl1', 'sales'], ['ac1', 'accountant'], ['h1', 'hr']]) await a.post('/api/users', { username: u, name: u, password: 'password-' + u, role: r });
    const login = async u => { const c = s.client(); await c.post('/api/login', { username: u, password: 'password-' + u }); return c; };
    assert.equal((await (await login('sl1')).get('/api/reports/sales')).status, 403);
    const ac = await login('ac1');
    assert.equal((await ac.get('/api/reports/sales')).status, 200); assert.equal((await ac.get('/api/reports/aging')).status, 200); assert.equal((await ac.get('/api/reports/payroll')).status, 403);
    const h = await login('h1');
    assert.equal((await h.get('/api/reports/payroll')).status, 200); assert.equal((await h.get('/api/reports/sales')).status, 403);
  } finally { s.close(); }
});
