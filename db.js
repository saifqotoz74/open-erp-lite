'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts TEXT NOT NULL, user TEXT, action TEXT NOT NULL, entity TEXT, entity_id INTEGER, detail TEXT);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, address TEXT, tax_no TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name_ar TEXT NOT NULL, name_en TEXT, unit TEXT DEFAULT 'pcs',
  price INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0, tax_rate REAL NOT NULL DEFAULT 0, track_stock INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, reorder_level REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS warehouses(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS stock_moves(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  qty REAL NOT NULL, type TEXT NOT NULL, ref TEXT, note TEXT, date TEXT NOT NULL, created_by TEXT);
CREATE INDEX IF NOT EXISTS idx_moves_pw ON stock_moves(product_id, warehouse_id);
CREATE TABLE IF NOT EXISTS sales_docs(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('quote','order')), number TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id), date TEXT NOT NULL, valid_until TEXT, status TEXT NOT NULL, notes TEXT,
  subtotal INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  from_quote_id INTEGER REFERENCES sales_docs(id), invoice_id INTEGER REFERENCES invoices(id), created_by TEXT);
CREATE TABLE IF NOT EXISTS sales_lines(id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES sales_docs(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id), description TEXT NOT NULL, qty REAL NOT NULL, unit_price INTEGER NOT NULL, tax_rate REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, job_title TEXT, department TEXT, phone TEXT,
  hire_date TEXT NOT NULL, base_salary INTEGER NOT NULL DEFAULT 0, allowance INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', end_date TEXT);
CREATE TABLE IF NOT EXISTS attendance(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','absent','late','leave')), check_in TEXT, check_out TEXT, UNIQUE(employee_id, date));
CREATE TABLE IF NOT EXISTS leaves(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), type TEXT NOT NULL CHECK(type IN ('annual','sick','unpaid')),
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, days INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT, decided_by TEXT);
CREATE TABLE IF NOT EXISTS payroll_runs(id INTEGER PRIMARY KEY, month TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'draft', total_net INTEGER NOT NULL DEFAULT 0, created_by TEXT);
CREATE TABLE IF NOT EXISTS payroll_items(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id),
  base INTEGER NOT NULL, allowance INTEGER NOT NULL, unpaid_days INTEGER NOT NULL, deduction INTEGER NOT NULL, insurance INTEGER NOT NULL, net INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS roles(name TEXT PRIMARY KEY, perms TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, number TEXT UNIQUE, customer_id INTEGER NOT NULL REFERENCES customers(id),
  date TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'draft', subtotal INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, notes TEXT, created_by TEXT);
CREATE TABLE IF NOT EXISTS invoice_lines(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id), description TEXT NOT NULL, qty REAL NOT NULL, unit_price INTEGER NOT NULL, tax_rate REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), date TEXT NOT NULL,
  amount INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'cash', ref TEXT, created_by TEXT);
`;

function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}
// run fn inside a transaction; rolls back on throw
function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
function getSetting(db, key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : def;
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
function nextCounter(db, key) {
  const n = Number(getSetting(db, key, '0')) + 1;
  setSetting(db, key, n);
  return n;
}
function audit(db, user, action, entity, entity_id, detail) {
  db.prepare('INSERT INTO audit(ts,user,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)')
    .run(new Date().toISOString(), user || null, action, entity || null, entity_id || null, detail ? JSON.stringify(detail) : null);
}
module.exports = { openDb, tx, getSetting, setSetting, nextCounter, audit };
