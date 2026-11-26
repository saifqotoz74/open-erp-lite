'use strict';
const crypto = require('node:crypto');

// Role -> permissions. "module:action". '*' = everything. Admin can edit this map per install.
const ROLES = {
  admin: ['*'],
  accountant: ['sales:read', 'customers:*', 'products:read', 'invoices:*', 'inventory:read', 'reports:read'],
  sales: ['sales:*', 'customers:*', 'products:read', 'inventory:read', 'invoices:read', 'invoices:write'],
  hr: ['hr:*', 'payroll:*'],
  warehouse: ['products:read', 'inventory:*', 'invoices:read'],
  viewer: ['sales:read', 'customers:read', 'products:read', 'invoices:read', 'inventory:read', 'reports:read'],
};
const DEFAULT_ROLES = JSON.parse(JSON.stringify(ROLES));
// permission catalog: module -> actions. A role holds "module:action", "module:*" or "*".
const CATALOG = { customers: ['read', 'write'], products: ['read', 'write'], invoices: ['read', 'write'], inventory: ['read', 'write'], sales: ['read', 'write'],
  hr: ['read', 'write'], payroll: ['read', 'write'], reports: ['read'], users: ['read', 'write'], settings: ['read', 'write'], roles: ['read', 'write'] };
function validPerm(p) {
  if (typeof p !== 'string') return false;
  const [m, act] = p.split(':');
  return CATALOG[m] && (act === '*' || CATALOG[m].includes(act));
}
// rebuild the live role map from defaults plus saved overrides (called at startup)
function loadRoles(rows) {
  for (const k of Object.keys(ROLES)) delete ROLES[k];
  Object.assign(ROLES, JSON.parse(JSON.stringify(DEFAULT_ROLES)));
  for (const r of rows) if (r.name !== 'admin') ROLES[r.name] = JSON.parse(r.perms);
}
function can(role, perm) {
  const list = ROLES[role] || [];
  const [mod] = perm.split(':');
  return list.includes('*') || list.includes(perm) || list.includes(mod + ':*');
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run(token, userId, Date.now() + 12 * 3600e3);
  return token;
}
function userFromToken(db, token) {
  if (!token) return null;
  const r = db.prepare('SELECT u.id,u.username,u.name,u.role,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1').get(token);
  if (!r || r.expires < Date.now()) return null;
  return { id: r.id, username: r.username, name: r.name, role: r.role };
}
module.exports = { ROLES, CATALOG, DEFAULT_ROLES, validPerm, loadRoles, can, hashPassword, verifyPassword, createSession, userFromToken };
