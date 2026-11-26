'use strict';
const { HttpError, v } = require('./http');
const { tx, nextCounter, audit } = require('./db');

// All money is integer minor units. Totals are always computed on the server from the lines.
function computeTotals(lines) {
  let subtotal = 0, tax = 0;
  for (const l of lines) {
    const net = Math.round(l.qty * l.unit_price);
    subtotal += net;
    tax += Math.round(net * l.tax_rate / 100);
  }
  return { subtotal, tax, total: subtotal + tax };
}
function cleanLines(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, 'lines_required');
  if (raw.length > 200) throw new HttpError(400, 'too_many_lines');
  return raw.map(l => ({
    product_id: l.product_id == null ? null : v.int(l.product_id, 'product_id', { min: 1 }),
    description: v.str(l.description, 'description'),
    qty: v.num(l.qty, 'qty', { min: 0.001 }),
    unit_price: v.int(l.unit_price, 'unit_price'),
    tax_rate: v.num(l.tax_rate ?? 0, 'tax_rate'),
  }));
}

module.exports = function invoices(app) {
  const db = app.db;
  const hooks = app.invoiceHooks = { onIssue: [], onVoid: [] }; // later modules (inventory) plug in here
  const get = id => {
    const inv = db.prepare('SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=?').get(id);
    if (!inv) throw new HttpError(404, 'not_found');
    inv.lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY id').all(id);
    inv.payments = db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY id').all(id);
    return inv;
  };
  function writeLines(id, lines) {
    db.prepare('DELETE FROM invoice_lines WHERE invoice_id=?').run(id);
    const ins = db.prepare('INSERT INTO invoice_lines(invoice_id,product_id,description,qty,unit_price,tax_rate) VALUES(?,?,?,?,?,?)');
    for (const l of lines) ins.run(id, l.product_id, l.description, l.qty, l.unit_price, l.tax_rate);
    const t = computeTotals(lines);
    db.prepare('UPDATE invoices SET subtotal=?,tax=?,total=? WHERE id=?').run(t.subtotal, t.tax, t.total, id);
  }
  const checkCustomer = id => { if (!db.prepare('SELECT 1 FROM customers WHERE id=? AND active=1').get(v.int(id, 'customer_id', { min: 1 }))) throw new HttpError(400, 'customer_invalid'); };

  app.route('GET', '/api/invoices', 'invoices:read', ctx => {
    const where = [], args = [];
    if (ctx.query.status) { where.push('i.status=?'); args.push(ctx.query.status); }
    if (ctx.query.customer_id) { where.push('i.customer_id=?'); args.push(Number(ctx.query.customer_id)); }
    return { items: db.prepare(`SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id DESC LIMIT 500`).all(...args) };
  });
  app.route('GET', '/api/invoices/:id', 'invoices:read', ctx => get(Number(ctx.params.id)));
  // shared by the API and by other modules (sales orders create draft invoices through this)
  app.createInvoice = (b, user) => {
    checkCustomer(b.customer_id);
    const lines = cleanLines(b.lines);
    const r = db.prepare('INSERT INTO invoices(customer_id,date,due_date,notes,created_by) VALUES(?,?,?,?,?)')
      .run(b.customer_id, v.date(b.date, 'date'), b.due_date ? v.date(b.due_date, 'due_date') : null, v.str(b.notes, 'notes', { req: false, max: 1000 }), user.username);
    const id = Number(r.lastInsertRowid);
    writeLines(id, lines);
    audit(db, user.username, 'create', 'invoice', id);
    return id;
  };
  app.route('POST', '/api/invoices', 'invoices:write', ctx => tx(db, () => ({ id: app.createInvoice(ctx.body, ctx.user) })));
  app.route('PUT', '/api/invoices/:id', 'invoices:write', ctx => tx(db, () => {
    const id = Number(ctx.params.id), cur = get(id), b = ctx.body;
    if (cur.status !== 'draft') throw new HttpError(409, 'not_draft');
    checkCustomer(b.customer_id);
    const lines = cleanLines(b.lines);
    db.prepare('UPDATE invoices SET customer_id=?,date=?,due_date=?,notes=? WHERE id=?')
      .run(b.customer_id, v.date(b.date, 'date'), b.due_date ? v.date(b.due_date, 'due_date') : null, v.str(b.notes, 'notes', { req: false, max: 1000 }), id);
    writeLines(id, lines);
    audit(db, ctx.user.username, 'update', 'invoice', id);
    return { ok: true };
  }));
  app.route('DELETE', '/api/invoices/:id', 'invoices:write', ctx => tx(db, () => {
    const id = Number(ctx.params.id);
    if (get(id).status !== 'draft') throw new HttpError(409, 'not_draft'); // issued invoices are voided, never deleted
    db.prepare('DELETE FROM invoices WHERE id=?').run(id);
    audit(db, ctx.user.username, 'delete', 'invoice', id);
    return { ok: true };
  }));
  // draft -> issued: assigns a gapless number and locks the lines
  app.route('POST', '/api/invoices/:id/issue', 'invoices:write', ctx => tx(db, () => {
    const id = Number(ctx.params.id), inv = get(id);
    if (inv.status !== 'draft') throw new HttpError(409, 'not_draft');
    const number = 'INV-' + String(nextCounter(db, 'invoice_seq')).padStart(6, '0');
    for (const h of hooks.onIssue) h(inv, ctx.user); // may throw (e.g. insufficient stock) -> whole issue rolls back
    db.prepare("UPDATE invoices SET status='issued', number=? WHERE id=?").run(number, id);
    audit(db, ctx.user.username, 'issue', 'invoice', id, { number });
    return { number };
  }));
  app.route('POST', '/api/invoices/:id/payments', 'invoices:write', ctx => tx(db, () => {
    const id = Number(ctx.params.id), inv = get(id), b = ctx.body;
    if (!['issued', 'partial'].includes(inv.status)) throw new HttpError(409, 'not_payable');
    const amount = v.int(b.amount, 'amount', { min: 1 });
    if (amount > inv.total - inv.paid) throw new HttpError(400, 'overpayment');
    db.prepare('INSERT INTO payments(invoice_id,date,amount,method,ref,created_by) VALUES(?,?,?,?,?,?)')
      .run(id, v.date(b.date, 'date'), amount, ['cash', 'bank', 'card', 'wallet'].includes(b.method) ? b.method : 'cash', v.str(b.ref, 'ref', { req: false, max: 80 }), ctx.user.username);
    const paid = inv.paid + amount;
    db.prepare('UPDATE invoices SET paid=?, status=? WHERE id=?').run(paid, paid === inv.total ? 'paid' : 'partial', id);
    audit(db, ctx.user.username, 'payment', 'invoice', id, { amount });
    return { paid, status: paid === inv.total ? 'paid' : 'partial' };
  }));
  app.route('POST', '/api/invoices/:id/void', 'invoices:write', ctx => tx(db, () => {
    const id = Number(ctx.params.id), inv = get(id);
    if (!['issued'].includes(inv.status)) throw new HttpError(409, 'cannot_void'); // must have no payments
    for (const h of hooks.onVoid) h(inv, ctx.user);
    db.prepare("UPDATE invoices SET status='void' WHERE id=?").run(id);
    audit(db, ctx.user.username, 'void', 'invoice', id);
    return { ok: true };
  }));
  app.route('GET', '/api/reports/receivables', 'reports:read', () => ({
    items: db.prepare(`SELECT c.id, c.name, SUM(i.total-i.paid) AS due, COUNT(*) AS invoices FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.status IN ('issued','partial') GROUP BY c.id ORDER BY due DESC`).all(),
  }));
};
module.exports.computeTotals = computeTotals;
module.exports.cleanLines = cleanLines;
