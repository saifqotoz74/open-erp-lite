'use strict';
const path = require('node:path');
const { openDb, getSetting, setSetting } = require('./db');
const { createApp } = require('./http');
const { hashPassword } = require('./auth');

const MODULES = ['core', 'customers', 'products', 'invoices', 'inventory', 'sales', 'hr', 'roles', 'reports'];

function build(dbFile = ':memory:') {
  const db = openDb(dbFile);
  const app = createApp(db, { publicDir: __dirname });
  for (const m of MODULES) require('./' + m)(app);
  // first run: create the admin user. Password comes from ADMIN_PASSWORD or is generated and printed once.
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    const pw = process.env.ADMIN_PASSWORD || require('node:crypto').randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO users(username,name,pass_hash,role) VALUES(?,?,?,?)').run('admin', 'Administrator', hashPassword(pw), 'admin');
    setSetting(db, 'company_name', 'My Company'); setSetting(db, 'currency', 'EGP'); setSetting(db, 'default_tax', '14');
    if (!process.env.ADMIN_PASSWORD) console.log(`First run. Login: admin / ${pw}  (change it after logging in)`);
  }
  return app;
}
module.exports = { build };

if (require.main === module) {
  const app = build(process.env.DB_FILE || path.join(__dirname, 'erp.db'));
  const port = Number(process.env.PORT) || 3000;
  app.server.listen(port, () => console.log(`ERP running on http://localhost:${port}`));
}
