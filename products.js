'use strict';
const { HttpError, v } = require('./http');
const { audit } = require('./db');

module.exports = function products(app) {
  const db = app.db;
  // money is integer minor units (piasters/cents). tax_rate is a percent, e.g. 14.
  const clean = b => [v.str(b.sku, 'sku', { max: 40 }), v.str(b.name_ar, 'name_ar'), v.str(b.name_en, 'name_en', { req: false }), v.str(b.unit || 'pcs', 'unit', { max: 20 }),
    v.int(b.price ?? 0, 'price'), v.int(b.cost ?? 0, 'cost'), v.num(b.tax_rate ?? 0, 'tax_rate'), b.track_stock === 0 ? 0 : 1, v.num(b.reorder_level ?? 0, 'reorder_level')];
  const dupe = e => { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'sku_taken'); throw e; };
  app.route('GET', '/api/products', 'products:read', ctx => {
    const q = '%' + (ctx.query.q || '') + '%';
    return { items: db.prepare('SELECT * FROM products WHERE active=1 AND (sku LIKE ? OR name_ar LIKE ? OR name_en LIKE ?) ORDER BY name_ar LIMIT 500').all(q, q, q) };
  });
  app.route('POST', '/api/products', 'products:write', ctx => {
    try {
      const r = db.prepare('INSERT INTO products(sku,name_ar,name_en,unit,price,cost,tax_rate,track_stock,reorder_level) VALUES(?,?,?,?,?,?,?,?,?)').run(...clean(ctx.body));
      audit(db, ctx.user.username, 'create', 'product', Number(r.lastInsertRowid));
      return { id: Number(r.lastInsertRowid) };
    } catch (e) { dupe(e); }
  });
  app.route('PUT', '/api/products/:id', 'products:write', ctx => {
    try {
      const r = db.prepare('UPDATE products SET sku=?,name_ar=?,name_en=?,unit=?,price=?,cost=?,tax_rate=?,track_stock=?,reorder_level=? WHERE id=? AND active=1').run(...clean(ctx.body), Number(ctx.params.id));
      if (!r.changes) throw new HttpError(404, 'not_found');
      audit(db, ctx.user.username, 'update', 'product', Number(ctx.params.id));
      return { ok: true };
    } catch (e) { if (e instanceof HttpError) throw e; dupe(e); }
  });
  app.route('DELETE', '/api/products/:id', 'products:write', ctx => {
    const r = db.prepare('UPDATE products SET active=0 WHERE id=?').run(Number(ctx.params.id));
    if (!r.changes) throw new HttpError(404, 'not_found');
    audit(db, ctx.user.username, 'delete', 'product', Number(ctx.params.id));
    return { ok: true };
  });
};
