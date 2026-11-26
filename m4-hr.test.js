'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

const mk = (a, o = {}) => a.post('/api/employees', { code: 'E1', name: 'أحمد', hire_date: '2026-01-01', base_salary: 300000, allowance: 30000, ...o }).then(r => r.body.id);

test('employees: unique code, terminate with end date, never deleted', async () => {
  const s = await start();
  try {
    const a = s.admin, id = await mk(a);
    assert.equal((await a.post('/api/employees', { code: 'E1', name: 'x', hire_date: '2026-01-01' })).status, 409);
    assert.equal((await a.post('/api/employees', { code: 'E2', name: 'x', hire_date: 'bad' })).status, 400);
    assert.equal((await a.post(`/api/employees/${id}/terminate`, { end_date: '2025-12-01' })).status, 400);
    assert.equal((await a.post(`/api/employees/${id}/terminate`, { end_date: '2026-06-30' })).status, 200);
    assert.equal((await a.post(`/api/employees/${id}/terminate`, { end_date: '2026-06-30' })).status, 409);
    assert.equal((await a.get('/api/employees')).body.items[0].status, 'terminated');
  } finally { s.close(); }
});

test('attendance: one row per day, corrections overwrite, validation', async () => {
  const s = await start();
  try {
    const a = s.admin, id = await mk(a);
    assert.equal((await a.post('/api/attendance', { employee_id: id, date: '2026-03-01', status: 'present', check_in: '09:00', check_out: '17:00' })).status, 200);
    assert.equal((await a.post('/api/attendance', { employee_id: id, date: '2026-03-01', status: 'late', check_in: '09:40', check_out: '17:00' })).status, 200);
    const rows = (await a.get('/api/attendance?month=2026-03')).body.items;
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'late');
    assert.equal((await a.post('/api/attendance', { employee_id: id, date: '2026-03-02', status: 'present', check_in: '17:00', check_out: '09:00' })).status, 400);
    assert.equal((await a.post('/api/attendance', { employee_id: id, date: '2025-12-31', status: 'present' })).status, 400); // before hire
    assert.equal((await a.get('/api/attendance?month=2026-13')).status, 400);
  } finally { s.close(); }
});

test('leave: balance, overlap, approval, no overdraw', async () => {
  const s = await start();
  try {
    const a = s.admin, id = await mk(a);
    const r1 = await a.post('/api/leaves', { employee_id: id, type: 'annual', start_date: '2026-04-01', end_date: '2026-04-10' });
    assert.equal(r1.body.days, 10);
    assert.equal((await a.post('/api/leaves', { employee_id: id, type: 'sick', start_date: '2026-04-10', end_date: '2026-04-11' })).status, 409); // overlaps pending
    assert.equal((await a.post('/api/leaves', { employee_id: id, type: 'annual', start_date: '2026-05-01', end_date: '2026-05-12' })).status, 409); // 10 + 12 > 21
    assert.equal((await a.post('/api/leaves', { employee_id: id, type: 'annual', start_date: '2026-05-01', end_date: '2026-05-11' })).status, 200); // 10 + 11 = 21
    assert.equal((await a.post('/api/leaves', { employee_id: id, type: 'annual', start_date: '2026-12-30', end_date: '2027-01-02' })).status, 400); // crosses year
    assert.equal((await a.post(`/api/leaves/${r1.body.id}/decision`, { status: 'approved' })).status, 200);
    assert.equal((await a.post(`/api/leaves/${r1.body.id}/decision`, { status: 'rejected' })).status, 409);
    const b = (await a.get(`/api/leaves/balance/${id}?year=2026`)).body;
    assert.deepEqual([b.allowed, b.used, b.pending, b.remaining], [21, 10, 11, 0]);
  } finally { s.close(); }
});

test('payroll: absent + unpaid leave deducted once per day, insurance, proration, finalize locks', async () => {
  const s = await start();
  try {
    const a = s.admin;
    await a.put('/api/settings', { company_name: 'X' }); // settings route exists
    s.app.db.prepare("INSERT INTO settings(key,value) VALUES('insurance_pct','10') ON CONFLICT(key) DO UPDATE SET value='10'").run();
    const full = await mk(a);                                   // base 3000.00, allowance 300.00
    const joiner = await mk(a, { code: 'E2', name: 'سارة', hire_date: '2026-03-16', base_salary: 300000, allowance: 0 }); // joins 16 Mar -> 16 of 31 days
    // March 2026: 2 absences + unpaid leave 5-6 Mar (5 Mar also absent: counts once) => unpaid days {2,5,6} = 3
    await a.post('/api/attendance', { employee_id: full, date: '2026-03-02', status: 'absent' });
    await a.post('/api/attendance', { employee_id: full, date: '2026-03-05', status: 'absent' });
    await a.post('/api/attendance', { employee_id: full, date: '2026-03-09', status: 'present' });
    const l = (await a.post('/api/leaves', { employee_id: full, type: 'unpaid', start_date: '2026-03-05', end_date: '2026-03-06' })).body.id;
    await a.post(`/api/leaves/${l}/decision`, { status: 'approved' });
    const run = await a.post('/api/payroll/run', { month: '2026-03' });
    assert.equal(run.status, 200); assert.equal(run.body.employees, 2);
    const items = (await a.get('/api/payroll/2026-03')).body.items;
    const f = items.find(i => i.employee_id === full), j = items.find(i => i.employee_id === joiner);
    assert.equal(f.unpaid_days, 3);
    assert.equal(f.deduction, 10000 * 3);                       // 300000 / 30 = 10000 per day
    assert.equal(f.insurance, 30000);                           // 10% of base
    assert.equal(f.net, 300000 + 30000 - f.deduction - 30000);
    assert.equal(j.base, Math.round(300000 * 16 / 30));         // 16 days employed in March (31 days) on a 30-day basis
    // re-running a draft recalculates, not duplicates
    assert.equal((await a.post('/api/payroll/run', { month: '2026-03' })).body.employees, 2);
    assert.equal((await a.get('/api/payroll')).body.items.length, 1);
    assert.equal((await a.post('/api/payroll/2026-03/finalize')).status, 200);
    assert.equal((await a.post('/api/payroll/run', { month: '2026-03' })).status, 409);
    assert.equal((await a.post('/api/payroll/2026-03/finalize')).status, 409);
    // cannot approve leave into a finalized month
    const l2 = (await a.post('/api/leaves', { employee_id: full, type: 'unpaid', start_date: '2026-03-20', end_date: '2026-03-21' })).body.id;
    assert.equal((await a.post(`/api/leaves/${l2}/decision`, { status: 'approved' })).status, 409);
    // before anyone is employed: empty run
    assert.equal((await a.post('/api/payroll/run', { month: '2025-06' })).body.employees, 0);
  } finally { s.close(); }
});

test('permissions: hr role manages HR and payroll; accountant/sales/warehouse cannot see HR data', async () => {
  const s = await start();
  try {
    const a = s.admin; await mk(a);
    for (const [u, r] of [['h1', 'hr'], ['ac1', 'accountant'], ['sl1', 'sales'], ['wh1', 'warehouse']]) await a.post('/api/users', { username: u, name: u, password: 'password-' + u, role: r });
    const login = async u => { const c = s.client(); await c.post('/api/login', { username: u, password: 'password-' + u }); return c; };
    const h = await login('h1');
    assert.equal((await h.get('/api/employees')).status, 200);
    assert.equal((await h.post('/api/payroll/run', { month: '2026-02' })).status, 200);
    assert.equal((await h.get('/api/customers')).status, 403);
    for (const u of ['ac1', 'sl1', 'wh1']) { const c = await login(u); assert.equal((await c.get('/api/employees')).status, 403, u); assert.equal((await c.get('/api/payroll')).status, 403, u); }
  } finally { s.close(); }
});

test('settings: insurance percent and leave allowance are configurable via API', async () => {
  const s = await start();
  try {
    const a = s.admin;
    await a.put('/api/settings', { insurance_pct: 11, annual_leave_days: 15 });
    const st = (await a.get('/api/settings')).body;
    assert.equal(st.insurance_pct, 11); assert.equal(st.annual_leave_days, 15);
    const id = await mk(a);
    assert.equal((await a.post('/api/leaves', { employee_id: id, type: 'annual', start_date: '2026-04-01', end_date: '2026-04-16' })).status, 409); // 16 > 15
  } finally { s.close(); }
});
