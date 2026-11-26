'use strict';
const { hashPassword, verifyPassword, createSession, ROLES } = require('./auth');
const { HttpError, v } = require('./http');
const { audit, getSetting, setSetting } = require('./db');

module.exports = function core(app) {
  const db = app.db;
  // brute-force guard: 8 failed logins per username in 15 minutes locks that username for the rest of the window
  const fails = new Map();
  const locked = u => { const f = fails.get(u); return f && f.n >= 8 && Date.now() - f.t < 15 * 60e3; };
  app.route('POST', '/api/login', null, ctx => {
    const name = String(ctx.body.username || '');
    if (locked(name)) throw new HttpError(429, 'too_many_attempts');
    const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(name);
    if (!u || !verifyPassword(String(ctx.body.password || ''), u.pass_hash)) {
      const f = fails.get(name); fails.set(name, !f || Date.now() - f.t >= 15 * 60e3 ? { n: 1, t: Date.now() } : { n: f.n + 1, t: f.t });
      throw new HttpError(401, 'bad_credentials');
    }
    fails.delete(name);
    const token = createSession(db, u.id);
    ctx.headers = { 'set-cookie': `erp_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` };
    audit(db, u.username, 'login');
    return { user: { id: u.id, username: u.username, name: u.name, role: u.role } };
  });
  app.route('POST', '/api/logout', 'auth:any', ctx => {
    db.prepare('DELETE FROM sessions WHERE token=?').run(ctx.token);
    ctx.headers = { 'set-cookie': 'erp_token=; Path=/; Max-Age=0' };
    return { ok: true };
  });
  app.route('GET', '/api/me', 'auth:any', ctx => ({ user: ctx.user, company: getSetting(db, 'company_name', ''), currency: getSetting(db, 'currency', 'EGP') }));

  app.route('GET', '/api/roles', 'auth:any', () => ({ roles: ROLES }));

  // users (admin only)
  app.route('GET', '/api/users', 'users:read', () => ({ items: db.prepare('SELECT id,username,name,role,active FROM users ORDER BY id').all(), roles: Object.keys(ROLES) }));
  app.route('POST', '/api/users', 'users:write', ctx => {
    const b = ctx.body;
    const username = v.str(b.username, 'username', { max: 40 });
    const pw = v.str(b.password, 'password', { max: 100 });
    if (pw.length < 8) throw new HttpError(400, 'password_too_short');
    if (!ROLES[b.role]) throw new HttpError(400, 'role_invalid');
    try {
      const r = db.prepare('INSERT INTO users(username,name,pass_hash,role) VALUES(?,?,?,?)').run(username, v.str(b.name, 'name'), hashPassword(pw), b.role);
      audit(db, ctx.user.username, 'create', 'user', Number(r.lastInsertRowid), { role: b.role });
      return { id: Number(r.lastInsertRowid) };
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'username_taken'); throw e; }
  });
  app.route('PUT', '/api/users/:id', 'users:write', ctx => {
    const b = ctx.body, id = Number(ctx.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) throw new HttpError(404, 'not_found');
    if (b.role !== undefined && !ROLES[b.role]) throw new HttpError(400, 'role_invalid');
    if (id === ctx.user.id && (b.active === 0 || (b.role && b.role !== 'admin'))) throw new HttpError(400, 'cannot_demote_self');
    if (b.password) { if (String(b.password).length < 8) throw new HttpError(400, 'password_too_short'); db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(b.password), id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); }
    db.prepare('UPDATE users SET name=?, role=?, active=? WHERE id=?').run(b.name ?? u.name, b.role ?? u.role, b.active ?? u.active, id);
    audit(db, ctx.user.username, 'update', 'user', id);
    return { ok: true };
  });
  app.route('GET', '/api/settings', 'settings:read', () => ({ company_name: getSetting(db, 'company_name', ''), currency: getSetting(db, 'currency', 'EGP'), default_tax: Number(getSetting(db, 'default_tax', '14')), annual_leave_days: Number(getSetting(db, 'annual_leave_days', '21')), insurance_pct: Number(getSetting(db, 'insurance_pct', '0')) }));
  app.route('PUT', '/api/settings', 'settings:write', ctx => {
    for (const k of ['company_name', 'currency', 'default_tax', 'annual_leave_days', 'insurance_pct']) if (ctx.body[k] !== undefined) setSetting(db, k, ctx.body[k]);
    audit(db, ctx.user.username, 'update', 'settings');
    return { ok: true };
  });
  app.route('GET', '/api/audit', 'settings:read', ctx => ({ items: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(Number(ctx.query.limit) || 100, 500)) }));
};
