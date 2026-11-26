'use strict';
const { HttpError, v } = require('./http');
const { tx, audit, getSetting } = require('./db');

const DAY = 86400000;
const toDay = s => Date.parse(s + 'T00:00:00Z');
const fmtDay = ms => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toDay(b) - toDay(a)) / DAY) + 1; // inclusive, calendar days
const monthOf = s => { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s || '')) throw new HttpError(400, 'month_invalid'); return s; };
const monthRange = m => { const [y, mo] = m.split('-').map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return [`${m}-01`, `${m}-${String(last).padStart(2, '0')}`, last]; };

module.exports = function hr(app) {
  const db = app.db;
  const annualAllowance = () => Number(getSetting(db, 'annual_leave_days', '21'));
  const insurancePct = () => Number(getSetting(db, 'insurance_pct', '0'));
  const emp = id => { const e = db.prepare('SELECT * FROM employees WHERE id=?').get(id); if (!e) throw new HttpError(404, 'employee_not_found'); return e; };

  // ---- employees ----
  const clean = b => [v.str(b.code, 'code', { max: 30 }), v.str(b.name, 'name'), v.str(b.job_title, 'job_title', { req: false }), v.str(b.department, 'department', { req: false }), v.str(b.phone, 'phone', { req: false, max: 40 }),
    v.date(b.hire_date, 'hire_date'), v.int(b.base_salary ?? 0, 'base_salary'), v.int(b.allowance ?? 0, 'allowance')];
  const dupe = e => { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'code_taken'); throw e; };
  app.route('GET', '/api/employees', 'hr:read', ctx => {
    const q = '%' + (ctx.query.q || '') + '%';
    return { items: db.prepare("SELECT * FROM employees WHERE (name LIKE ? OR code LIKE ?) ORDER BY status, name LIMIT 500").all(q, q) };
  });
  app.route('POST', '/api/employees', 'hr:write', ctx => {
    try {
      const r = db.prepare('INSERT INTO employees(code,name,job_title,department,phone,hire_date,base_salary,allowance) VALUES(?,?,?,?,?,?,?,?)').run(...clean(ctx.body));
      audit(db, ctx.user.username, 'create', 'employee', Number(r.lastInsertRowid));
      return { id: Number(r.lastInsertRowid) };
    } catch (e) { dupe(e); }
  });
  app.route('PUT', '/api/employees/:id', 'hr:write', ctx => {
    try {
      const r = db.prepare("UPDATE employees SET code=?,name=?,job_title=?,department=?,phone=?,hire_date=?,base_salary=?,allowance=? WHERE id=?").run(...clean(ctx.body), Number(ctx.params.id));
      if (!r.changes) throw new HttpError(404, 'employee_not_found');
      audit(db, ctx.user.username, 'update', 'employee', Number(ctx.params.id));
      return { ok: true };
    } catch (e) { if (e instanceof HttpError) throw e; dupe(e); }
  });
  // employees are never deleted (payroll history refers to them); they are terminated with an end date
  app.route('POST', '/api/employees/:id/terminate', 'hr:write', ctx => {
    const e = emp(Number(ctx.params.id));
    if (e.status !== 'active') throw new HttpError(409, 'not_active');
    const end = v.date(ctx.body.end_date, 'end_date');
    if (end < e.hire_date) throw new HttpError(400, 'end_before_hire');
    db.prepare("UPDATE employees SET status='terminated', end_date=? WHERE id=?").run(end, e.id);
    audit(db, ctx.user.username, 'terminate', 'employee', e.id, { end });
    return { ok: true };
  });

  // ---- attendance (one row per employee per day, re-posting corrects it) ----
  app.route('POST', '/api/attendance', 'hr:write', ctx => {
    const b = ctx.body, e = emp(v.int(b.employee_id, 'employee_id', { min: 1 }));
    const date = v.date(b.date, 'date');
    if (!['present', 'absent', 'late', 'leave'].includes(b.status)) throw new HttpError(400, 'status_invalid');
    if (date < e.hire_date || (e.end_date && date > e.end_date)) throw new HttpError(400, 'outside_employment');
    const t = x => { if (x == null || x === '') return null; if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw new HttpError(400, 'time_invalid'); return x; };
    const ci = t(b.check_in), co = t(b.check_out);
    if (ci && co && co <= ci) throw new HttpError(400, 'time_invalid');
    db.prepare(`INSERT INTO attendance(employee_id,date,status,check_in,check_out) VALUES(?,?,?,?,?)
      ON CONFLICT(employee_id,date) DO UPDATE SET status=excluded.status, check_in=excluded.check_in, check_out=excluded.check_out`).run(e.id, date, b.status, ci, co);
    return { ok: true };
  });
  app.route('GET', '/api/attendance', 'hr:read', ctx => {
    const [from, to] = monthRange(monthOf(ctx.query.month));
    const where = ['a.date BETWEEN ? AND ?'], args = [from, to];
    if (ctx.query.employee_id) { where.push('a.employee_id=?'); args.push(Number(ctx.query.employee_id)); }
    return { items: db.prepare(`SELECT a.*, e.name, e.code FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE ${where.join(' AND ')} ORDER BY a.date, e.name`).all(...args) };
  });

  // ---- leave ----
  const usedAnnual = (empId, year, statuses, excludeId = 0) => db.prepare(
    `SELECT COALESCE(SUM(days),0) AS d FROM leaves WHERE employee_id=? AND type='annual' AND status IN (${statuses.map(() => '?').join(',')}) AND substr(start_date,1,4)=? AND id<>?`)
    .get(empId, ...statuses, String(year), excludeId).d;
  app.route('GET', '/api/leaves', 'hr:read', ctx => ({ items: db.prepare('SELECT l.*, e.name, e.code FROM leaves l JOIN employees e ON e.id=l.employee_id ORDER BY l.id DESC LIMIT 300').all() }));
  app.route('GET', '/api/leaves/balance/:id', 'hr:read', ctx => {
    const year = Number(ctx.query.year) || new Date().getUTCFullYear(), allowed = annualAllowance();
    const used = usedAnnual(Number(ctx.params.id), year, ['approved']), pending = usedAnnual(Number(ctx.params.id), year, ['pending']);
    return { year, allowed, used, pending, remaining: allowed - used - pending };
  });
  app.route('POST', '/api/leaves', 'hr:write', ctx => tx(db, () => {
    const b = ctx.body, e = emp(v.int(b.employee_id, 'employee_id', { min: 1 }));
    if (e.status !== 'active') throw new HttpError(409, 'not_active');
    if (!['annual', 'sick', 'unpaid'].includes(b.type)) throw new HttpError(400, 'type_invalid');
    const s = v.date(b.start_date, 'start_date'), en = v.date(b.end_date, 'end_date');
    if (en < s) throw new HttpError(400, 'dates_invalid');
    if (s.slice(0, 4) !== en.slice(0, 4)) throw new HttpError(400, 'spans_years'); // split year-crossing requests
    if (s < e.hire_date) throw new HttpError(400, 'outside_employment');
    const days = daysBetween(s, en);
    const clash = db.prepare("SELECT 1 FROM leaves WHERE employee_id=? AND status IN ('pending','approved') AND start_date<=? AND end_date>=?").get(e.id, en, s);
    if (clash) throw new HttpError(409, 'leave_overlap');
    if (b.type === 'annual' && usedAnnual(e.id, s.slice(0, 4), ['approved', 'pending']) + days > annualAllowance()) throw new HttpError(409, 'insufficient_leave_balance');
    const r = db.prepare('INSERT INTO leaves(employee_id,type,start_date,end_date,days,note) VALUES(?,?,?,?,?,?)').run(e.id, b.type, s, en, days, v.str(b.note, 'note', { req: false, max: 300 }));
    audit(db, ctx.user.username, 'create', 'leave', Number(r.lastInsertRowid));
    return { id: Number(r.lastInsertRowid), days };
  }));
  app.route('POST', '/api/leaves/:id/decision', 'hr:write', ctx => tx(db, () => {
    const l = db.prepare('SELECT * FROM leaves WHERE id=?').get(Number(ctx.params.id));
    if (!l) throw new HttpError(404, 'not_found');
    if (l.status !== 'pending') throw new HttpError(409, 'already_decided');
    const to = ctx.body.status;
    if (!['approved', 'rejected'].includes(to)) throw new HttpError(400, 'status_invalid');
    if (to === 'approved') {
      // payroll for that period must not already be final, or the approval would silently not count
      for (let m = l.start_date.slice(0, 7); m <= l.end_date.slice(0, 7); m = fmtDay(Date.UTC(+m.slice(0, 4), +m.slice(5) , 1)).slice(0, 7))
        if (db.prepare("SELECT 1 FROM payroll_runs WHERE month=? AND status='finalized'").get(m)) throw new HttpError(409, 'payroll_finalized');
    }
    db.prepare('UPDATE leaves SET status=?, decided_by=? WHERE id=?').run(to, ctx.user.username, l.id);
    audit(db, ctx.user.username, to, 'leave', l.id);
    return { status: to };
  }));

  // ---- payroll ----
  // net = base + allowance - (base/30 x unpaid days) - insurance% of base.
  // unpaid days = distinct calendar days in the month that are marked absent OR covered by an approved unpaid leave (a day is never counted twice).
  function compute(e, month) {
    const [from, to, last] = monthRange(month);
    const start = e.hire_date > from ? e.hire_date : from, end = e.end_date && e.end_date < to ? e.end_date : to;
    if (start > end) return null;
    const unpaid = new Set(db.prepare("SELECT date FROM attendance WHERE employee_id=? AND status='absent' AND date BETWEEN ? AND ?").all(e.id, start, end).map(r => r.date));
    for (const l of db.prepare("SELECT start_date,end_date FROM leaves WHERE employee_id=? AND type='unpaid' AND status='approved' AND start_date<=? AND end_date>=?").all(e.id, end, start))
      for (let d = toDay(l.start_date > start ? l.start_date : start); d <= toDay(l.end_date < end ? l.end_date : end); d += DAY) unpaid.add(fmtDay(d));
    // partial month (joined or left mid-month): pay only the days employed, on a 30-day basis
    const employedDays = daysBetween(start, end), prorate = employedDays === last ? 1 : Math.min(employedDays, 30) / 30;
    const base = Math.round(e.base_salary * prorate), allowance = Math.round(e.allowance * prorate);
    const deduction = Math.min(base, Math.round(e.base_salary / 30 * unpaid.size));
    const insurance = Math.round(base * insurancePct() / 100);
    return { employee_id: e.id, base, allowance, unpaid_days: unpaid.size, deduction, insurance, net: base + allowance - deduction - insurance };
  }
  app.route('POST', '/api/payroll/run', 'payroll:write', ctx => tx(db, () => {
    const month = monthOf(ctx.body.month);
    let run = db.prepare('SELECT * FROM payroll_runs WHERE month=?').get(month);
    if (run && run.status === 'finalized') throw new HttpError(409, 'payroll_finalized');
    if (!run) { const r = db.prepare('INSERT INTO payroll_runs(month,created_by) VALUES(?,?)').run(month, ctx.user.username); run = { id: Number(r.lastInsertRowid) }; }
    db.prepare('DELETE FROM payroll_items WHERE run_id=?').run(run.id); // a draft is recalculated from scratch
    const ins = db.prepare('INSERT INTO payroll_items(run_id,employee_id,base,allowance,unpaid_days,deduction,insurance,net) VALUES(?,?,?,?,?,?,?,?)');
    let total = 0, n = 0;
    for (const e of db.prepare('SELECT * FROM employees ORDER BY id').all()) {
      const it = compute(e, month); if (!it) continue;
      ins.run(run.id, it.employee_id, it.base, it.allowance, it.unpaid_days, it.deduction, it.insurance, it.net); total += it.net; n++;
    }
    db.prepare('UPDATE payroll_runs SET total_net=? WHERE id=?').run(total, run.id);
    audit(db, ctx.user.username, 'run', 'payroll', run.id, { month, employees: n });
    return { month, employees: n, total_net: total };
  }));
  app.route('GET', '/api/payroll', 'payroll:read', () => ({ items: db.prepare('SELECT * FROM payroll_runs ORDER BY month DESC').all() }));
  app.route('GET', '/api/payroll/:month', 'payroll:read', ctx => {
    const run = db.prepare('SELECT * FROM payroll_runs WHERE month=?').get(monthOf(ctx.params.month));
    if (!run) throw new HttpError(404, 'not_found');
    run.items = db.prepare('SELECT i.*, e.name, e.code FROM payroll_items i JOIN employees e ON e.id=i.employee_id WHERE i.run_id=? ORDER BY e.name').all(run.id);
    return run;
  });
  app.route('POST', '/api/payroll/:month/finalize', 'payroll:write', ctx => tx(db, () => {
    const run = db.prepare('SELECT * FROM payroll_runs WHERE month=?').get(monthOf(ctx.params.month));
    if (!run) throw new HttpError(404, 'not_found');
    if (run.status === 'finalized') throw new HttpError(409, 'payroll_finalized');
    db.prepare("UPDATE payroll_runs SET status='finalized' WHERE id=?").run(run.id);
    audit(db, ctx.user.username, 'finalize', 'payroll', run.id, { month: run.month });
    return { status: 'finalized' };
  }));
};
