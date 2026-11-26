'use strict';
const { HttpError, v } = require('./http');
const { tx, nextCounter, audit } = require('./db');
const { computeTotals, cleanLines } = require('./invoices');

// Flow: quote (draft -> sent -> accepted | rejected) -> sales order (open) -> draft invoice. Each step is one-way and recorded.
const QUOTE_NEXT = { draft: ['sent'], sent: ['accepted', 'rejected'], accepted: [], rejected: [], converted: [] };

module.exports = function sales(app) {
  const db = app.db;
  const get = id => {
    const d = db.prepare('SELECT d.*, c.name AS customer_name FROM sales_docs d JOIN customers c ON c.id=d.customer_id WHERE d.id=?').get(id);
    if (!d) throw new HttpError(404, 'not_found');
    d.lines = db.prepare('SELECT * FROM sales_lines WHERE doc_id=? ORDER BY id').all(id);
    return d;
  };
  function writeLines(id, lines) {
    db.prepare('DELETE FROM sales_lines WHERE doc_id=?').run(id);
    const ins = db.prepare('INSERT INTO sales_lines(doc_id,product_id,description,qty,unit_price,tax_rate) VALUES(?,?,?,?,?,?)');
    for (const l of lines) ins.run(id, l.product_id, l.description, l.qty, l.unit_price, l.tax_rate);
    const t = computeTotals(lines);
    db.prepare('UPDATE sales_docs SET subtotal=?,tax=?,total=? WHERE id=?').run(t.subtotal, t.tax, t.total, id);
  }
  const checkCustomer = id => { if (!db.prepare('SELECT 1 FROM customers WHERE id=? AND active=1').get(v.int(id, 'customer_id', { min: 1 }))) throw new HttpError(400, 'customer_invalid'); };
  function create(kind, b, user, extra = {}) {
    checkCustomer(b.customer_id);
    const lines = cleanLines(b.lines);
    const number = (kind === 'quote' ? 'QT-' : 'SO-') + String(nextCounter(db, kind + '_seq')).padStart(6, '0');
    const r = db.prepare('INSERT INTO sales_docs(kind,number,customer_id,date,valid_until,status,notes,from_quote_id,created_by) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(kind, number, b.customer_id, v.date(b.date, 'date'), b.valid_until ? v.date(b.valid_until, 'valid_until') : null, kind === 'quote' ? 'draft' : 'open',
        v.str(b.notes, 'notes', { req: false, max: 1000 }), extra.from_quote_id || null, user.username);
    const id = Number(r.lastInsertRowid);
    writeLines(id, lines);
    audit(db, user.username, 'create', kind, id, { number });
    return id;
  }

  app.route('GET', '/api/sales', 'sales:read', ctx => {
    const kind = ctx.query.kind === 'order' ? 'order' : 'quote';
    return { items: db.prepare(`SELECT d.*, c.name AS customer_name FROM sales_docs d JOIN customers c ON c.id=d.customer_id WHERE d.kind=? ORDER BY d.id DESC LIMIT 500`).all(kind) };
  });
  app.route('GET', '/api/sales/:id', 'sales:read', ctx => get(Number(ctx.params.id)));
  app.route('POST', '/api/sales', 'sales:write', ctx => tx(db, () => ({ id: create(ctx.body.kind === 'order' ? 'order' : 'quote', ctx.body, ctx.user) })));
  app.route('PUT', '/api/sales/:id', 'sales:write', ctx => tx(db, () => {
    const id = Number(ctx.params.id), d = get(id), b = ctx.body;
    if (!((d.kind === 'quote' && d.status === 'draft') || (d.kind === 'order' && d.status === 'open'))) throw new HttpError(409, 'locked');
    checkCustomer(b.customer_id);
    const lines = cleanLines(b.lines);
    db.prepare('UPDATE sales_docs SET customer_id=?,date=?,valid_until=?,notes=? WHERE id=?')
      .run(b.customer_id, v.date(b.date, 'date'), b.valid_until ? v.date(b.valid_until, 'valid_until') : null, v.str(b.notes, 'notes', { req: false, max: 1000 }), id);
    writeLines(id, lines);
    audit(db, ctx.user.username, 'update', d.kind, id);
    return { ok: true };
  }));
  app.route('DELETE', '/api/sales/:id', 'sales:write', ctx => tx(db, () => {
    const id = Number(ctx.params.id), d = get(id);
    if (!(d.kind === 'quote' && d.status === 'draft')) throw new HttpError(409, 'locked'); // sent documents are kept for the record
    db.prepare('DELETE FROM sales_docs WHERE id=?').run(id);
    audit(db, ctx.user.username, 'delete', 'quote', id);
    return { ok: true };
  }));
  // quote status moves
  app.route('POST', '/api/sales/:id/status', 'sales:write', ctx => tx(db, () => {
    const id = Number(ctx.params.id), d = get(id), to = ctx.body.status;
    if (d.kind !== 'quote') throw new HttpError(409, 'not_quote');
    if (!(QUOTE_NEXT[d.status] || []).includes(to)) throw new HttpError(409, 'bad_transition');
    db.prepare('UPDATE sales_docs SET status=? WHERE id=?').run(to, id);
    audit(db, ctx.user.username, to, 'quote', id);
    return { status: to };
  }));
  // accepted quote -> sales order (copies the lines; the quote is marked converted and cannot be converted twice)
  app.route('POST', '/api/sales/:id/to-order', 'sales:write', ctx => tx(db, () => {
    const q = get(Number(ctx.params.id));
    if (q.kind !== 'quote' || q.status !== 'accepted') throw new HttpError(409, 'quote_not_accepted');
    const oid = create('order', { customer_id: q.customer_id, date: new Date().toISOString().slice(0, 10), notes: q.notes, lines: q.lines }, ctx.user, { from_quote_id: q.id });
    db.prepare("UPDATE sales_docs SET status='converted' WHERE id=?").run(q.id);
    return { id: oid, number: get(oid).number };
  }));
  // open order -> draft invoice (stock is only deducted when that invoice is issued)
  app.route('POST', '/api/sales/:id/to-invoice', 'sales:write', ctx => tx(db, () => {
    if (!require('./auth').can(ctx.user.role, 'invoices:write')) throw new HttpError(403, 'forbidden');
    const o = get(Number(ctx.params.id));
    if (o.kind !== 'order' || o.status !== 'open') throw new HttpError(409, 'order_not_open');
    const invId = app.createInvoice({ customer_id: o.customer_id, date: new Date().toISOString().slice(0, 10), notes: o.notes, lines: o.lines }, ctx.user);
    db.prepare("UPDATE sales_docs SET status='invoiced', invoice_id=? WHERE id=?").run(invId, o.id);
    audit(db, ctx.user.username, 'invoice', 'order', o.id, { invoice_id: invId });
    return { invoice_id: invId };
  }));
  app.route('POST', '/api/sales/:id/cancel', 'sales:write', ctx => tx(db, () => {
    const id = Number(ctx.params.id), d = get(id);
    if (d.kind !== 'order' || d.status !== 'open') throw new HttpError(409, 'order_not_open');
    db.prepare("UPDATE sales_docs SET status='cancelled' WHERE id=?").run(id);
    audit(db, ctx.user.username, 'cancel', 'order', id);
    return { ok: true };
  }));
};
