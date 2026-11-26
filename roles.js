'use strict';
const { HttpError, v } = require('./http');
const { audit } = require('./db');
const { ROLES, DEFAULT_ROLES, CATALOG, validPerm, loadRoles } = require('./auth');

// Roles are editable at runtime and saved in the database. "admin" is fixed (always everything) so nobody can lock themselves out.
module.exports = function roles(app) {
  const db = app.db;
  loadRoles(db.prepare('SELECT * FROM roles').all());
  const save = (name, perms) => {
    db.prepare('INSERT INTO roles(name,perms) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET perms=excluded.perms').run(name, JSON.stringify(perms));
    ROLES[name] = perms;
  };
  const cleanPerms = raw => {
    if (!Array.isArray(raw) || raw.length > 100) throw new HttpError(400, 'perms_invalid');
    for (const p of raw) if (!validPerm(p)) throw new HttpError(400, 'perms_invalid');
    return [...new Set(raw)].sort();
  };
  app.route('GET', '/api/roles-admin', 'roles:read', () => ({
    catalog: CATALOG,
    items: Object.keys(ROLES).map(name => ({
      name, perms: ROLES[name], builtin: name in DEFAULT_ROLES, fixed: name === 'admin',
      users: db.prepare('SELECT COUNT(*) AS n FROM users WHERE role=? AND active=1').get(name).n,
    })),
  }));
  app.route('POST', '/api/roles-admin', 'roles:write', ctx => {
    const name = v.str(ctx.body.name, 'name', { max: 30 });
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(name)) throw new HttpError(400, 'role_name_invalid');
    if (ROLES[name]) throw new HttpError(409, 'role_exists');
    save(name, cleanPerms(ctx.body.perms));
    audit(db, ctx.user.username, 'create', 'role', null, { name });
    return { name };
  });
  app.route('PUT', '/api/roles-admin/:name', 'roles:write', ctx => {
    const name = ctx.params.name;
    if (!ROLES[name]) throw new HttpError(404, 'not_found');
    if (name === 'admin') throw new HttpError(409, 'role_fixed');
    save(name, cleanPerms(ctx.body.perms));
    audit(db, ctx.user.username, 'update', 'role', null, { name, perms: ROLES[name] });
    return { ok: true };
  });
  // built-in roles can be reset to their shipped defaults; custom roles can be deleted if nobody uses them
  app.route('DELETE', '/api/roles-admin/:name', 'roles:write', ctx => {
    const name = ctx.params.name;
    if (!ROLES[name]) throw new HttpError(404, 'not_found');
    if (name === 'admin') throw new HttpError(409, 'role_fixed');
    if (name in DEFAULT_ROLES) {
      db.prepare('DELETE FROM roles WHERE name=?').run(name);
      ROLES[name] = JSON.parse(JSON.stringify(DEFAULT_ROLES[name]));
      audit(db, ctx.user.username, 'reset', 'role', null, { name });
      return { reset: true };
    }
    if (db.prepare('SELECT 1 FROM users WHERE role=?').get(name)) throw new HttpError(409, 'role_in_use');
    db.prepare('DELETE FROM roles WHERE name=?').run(name);
    delete ROLES[name];
    audit(db, ctx.user.username, 'delete', 'role', null, { name });
    return { deleted: true };
  });
};
