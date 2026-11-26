'use strict';
const { HttpError, v } = require('./http');
const { tx, audit, getSetting } = require('./db');

// Stock on hand is never stored: it is the sum of signed stock_moves rows, so history and balance cannot drift apart.
module.exports = function inventory(app) {
  const db = app.db;
  if (!db.prepare('SELECT 1 FROM warehouses LIMIT 1').get()) db.prepare("INSERT INTO warehouses(name) VALUES('Main')").run();

  const onHand = (productId, warehouseId) => db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM stock_moves WHERE product_id=? AND warehouse_id=?').get(productId, warehouseId).q;
  const defaultWarehouse = () => {
    const id = Number(getSetting(db, 'default_warehouse', '0'));
    return (id && db.prepare('SELECT id FROM warehouses WHERE id=? AND active=1').get(id)) ? id : db.prepare('SELECT id FROM warehouses WHERE active=1 ORDER BY id LIMIT 1').get().id;
  };
  function move(productId, warehouseId, qty, type, { ref = null, note = null, date, user }) {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(productId);
    if (!p) throw new HttpError(400, 'product_invalid');
    if (!p.track_stock) throw new HttpError(400, 'product_not_tracked');
    if (!db.prepare('SELECT 1 FROM warehouses WHERE id=? AND active=1').get(warehouseId)) throw new HttpError(400, 'warehouse_invalid');
    if (qty < 0 && onHand(productId, warehouseId) + qty < -1e-9) throw new HttpError(409, 'insufficient_stock');
    db.prepare('INSERT INTO stock_moves(product_id,warehouse_id,qty,type,ref,note,date,created_by) VALUES(?,?,?,?,?,?,?,?)')
      .run(productId, warehouseId, qty, type, ref, note, date || new Date().toISOString().slice(0, 10), user);
  }
  const common = (b, user) => ({ date: b.date ? v.date(b.date, 'date') : undefined, note: v.str(b.note, 'note', { req: false, max: 300 }), ref: v.str(b.ref, 'ref', { req: false, max: 80 }), user: user.username });

  app.route('GET', '/api/warehouses', 'inventory:read', () => ({ items: db.prepare('SELECT * FROM warehouses WHERE active=1 ORDER BY id').all() }));
  app.route('POST', '/api/warehouses', 'inventory:write', ctx => {
    try {
      const r = db.prepare('INSERT INTO warehouses(name) VALUES(?)').run(v.str(ctx.body.name, 'name', { max: 80 }));
      audit(db, ctx.user.username, 'create', 'warehouse', Number(r.lastInsertRowid));
      return { id: Number(r.lastInsertRowid) };
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'name_taken'); throw e; }
  });
  // stock levels: one row per tracked product with per-warehouse quantities and a low-stock flag
  app.route('GET', '/api/stock', 'inventory:read', ctx => {
    const q = '%' + (ctx.query.q || '') + '%';
    const prods = db.prepare('SELECT id,sku,name_ar,name_en,unit,reorder_level,cost FROM products WHERE active=1 AND track_stock=1 AND (sku LIKE ? OR name_ar LIKE ? OR name_en LIKE ?) ORDER BY name_ar LIMIT 500').all(q, q, q);
    const sums = db.prepare('SELECT product_id, warehouse_id, SUM(qty) AS q FROM stock_moves GROUP BY product_id, warehouse_id').all();
    return { items: prods.map(p => {
      const by = {}; let total = 0;
      for (const s of sums) if (s.product_id === p.id) { by[s.warehouse_id] = s.q; total += s.q; }
      return { ...p, by_warehouse: by, total, low: total <= p.reorder_level };
    }) };
  });
  app.route('GET', '/api/stock/moves', 'inventory:read', ctx => {
    const where = [], args = [];
    if (ctx.query.product_id) { where.push('m.product_id=?'); args.push(Number(ctx.query.product_id)); }
    return { items: db.prepare(`SELECT m.*, p.sku, p.name_ar, w.name AS warehouse FROM stock_moves m JOIN products p ON p.id=m.product_id JOIN warehouses w ON w.id=m.warehouse_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC LIMIT 300`).all(...args) };
  });
  app.route('POST', '/api/stock/receive', 'inventory:write', ctx => tx(db, () => {
    const b = ctx.body;
    move(v.int(b.product_id, 'product_id', { min: 1 }), v.int(b.warehouse_id, 'warehouse_id', { min: 1 }), v.num(b.qty, 'qty', { min: 0.001 }), 'receipt', common(b, ctx.user));
    audit(db, ctx.user.username, 'receive', 'stock', b.product_id, { qty: b.qty });
    return { on_hand: onHand(b.product_id, b.warehouse_id) };
  }));
  // adjustment: qty is the signed difference (stock count correction). A reason note is required.
  app.route('POST', '/api/stock/adjust', 'inventory:write', ctx => tx(db, () => {
    const b = ctx.body;
    if (typeof b.qty !== 'number' || !Number.isFinite(b.qty) || b.qty === 0) throw new HttpError(400, 'qty_invalid');
    const c = common(b, ctx.user); if (!c.note) throw new HttpError(400, 'note_required');
    move(v.int(b.product_id, 'product_id', { min: 1 }), v.int(b.warehouse_id, 'warehouse_id', { min: 1 }), b.qty, 'adjust', c);
    audit(db, ctx.user.username, 'adjust', 'stock', b.product_id, { qty: b.qty, note: c.note });
    return { on_hand: onHand(b.product_id, b.warehouse_id) };
  }));
  app.route('POST', '/api/stock/transfer', 'inventory:write', ctx => tx(db, () => {
    const b = ctx.body, pid = v.int(b.product_id, 'product_id', { min: 1 }), from = v.int(b.from_warehouse_id, 'from_warehouse_id', { min: 1 }), to = v.int(b.to_warehouse_id, 'to_warehouse_id', { min: 1 });
    if (from === to) throw new HttpError(400, 'same_warehouse');
    const qty = v.num(b.qty, 'qty', { min: 0.001 }), c = common(b, ctx.user);
    move(pid, from, -qty, 'transfer_out', c); move(pid, to, qty, 'transfer_in', c);
    audit(db, ctx.user.username, 'transfer', 'stock', pid, { qty, from, to });
    return { from: onHand(pid, from), to: onHand(pid, to) };
  }));

  // invoice integration: issuing deducts stock from the default warehouse, all or nothing. Voiding puts it back.
  const need = lines => { const m = new Map(); for (const l of lines) if (l.product_id) m.set(l.product_id, (m.get(l.product_id) || 0) + l.qty); return m; };
  const tracked = id => db.prepare('SELECT track_stock FROM products WHERE id=?').get(id)?.track_stock === 1;
  app.invoiceHooks.onIssue.push((inv, user) => {
    const wh = defaultWarehouse();
    for (const [pid, qty] of need(inv.lines)) if (tracked(pid)) move(pid, wh, -qty, 'sale', { ref: 'invoice:' + inv.id, user: user.username, date: inv.date });
  });
  app.invoiceHooks.onVoid.push((inv, user) => {
    const sold = db.prepare("SELECT product_id, warehouse_id, -SUM(qty) AS q FROM stock_moves WHERE ref=? AND type='sale' GROUP BY product_id, warehouse_id").all('invoice:' + inv.id);
    for (const s of sold) move(s.product_id, s.warehouse_id, s.q, 'void_return', { ref: 'invoice:' + inv.id, user: user.username });
  });
};
