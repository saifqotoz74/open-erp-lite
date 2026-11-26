'use strict';
const { HttpError, v, toCsv } = require('./http');
const { can } = require('./auth');

const money = n => (n / 100).toFixed(2);
module.exports = function reports(app) {
  const db = app.db;
  const range = q => {
    const to = q.to ? v.date(q.to, 'to') : new Date().toISOString().slice(0, 10);
    const from = q.from ? v.date(q.from, 'from') : to.slice(0, 4) + '-01-01';
    if (from > to) throw new HttpError(400, 'range_invalid');
    return [from, to];
  };
  // every report returns JSON, or a CSV download with ?format=csv
  const out = (ctx, name, header, rows, json) => ctx.query.format === 'csv' ? { __csv: toCsv([header, ...rows]), filename: name + '.csv' } : json;

  // Sales by month. Only invoices that were really issued count (not drafts, not void).
  app.route('GET', '/api/reports/sales', 'reports:read', ctx => {
    const [from, to] = range(ctx.query);
    const months = db.prepare(`SELECT substr(date,1,7) AS month, COUNT(*) AS invoices, SUM(subtotal) AS subtotal, SUM(tax) AS tax, SUM(total) AS total
      FROM invoices WHERE status IN ('issued','partial','paid') AND date BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`).all(from, to);
    const customers = db.prepare(`SELECT c.name, COUNT(*) AS invoices, SUM(i.total) AS total FROM invoices i JOIN customers c ON c.id=i.customer_id
      WHERE i.status IN ('issued','partial','paid') AND i.date BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC LIMIT 10`).all(from, to);
    const products = db.prepare(`SELECT COALESCE(p.sku,'-') AS sku, l.description, SUM(l.qty) AS qty, SUM(ROUND(l.qty*l.unit_price)) AS revenue FROM invoice_lines l
      JOIN invoices i ON i.id=l.invoice_id LEFT JOIN products p ON p.id=l.product_id WHERE i.status IN ('issued','partial','paid') AND i.date BETWEEN ? AND ?
      GROUP BY COALESCE(l.product_id, -l.id), l.description ORDER BY revenue DESC LIMIT 10`).all(from, to);
    const totals = months.reduce((a, m) => ({ invoices: a.invoices + m.invoices, subtotal: a.subtotal + m.subtotal, tax: a.tax + m.tax, total: a.total + m.total }), { invoices: 0, subtotal: 0, tax: 0, total: 0 });
    return out(ctx, 'sales-' + from + '_' + to, ['month', 'invoices', 'subtotal', 'tax', 'total'], months.map(m => [m.month, m.invoices, money(m.subtotal), money(m.tax), money(m.total)]),
      { from, to, months, customers, products, totals });
  });

  // Receivables ageing: unpaid balance by how many days past due (due date, or invoice date if none) at as_of.
  app.route('GET', '/api/reports/aging', 'reports:read', ctx => {
    const asOf = ctx.query.as_of ? v.date(ctx.query.as_of, 'as_of') : new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`SELECT i.id, i.number, c.name AS customer, COALESCE(i.due_date, i.date) AS due, i.total - i.paid AS balance
      FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.status IN ('issued','partial') AND i.date <= ? ORDER BY due`).all(asOf);
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    for (const r of rows) {
      r.days_over = Math.round((Date.parse(asOf) - Date.parse(r.due)) / 86400000);
      const b = r.days_over <= 0 ? 'current' : r.days_over <= 30 ? 'd1_30' : r.days_over <= 60 ? 'd31_60' : r.days_over <= 90 ? 'd61_90' : 'd90_plus';
      r.bucket = b; buckets[b] += r.balance;
    }
    return out(ctx, 'aging-' + asOf, ['invoice', 'customer', 'due', 'days_over', 'bucket', 'balance'], rows.map(r => [r.number, r.customer, r.due, r.days_over, r.bucket, money(r.balance)]),
      { as_of: asOf, buckets, total: Object.values(buckets).reduce((a, b) => a + b, 0), items: rows });
  });

  // Stock valuation at cost: quantity on hand x product cost.
  app.route('GET', '/api/reports/stock-value', 'reports:read', ctx => {
    if (!can(ctx.user.role, 'inventory:read')) throw new HttpError(403, 'forbidden');
    const rows = db.prepare(`SELECT p.sku, p.name_ar AS name, p.cost, COALESCE(SUM(m.qty),0) AS qty, ROUND(COALESCE(SUM(m.qty),0) * p.cost) AS value
      FROM products p LEFT JOIN stock_moves m ON m.product_id=p.id WHERE p.active=1 AND p.track_stock=1 GROUP BY p.id ORDER BY value DESC`).all();
    return out(ctx, 'stock-value', ['sku', 'name', 'qty', 'cost', 'value'], rows.map(r => [r.sku, r.name, r.qty, money(r.cost), money(r.value)]),
      { items: rows, total: rows.reduce((a, r) => a + r.value, 0) });
  });

  // Payroll cost by month, finalized runs only (drafts can still change).
  app.route('GET', '/api/reports/payroll', 'payroll:read', ctx => {
    const rows = db.prepare(`SELECT r.month, COUNT(i.id) AS employees, COALESCE(SUM(i.base+i.allowance),0) AS gross, COALESCE(SUM(i.deduction),0) AS deductions,
      COALESCE(SUM(i.insurance),0) AS insurance, r.total_net AS net FROM payroll_runs r LEFT JOIN payroll_items i ON i.run_id=r.id WHERE r.status='finalized' GROUP BY r.id ORDER BY r.month`).all();
    return out(ctx, 'payroll', ['month', 'employees', 'gross', 'deductions', 'insurance', 'net'], rows.map(r => [r.month, r.employees, money(r.gross), money(r.deductions), money(r.insurance), money(r.net)]), { items: rows });
  });
};
