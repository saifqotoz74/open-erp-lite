'use strict';
const { HttpError, v } = require('./http');
const { audit } = require('./db');

module.exports = function customers(app) {
  const db = app.db;
  const clean = b => [v.str(b.name, 'name'), v.str(b.phone, 'phone', { req: false, max: 40 }), v.str(b.email, 'email', { req: false }), v.str(b.address, 'address', { req: false, max: 400 }), v.str(b.tax_no, 'tax_no', { req: false, max: 40 })];
  app.route('GET', '/api/customers', 'customers:read', ctx => {
    const q = '%' + (ctx.query.q || '') + '%';
    return { items: db.prepare(`SELECT c.*, COALESCE((SELECT SUM(total-paid) FROM invoices WHERE customer_id=c.id AND status IN ('issued','partial')),0) AS balance
      FROM customers c WHERE c.active=1 AND (c.name LIKE ? OR c.phone LIKE ?) ORDER BY c.name LIMIT 500`).all(q, q) };
  });
  app.route('POST', '/api/customers', 'customers:write', ctx => {
    const r = db.prepare('INSERT INTO customers(name,phone,email,address,tax_no) VALUES(?,?,?,?,?)').run(...clean(ctx.body));
    audit(db, ctx.user.username, 'create', 'customer', Number(r.lastInsertRowid));
    return { id: Number(r.lastInsertRowid) };
  });
  app.route('PUT', '/api/customers/:id', 'customers:write', ctx => {
    const r = db.prepare('UPDATE customers SET name=?,phone=?,email=?,address=?,tax_no=? WHERE id=? AND active=1').run(...clean(ctx.body), Number(ctx.params.id));
    if (!r.changes) throw new HttpError(404, 'not_found');
    audit(db, ctx.user.username, 'update', 'customer', Number(ctx.params.id));
    return { ok: true };
  });
  app.route('DELETE', '/api/customers/:id', 'customers:write', ctx => {
    const id = Number(ctx.params.id);
    // soft delete so old invoices keep their customer
    const r = db.prepare('UPDATE customers SET active=0 WHERE id=?').run(id);
    if (!r.changes) throw new HttpError(404, 'not_found');
    audit(db, ctx.user.username, 'delete', 'customer', id);
    return { ok: true };
  });
};
