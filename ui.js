'use strict';
// Small framework-free SPA. Money is integer minor units on the wire; shown with 2 decimals.
let lang = localStorage.getItem('lang') || 'ar';
const t = k => (I18N[lang][k] ?? I18N.en[k] ?? k);
const fmt = n => (n / 100).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toMinor = s => Math.round(parseFloat(String(s).replace(',', '.') || '0') * 100);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r = document) => r.querySelector(s);
const state = { user: null, page: 'dashboard', pages: [], settings: {} };
const today = () => new Date().toISOString().slice(0, 10);

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'error'); e.code = j.error; e.status = r.status; throw e; }
  return j;
}
const errText = e => t('e_' + e.code) !== 'e_' + e.code ? t('e_' + e.code) : (e.code || e.message);
function setLang(l) { lang = l; localStorage.setItem('lang', l); document.documentElement.lang = l; document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr'; render(); }

// Pages register themselves here: {id, perm, label, render(el)}. Later modules add to this list.
const PAGES = [];
const can = perm => {
  const R = state.roles?.[state.user.role] || [];
  const [m] = perm.split(':');
  return R.includes('*') || R.includes(perm) || R.includes(m + ':*');
};

async function render() {
  const root = $('#app');
  if (!state.user) {
    try { const me = await api('GET', '/api/me'); state.user = me.user; state.settings = me; } catch { }
  }
  if (!state.user) return renderLogin(root);
  state.roles = state.roles || (await api('GET', '/api/roles')).roles;
  const pages = PAGES.filter(p => can(p.perm));
  if (!pages.find(p => p.id === state.page)) state.page = pages[0].id;
  root.innerHTML = `<div class="layout"><nav class="side"><h1>${esc(state.settings.company || t('app'))}</h1>
    ${pages.map(p => `<a data-p="${p.id}" class="${p.id === state.page ? 'on' : ''}">${t(p.id)}</a>`).join('')}
    <a id="lang">${t('language')}</a><a id="out">${t('logout')} (${esc(state.user.username)})</a></nav><main class="main" id="view"></main></div>`;
  root.querySelectorAll('[data-p]').forEach(a => a.onclick = () => { state.page = a.dataset.p; render(); });
  $('#lang').onclick = () => setLang(lang === 'ar' ? 'en' : 'ar');
  $('#out').onclick = async () => { await api('POST', '/api/logout'); state.user = null; render(); };
  await pages.find(p => p.id === state.page).render($('#view'));
}
function renderLogin(root) {
  root.innerHTML = `<div class="card login"><h2>${t('app')}</h2><div id="e"></div>
    <label>${t('username')}</label><input id="u" autocomplete="username"><label style="margin-top:8px">${t('password')}</label><input id="p" type="password" autocomplete="current-password">
    <div class="row" style="margin-top:12px"><button id="go">${t('login')}</button><span class="sp"></span><button class="sec" id="lang">${t('language')}</button></div></div>`;
  $('#lang').onclick = () => setLang(lang === 'ar' ? 'en' : 'ar');
  const go = async () => { try { const r = await api('POST', '/api/login', { username: $('#u').value, password: $('#p').value }); state.user = r.user; state.roles = null; state.settings = await api('GET', '/api/me'); render(); } catch (e) { $('#e').innerHTML = `<div class="err">${esc(errText(e))}</div>`; } };
  $('#go').onclick = go; $('#p').onkeydown = e => { if (e.key === 'Enter') go(); };
}

// ---- generic CRUD page ----
function crudPage({ id, perm, path, cols, fields, extraRow }) {
  PAGES.push({ id, perm, async render(el) {
    const canW = can(perm.replace(':read', ':write'));
    el.innerHTML = `<div class="top"><h2>${t(id)}</h2><div class="row"><input id="q" placeholder="${t('search')}" style="width:180px">${canW ? `<button id="add">${t('add')}</button>` : ''}</div></div><div id="msg"></div><div id="form"></div><div class="card"><table><thead><tr>${cols.map(c => `<th>${t(c.k)}</th>`).join('')}${canW ? `<th>${t('actions')}</th>` : ''}</tr></thead><tbody id="rows"></tbody></table></div>`;
    const load = async () => {
      const { items } = await api('GET', `${path}?q=${encodeURIComponent($('#q').value)}`);
      $('#rows').innerHTML = items.map(r => `<tr>${cols.map(c => `<td class="${c.money ? 'num' : ''}">${c.money ? fmt(r[c.k]) : esc(c.bool ? (r[c.k] ? '✓' : '') : r[c.k])}</td>`).join('')}${canW ? `<td><button class="sec" data-e="${r.id}">${t('edit')}</button> <button class="bad" data-d="${r.id}">${t('delete')}</button></td>` : ''}</tr>`).join('') || `<tr><td colspan="9">${t('none')}</td></tr>`;
      el.querySelectorAll('[data-e]').forEach(b => b.onclick = () => form(items.find(r => r.id == b.dataset.e)));
      el.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => { if (confirm(t('confirm'))) { try { await api('DELETE', `${path}/${b.dataset.d}`); load(); } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(errText(e))}</div>`; } } });
    };
    const form = row => {
      const r = row || {};
      $('#form').innerHTML = `<div class="card"><div class="grid">${fields.map(f => `<div><label>${t(f.k)}</label><input data-f="${f.k}" ${f.type === 'checkbox' ? `type="checkbox" style="width:auto" ${(r[f.k] ?? 1) ? 'checked' : ''}` : `value="${esc(f.money ? (r[f.k] != null ? r[f.k] / 100 : '') : (r[f.k] ?? f.def ?? ''))}"`}></div>`).join('')}</div>
        <div class="row" style="margin-top:10px"><button id="sv">${t('save')}</button><button class="sec" id="cn">${t('cancel')}</button></div></div>`;
      $('#cn').onclick = () => $('#form').innerHTML = '';
      $('#sv').onclick = async () => {
        const body = {}; el.querySelectorAll('[data-f]').forEach(i => { const f = fields.find(x => x.k === i.dataset.f); body[f.k] = f.type === 'checkbox' ? (i.checked ? 1 : 0) : f.money ? toMinor(i.value) : f.num ? parseFloat(i.value || '0') : i.value; });
        try { await api(r.id ? 'PUT' : 'POST', r.id ? `${path}/${r.id}` : path, body); $('#form').innerHTML = ''; $('#msg').innerHTML = `<div class="okmsg">${t('saved')}</div>`; load(); } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(errText(e))}</div>`; }
      };
    };
    if (canW) $('#add').onclick = () => form(null);
    $('#q').oninput = load; load();
  } });
}
const sbadge = s => `<span class="badge ${s}">${t(s === 'paid' ? 'paid_s' : s === 'void' ? 'void_s' : s)}</span>`;

// ---- pages ----
PAGES.push({ id: 'dashboard', perm: 'reports:read', async render(el) {
  const [rc, inv] = await Promise.all([api('GET', '/api/reports/receivables'), api('GET', '/api/invoices')]);
  const due = rc.items.reduce((a, x) => a + x.due, 0);
  el.innerHTML = `<div class="top"><h2>${t('dashboard')}</h2></div><div class="grid"><div class="card"><div>${t('due_total')}</div><div class="kpi num">${fmt(due)}</div></div>
    <div class="card"><div>${t('open_invoices')}</div><div class="kpi">${inv.items.filter(i => ['issued', 'partial'].includes(i.status)).length}</div></div>
    <div class="card"><div>${t('invoices')}</div><div class="kpi">${inv.items.length}</div></div></div>
    <div class="card"><h3>${t('receivables')}</h3><table><tbody>${rc.items.map(x => `<tr><td>${esc(x.name)}</td><td>${x.invoices}</td><td class="num">${fmt(x.due)}</td></tr>`).join('') || `<tr><td>${t('none')}</td></tr>`}</tbody></table></div>`;
} });
crudPage({ id: 'customers', perm: 'customers:read', path: '/api/customers', cols: [{ k: 'name' }, { k: 'phone' }, { k: 'email' }, { k: 'balance', money: true }], fields: [{ k: 'name' }, { k: 'phone' }, { k: 'email' }, { k: 'address' }, { k: 'tax_no' }] });
crudPage({ id: 'products', perm: 'products:read', path: '/api/products', cols: [{ k: 'sku' }, { k: 'name_ar' }, { k: 'name_en' }, { k: 'price', money: true }, { k: 'tax_rate' }], fields: [{ k: 'sku' }, { k: 'name_ar' }, { k: 'name_en' }, { k: 'unit', def: 'pcs' }, { k: 'price', money: true }, { k: 'cost', money: true }, { k: 'tax_rate', num: true, def: 14 }, { k: 'reorder_level', num: true, def: 0 }, { k: 'track_stock', type: 'checkbox' }] });

PAGES.push({ id: 'invoices', perm: 'invoices:read', async render(el, openId) {
  const canW = can('invoices:write');
  if (openId) return invoiceView(el, openId);
  const { items } = await api('GET', '/api/invoices');
  el.innerHTML = `<div class="top"><h2>${t('invoices')}</h2>${canW ? `<button id="new">${t('new_invoice')}</button>` : ''}</div><div class="card"><table><thead><tr><th>${t('number')}</th><th>${t('customer')}</th><th>${t('date')}</th><th>${t('total')}</th><th>${t('remaining')}</th><th>${t('status')}</th></tr></thead><tbody>
    ${items.map(i => `<tr style="cursor:pointer" data-i="${i.id}"><td>${esc(i.number || '—')}</td><td>${esc(i.customer_name)}</td><td>${i.date}</td><td class="num">${fmt(i.total)}</td><td class="num">${fmt(i.total - i.paid)}</td><td>${sbadge(i.status)}</td></tr>`).join('') || `<tr><td colspan="6">${t('none')}</td></tr>`}</tbody></table></div>`;
  el.querySelectorAll('[data-i]').forEach(r => r.onclick = () => invoiceView(el, r.dataset.i));
  if (canW) $('#new').onclick = () => invoiceForm(el, null);
} });

async function invoiceForm(el, inv, cfg = {}) {
  const api_ = cfg.api || '/api/invoices', dk = cfg.dateKey || 'due_date', onSaved = cfg.onSaved || (id => invoiceView(el, id)), onCancel = cfg.onCancel || (() => PAGES.find(p => p.id === 'invoices').render(el));
  const [{ items: cust }, { items: prods }, st] = await Promise.all([api('GET', '/api/customers'), api('GET', '/api/products'), api('GET', '/api/settings').catch(() => ({ default_tax: 14 }))]);
  const lines = inv ? inv.lines.map(l => ({ ...l })) : [{ description: '', qty: 1, unit_price: 0, tax_rate: st.default_tax ?? 14, product_id: null }];
  el.innerHTML = `<div class="top"><h2>${t('invoices')}</h2></div><div id="msg"></div><div class="card"><div class="grid">
    <div><label>${t('customer')}</label><select id="cu"><option value="">—</option>${cust.map(c => `<option value="${c.id}" ${inv && inv.customer_id == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div><label>${t('date')}</label><input id="dt" type="date" value="${inv ? inv.date : today()}"></div><div><label>${t(dk)}</label><input id="dd" type="date" value="${inv?.[dk] || ''}"></div></div></div>
    <div class="card"><table><thead><tr><th>${t('products')}</th><th>${t('description')}</th><th>${t('qty')}</th><th>${t('unit_price')}</th><th>${t('tax_rate')}</th><th>${t('line_total')}</th><th></th></tr></thead><tbody id="ls"></tbody></table>
    <div class="row" style="margin-top:8px"><button class="sec" id="al">${t('add_line')}</button><span class="sp"></span><div>${t('total')}: <b class="num" id="tt"></b></div></div></div>
    <div class="card"><label>${t('notes')}</label><textarea id="nt">${esc(inv?.notes || '')}</textarea></div><div class="row"><button id="sv">${t('save')}</button><button class="sec" id="cn">${t('cancel')}</button></div>`;
  const draw = () => {
    $('#ls').innerHTML = lines.map((l, i) => `<tr><td><select data-i="${i}" data-k="product_id" style="min-width:130px"><option value="">—</option>${prods.map(p => `<option value="${p.id}" ${l.product_id == p.id ? 'selected' : ''}>${esc(p.sku)} ${esc(p.name_ar)}</option>`).join('')}</select></td>
      <td><input data-i="${i}" data-k="description" value="${esc(l.description)}"></td><td><input data-i="${i}" data-k="qty" type="number" step="any" value="${l.qty}" style="width:80px"></td>
      <td><input data-i="${i}" data-k="unit_price" type="number" step="0.01" value="${l.unit_price / 100}" style="width:110px"></td><td><input data-i="${i}" data-k="tax_rate" type="number" step="any" value="${l.tax_rate}" style="width:70px"></td>
      <td class="num" id="lt${i}"></td><td><button class="bad" data-r="${i}">×</button></td></tr>`).join('');
    sum();
    el.querySelectorAll('[data-k]').forEach(inp => inp.onchange = () => {
      const l = lines[inp.dataset.i], k = inp.dataset.k;
      if (k === 'product_id') { const p = prods.find(x => x.id == inp.value); l.product_id = p ? p.id : null; if (p) { l.description = p.name_ar; l.unit_price = p.price; l.tax_rate = p.tax_rate; } draw(); }
      else { l[k] = k === 'description' ? inp.value : k === 'unit_price' ? toMinor(inp.value) : parseFloat(inp.value || '0'); sum(); }
    });
    el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { lines.splice(b.dataset.r, 1); if (!lines.length) lines.push({ description: '', qty: 1, unit_price: 0, tax_rate: 14, product_id: null }); draw(); });
  };
  const sum = () => { let tot = 0; lines.forEach((l, i) => { const net = Math.round(l.qty * l.unit_price), lt = net + Math.round(net * l.tax_rate / 100); tot += lt; const c = $('#lt' + i); if (c) c.textContent = fmt(lt); }); $('#tt').textContent = fmt(tot); };
  $('#al').onclick = () => { lines.push({ description: '', qty: 1, unit_price: 0, tax_rate: st.default_tax ?? 14, product_id: null }); draw(); };
  $('#cn').onclick = onCancel;
  $('#sv').onclick = async () => {
    const body = { ...(cfg.extra || {}), customer_id: Number($('#cu').value) || 0, date: $('#dt').value, [dk]: $('#dd').value || null, notes: $('#nt').value, lines };
    try { const r = inv ? await api('PUT', api_ + '/' + inv.id, body) : await api('POST', api_, body); onSaved(inv ? inv.id : r.id); }
    catch (e) { $('#msg').innerHTML = `<div class="err">${esc(errText(e))}</div>`; }
  };
  draw();
}
async function invoiceView(el, id) {
  const inv = await api('GET', '/api/invoices/' + id), canW = can('invoices:write');
  const cur = state.settings.currency || '';
  el.innerHTML = `<div class="top"><h2>${esc(inv.number || t('draft'))} ${sbadge(inv.status)}</h2><div class="row noprint"><button class="sec" id="bk">${t('invoices')}</button><button class="sec" id="pr">${t('print')}</button>
    ${canW && inv.status === 'draft' ? `<button class="sec" id="ed">${t('edit')}</button><button id="is">${t('issue')}</button><button class="bad" id="dl">${t('delete')}</button>` : ''}
    ${canW && inv.status === 'issued' ? `<button class="bad" id="vd">${t('void')}</button>` : ''}</div></div><div id="msg"></div>
    <div class="card"><div class="grid"><div><label>${t('customer')}</label>${esc(inv.customer_name)}</div><div><label>${t('date')}</label>${inv.date}</div><div><label>${t('due_date')}</label>${inv.due_date || '—'}</div></div></div>
    <div class="card"><table><thead><tr><th>${t('description')}</th><th>${t('qty')}</th><th>${t('unit_price')}</th><th>${t('tax_rate')}</th><th>${t('line_total')}</th></tr></thead><tbody>
    ${inv.lines.map(l => { const n = Math.round(l.qty * l.unit_price); return `<tr><td>${esc(l.description)}</td><td>${l.qty}</td><td class="num">${fmt(l.unit_price)}</td><td>${l.tax_rate}</td><td class="num">${fmt(n + Math.round(n * l.tax_rate / 100))}</td></tr>`; }).join('')}</tbody></table>
    <p class="num">${t('subtotal')}: ${fmt(inv.subtotal)} | ${t('tax')}: ${fmt(inv.tax)} | <b>${t('total')}: ${fmt(inv.total)} ${esc(cur)}</b> | ${t('paid')}: ${fmt(inv.paid)} | ${t('remaining')}: ${fmt(inv.total - inv.paid)}</p>${inv.notes ? `<p>${esc(inv.notes)}</p>` : ''}</div>
    ${inv.payments.length ? `<div class="card"><table><tbody>${inv.payments.map(p => `<tr><td>${p.date}</td><td>${t(p.method)}</td><td>${esc(p.ref || '')}</td><td class="num">${fmt(p.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${canW && ['issued', 'partial'].includes(inv.status) ? `<div class="card noprint"><h3>${t('pay')}</h3><div class="grid"><div><label>${t('date')}</label><input id="pd" type="date" value="${today()}"></div><div><label>${t('amount')}</label><input id="pa" type="number" step="0.01" value="${(inv.total - inv.paid) / 100}"></div>
    <div><label>${t('method')}</label><select id="pm">${['cash', 'bank', 'card', 'wallet'].map(m => `<option value="${m}">${t(m)}</option>`).join('')}</select></div></div><div style="margin-top:10px"><button id="pp">${t('pay')}</button></div></div>` : ''}`;
  const show = e => $('#msg').innerHTML = `<div class="err">${esc(errText(e))}</div>`;
  const back = () => PAGES.find(p => p.id === 'invoices').render(el);
  $('#bk').onclick = back; $('#pr').onclick = () => window.print();
  const on = (i, fn) => { const b = $(i); if (b) b.onclick = async () => { try { await fn(); } catch (e) { show(e); } }; };
  on('#ed', () => invoiceForm(el, inv));
  on('#is', async () => { await api('POST', `/api/invoices/${id}/issue`); invoiceView(el, id); });
  on('#dl', async () => { if (confirm(t('confirm'))) { await api('DELETE', '/api/invoices/' + id); back(); } });
  on('#vd', async () => { if (confirm(t('confirm'))) { await api('POST', `/api/invoices/${id}/void`); invoiceView(el, id); } });
  on('#pp', async () => { await api('POST', `/api/invoices/${id}/payments`, { date: $('#pd').value, amount: toMinor($('#pa').value), method: $('#pm').value }); invoiceView(el, id); });
}

// ---- sales: quotes and orders ----
const DOC_STATUS = s => `<span class="badge ${s === 'accepted' || s === 'invoiced' ? 'paid' : s === 'rejected' || s === 'cancelled' ? 'void' : 'issued'}">${t('s_' + s)}</span>`;
PAGES.push({ id: 'sales', perm: 'sales:read', async render(el, kind = state.salesKind || 'quote') {
  state.salesKind = kind;
  const canW = can('sales:write'), { items } = await api('GET', '/api/sales?kind=' + kind);
  el.innerHTML = `<div class="top"><h2>${t('sales')}</h2><div class="row"><button class="${kind === 'quote' ? '' : 'sec'}" id="kq">${t('quotes')}</button><button class="${kind === 'order' ? '' : 'sec'}" id="ko">${t('orders')}</button>${canW ? `<button id="new">${t('add')}</button>` : ''}</div></div>
    <div class="card"><table><thead><tr><th>${t('number')}</th><th>${t('customer')}</th><th>${t('date')}</th><th>${t('total')}</th><th>${t('status')}</th></tr></thead><tbody>
    ${items.map(d => `<tr style="cursor:pointer" data-i="${d.id}"><td>${esc(d.number)}</td><td>${esc(d.customer_name)}</td><td>${d.date}</td><td class="num">${fmt(d.total)}</td><td>${DOC_STATUS(d.status)}</td></tr>`).join('') || `<tr><td colspan="5">${t('none')}</td></tr>`}</tbody></table></div>`;
  const page = PAGES.find(p => p.id === 'sales');
  $('#kq').onclick = () => page.render(el, 'quote'); $('#ko').onclick = () => page.render(el, 'order');
  el.querySelectorAll('[data-i]').forEach(r => r.onclick = () => salesView(el, r.dataset.i));
  if (canW) $('#new').onclick = () => invoiceForm(el, null, salesCfg(el, kind));
} });
const salesCfg = (el, kind) => ({ api: '/api/sales', dateKey: 'valid_until', extra: { kind }, onSaved: id => salesView(el, id), onCancel: () => PAGES.find(p => p.id === 'sales').render(el, kind) });
async function salesView(el, id) {
  const d = await api('GET', '/api/sales/' + id), canW = can('sales:write'), canI = can('invoices:write');
  const btn = (i, k, cls = '') => `<button class="${cls}" id="${i}">${t(k)}</button>`;
  el.innerHTML = `<div class="top"><h2>${esc(d.number)} ${DOC_STATUS(d.status)}</h2><div class="row noprint">${btn('bk', 'sales', 'sec')}${btn('pr', 'print', 'sec')}
    ${canW && d.kind === 'quote' && d.status === 'draft' ? btn('ed', 'edit', 'sec') + btn('st_sent', 'mark_sent') + btn('dl', 'delete', 'bad') : ''}
    ${canW && d.kind === 'quote' && d.status === 'sent' ? btn('st_accepted', 'mark_accepted') + btn('st_rejected', 'mark_rejected', 'bad') : ''}
    ${canW && d.kind === 'quote' && d.status === 'accepted' ? btn('to_order', 'to_order') : ''}
    ${canW && d.kind === 'order' && d.status === 'open' ? btn('ed', 'edit', 'sec') + (canI ? btn('to_inv', 'to_invoice') : '') + btn('cx', 'cancel', 'bad') : ''}
    ${d.invoice_id ? btn('go_inv', 'invoices', 'sec') : ''}</div></div><div id="msg"></div>
    <div class="card"><div class="grid"><div><label>${t('customer')}</label>${esc(d.customer_name)}</div><div><label>${t('date')}</label>${d.date}</div><div><label>${t('valid_until')}</label>${d.valid_until || '—'}</div></div></div>
    <div class="card"><table><thead><tr><th>${t('description')}</th><th>${t('qty')}</th><th>${t('unit_price')}</th><th>${t('tax_rate')}</th><th>${t('line_total')}</th></tr></thead><tbody>
    ${d.lines.map(l => { const n = Math.round(l.qty * l.unit_price); return `<tr><td>${esc(l.description)}</td><td>${l.qty}</td><td class="num">${fmt(l.unit_price)}</td><td>${l.tax_rate}</td><td class="num">${fmt(n + Math.round(n * l.tax_rate / 100))}</td></tr>`; }).join('')}</tbody></table>
    <p class="num">${t('subtotal')}: ${fmt(d.subtotal)} | ${t('tax')}: ${fmt(d.tax)} | <b>${t('total')}: ${fmt(d.total)}</b></p>${d.notes ? `<p>${esc(d.notes)}</p>` : ''}</div>`;
  const page = PAGES.find(p => p.id === 'sales');
  const on = (i, fn) => { const b = $('#' + i); if (b) b.onclick = async () => { try { await fn(); } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(errText(e))}</div>`; } }; };
  on('bk', () => page.render(el, d.kind)); on('pr', () => window.print());
  on('ed', () => invoiceForm(el, d, salesCfg(el, d.kind)));
  for (const s of ['sent', 'accepted', 'rejected']) on('st_' + s, async () => { await api('POST', `/api/sales/${id}/status`, { status: s }); salesView(el, id); });
  on('dl', async () => { if (confirm(t('confirm'))) { await api('DELETE', '/api/sales/' + id); page.render(el, d.kind); } });
  on('to_order', async () => { const r = await api('POST', `/api/sales/${id}/to-order`); salesView(el, r.id); });
  on('to_inv', async () => { const r = await api('POST', `/api/sales/${id}/to-invoice`); state.page = 'invoices'; const pg = PAGES.find(p => p.id === 'invoices'); invoiceView(el, r.invoice_id); });
  on('cx', async () => { if (confirm(t('confirm'))) { await api('POST', `/api/sales/${id}/cancel`); salesView(el, id); } });
  on('go_inv', () => invoiceView(el, d.invoice_id));
}

PAGES.push({ id: 'inventory', perm: 'inventory:read', async render(el) {
  const canW = can('inventory:write');
  const [{ items }, { items: whs }] = await Promise.all([api('GET', '/api/stock'), api('GET', '/api/warehouses')]);
  el.innerHTML = `<div class="top"><h2>${t('inventory')}</h2><div class="row"><button class="sec" id="mv">${t('movements')}</button></div></div><div id="msg"></div>
    ${canW ? `<div class="card noprint"><div class="grid"><div><label>${t('products')}</label><select id="sp">${items.map(p => `<option value="${p.id}">${esc(p.sku)} ${esc(p.name_ar)}</option>`).join('')}</select></div>
      <div><label>${t('warehouse_w')}</label><select id="sw">${whs.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div><label>${t('to_warehouse')}</label><select id="sw2">${whs.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
      <div><label>${t('qty')}</label><input id="sq" type="number" step="any" value="1"></div><div><label>${t('notes')}</label><input id="sn"></div></div>
      <div class="row" style="margin-top:10px"><button id="rc">${t('receive')}</button><button class="sec" id="ad">${t('adjust')}</button><button class="sec" id="tr">${t('transfer')}</button><input id="nw" placeholder="${t('new_warehouse')}" style="width:160px"><button class="sec" id="aw">${t('add')}</button></div></div>` : ''}
    <div class="card"><table><thead><tr><th>${t('sku')}</th><th>${t('name_ar')}</th>${whs.map(w => `<th>${esc(w.name)}</th>`).join('')}<th>${t('total')}</th><th>${t('reorder_level')}</th><th></th></tr></thead><tbody>
    ${items.map(p => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name_ar)}</td>${whs.map(w => `<td class="num">${p.by_warehouse[w.id] || 0}</td>`).join('')}<td class="num"><b>${p.total}</b></td><td class="num">${p.reorder_level}</td><td>${p.low ? `<span class="badge void">${t('low_stock')}</span>` : ''}</td></tr>`).join('') || `<tr><td colspan="9">${t('none')}</td></tr>`}</tbody></table></div><div id="mvl"></div>`;
  const refresh = () => PAGES.find(p => p.id === 'inventory').render(el);
  const act = (btn, fn) => { const b = $(btn); if (b) b.onclick = async () => { try { await fn(); refresh(); } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(errText(e))}</div>`; } }; };
  const base = () => ({ product_id: Number($('#sp').value), warehouse_id: Number($('#sw').value), qty: parseFloat($('#sq').value), note: $('#sn').value });
  act('#rc', () => api('POST', '/api/stock/receive', base()));
  act('#ad', () => api('POST', '/api/stock/adjust', base()));
  act('#tr', () => { const b = base(); return api('POST', '/api/stock/transfer', { product_id: b.product_id, from_warehouse_id: b.warehouse_id, to_warehouse_id: Number($('#sw2').value), qty: b.qty, note: b.note }); });
  act('#aw', () => api('POST', '/api/warehouses', { name: $('#nw').value }));
  $('#mv').onclick = async () => { const { items: m } = await api('GET', '/api/stock/moves'); $('#mvl').innerHTML = `<div class="card"><table><thead><tr><th>${t('date')}</th><th>${t('sku')}</th><th>${t('warehouse_w')}</th><th>${t('type')}</th><th>${t('qty')}</th><th>${t('notes')}</th></tr></thead><tbody>${m.map(x => `<tr><td>${x.date}</td><td>${esc(x.sku)}</td><td>${esc(x.warehouse)}</td><td>${t('mv_' + x.type)}</td><td class="num">${x.qty}</td><td>${esc(x.note || x.ref || '')}</td></tr>`).join('')}</tbody></table></div>`; };
} });

// ---- HR: employees, attendance, leave, payroll ----
PAGES.push({ id: 'hr', perm: 'hr:read', async render(el, tab = state.hrTab || 'employees') {
  state.hrTab = tab; const canW = can('hr:write'), page = PAGES.find(p => p.id === 'hr');
  const tabs = ['employees', 'attendance', 'leaves', 'payroll'].filter(x => x !== 'payroll' || can('payroll:read'));
  el.innerHTML = `<div class="top"><h2>${t('hr')}</h2><div class="row">${tabs.map(x => `<button class="${x === tab ? '' : 'sec'}" data-tab="${x}">${t('hr_' + x)}</button>`).join('')}</div></div><div id="msg"></div><div id="tab"></div>`;
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => page.render(el, b.dataset.tab));
  const T = $('#tab'), show = e => $('#msg').innerHTML = `<div class="err">${esc(errText(e))}</div>`, ok = () => $('#msg').innerHTML = `<div class="okmsg">${t('saved')}</div>`;
  const again = () => page.render(el, tab);
  const run = fn => async () => { try { await fn(); } catch (e) { show(e); } };
  const emps = (await api('GET', '/api/employees')).items, active = emps.filter(e => e.status === 'active');
  const empSel = id => `<select id="${id}">${active.map(e => `<option value="${e.id}">${esc(e.code)} ${esc(e.name)}</option>`).join('')}</select>`;
  if (tab === 'employees') {
    T.innerHTML = `${canW ? `<div class="card"><div class="grid"><div><label>${t('code')}</label><input id="ec"></div><div><label>${t('name')}</label><input id="en"></div><div><label>${t('job_title')}</label><input id="ej"></div><div><label>${t('department')}</label><input id="ed"></div>
      <div><label>${t('hire_date')}</label><input id="eh" type="date" value="${today()}"></div><div><label>${t('base_salary')}</label><input id="es" type="number" step="0.01"></div><div><label>${t('allowance')}</label><input id="ea" type="number" step="0.01" value="0"></div></div>
      <div style="margin-top:10px"><button id="eadd">${t('add')}</button></div></div>` : ''}
      <div class="card"><table><thead><tr><th>${t('code')}</th><th>${t('name')}</th><th>${t('job_title')}</th><th>${t('hire_date')}</th><th>${t('base_salary')}</th><th>${t('status')}</th></tr></thead><tbody>
      ${emps.map(e => `<tr><td>${esc(e.code)}</td><td>${esc(e.name)}</td><td>${esc(e.job_title || '')}</td><td>${e.hire_date}</td><td class="num">${fmt(e.base_salary)}</td><td>${t('emp_' + e.status)}${e.status === 'active' && canW ? ` <button class="sec" data-term="${e.id}">${t('terminate')}</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6">${t('none')}</td></tr>`}</tbody></table></div>`;
    if (canW) { $('#eadd').onclick = run(async () => { await api('POST', '/api/employees', { code: $('#ec').value, name: $('#en').value, job_title: $('#ej').value, department: $('#ed').value, hire_date: $('#eh').value, base_salary: toMinor($('#es').value), allowance: toMinor($('#ea').value) }); again(); });
      T.querySelectorAll('[data-term]').forEach(b => b.onclick = run(async () => { if (confirm(t('confirm'))) { await api('POST', `/api/employees/${b.dataset.term}/terminate`, { end_date: today() }); again(); } })); }
  } else if (tab === 'attendance') {
    const month = state.hrMonth || today().slice(0, 7); const { items } = await api('GET', '/api/attendance?month=' + month);
    T.innerHTML = `${canW ? `<div class="card"><div class="grid"><div><label>${t('hr_employees')}</label>${empSel('ae')}</div><div><label>${t('date')}</label><input id="ad" type="date" value="${today()}"></div>
      <div><label>${t('status')}</label><select id="as">${['present', 'late', 'absent', 'leave'].map(s => `<option value="${s}">${t('att_' + s)}</option>`).join('')}</select></div><div><label>${t('check_in')}</label><input id="ai" type="time"></div><div><label>${t('check_out')}</label><input id="ao" type="time"></div></div>
      <div style="margin-top:10px"><button id="asv">${t('save')}</button></div></div>` : ''}
      <div class="row" style="margin-bottom:8px"><label style="margin:0">${t('month')}</label><input id="am" type="month" value="${month}" style="width:170px"></div>
      <div class="card"><table><thead><tr><th>${t('date')}</th><th>${t('name')}</th><th>${t('status')}</th><th>${t('check_in')}</th><th>${t('check_out')}</th></tr></thead><tbody>${items.map(a => `<tr><td>${a.date}</td><td>${esc(a.name)}</td><td>${t('att_' + a.status)}</td><td>${a.check_in || ''}</td><td>${a.check_out || ''}</td></tr>`).join('') || `<tr><td colspan="5">${t('none')}</td></tr>`}</tbody></table></div>`;
    $('#am').onchange = () => { state.hrMonth = $('#am').value; again(); };
    if (canW) $('#asv').onclick = run(async () => { await api('POST', '/api/attendance', { employee_id: Number($('#ae').value), date: $('#ad').value, status: $('#as').value, check_in: $('#ai').value || null, check_out: $('#ao').value || null }); again(); });
  } else if (tab === 'leaves') {
    const { items } = await api('GET', '/api/leaves');
    T.innerHTML = `${canW ? `<div class="card"><div class="grid"><div><label>${t('hr_employees')}</label>${empSel('le')}</div><div><label>${t('type')}</label><select id="lt">${['annual', 'sick', 'unpaid'].map(s => `<option value="${s}">${t('lv_' + s)}</option>`).join('')}</select></div>
      <div><label>${t('from')}</label><input id="ls" type="date" value="${today()}"></div><div><label>${t('to')}</label><input id="lx" type="date" value="${today()}"></div></div><div style="margin-top:10px"><button id="lsv">${t('add')}</button></div></div>` : ''}
      <div class="card"><table><thead><tr><th>${t('name')}</th><th>${t('type')}</th><th>${t('from')}</th><th>${t('to')}</th><th>${t('days')}</th><th>${t('status')}</th></tr></thead><tbody>${items.map(l => `<tr><td>${esc(l.name)}</td><td>${t('lv_' + l.type)}</td><td>${l.start_date}</td><td>${l.end_date}</td><td>${l.days}</td><td>${t('lvs_' + l.status)}${l.status === 'pending' && canW ? ` <button data-d="approved" data-id="${l.id}">✓</button> <button class="bad" data-d="rejected" data-id="${l.id}">✗</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6">${t('none')}</td></tr>`}</tbody></table></div>`;
    if (canW) { $('#lsv').onclick = run(async () => { await api('POST', '/api/leaves', { employee_id: Number($('#le').value), type: $('#lt').value, start_date: $('#ls').value, end_date: $('#lx').value }); again(); });
      T.querySelectorAll('[data-d]').forEach(b => b.onclick = run(async () => { await api('POST', `/api/leaves/${b.dataset.id}/decision`, { status: b.dataset.d }); again(); })); }
  } else {
    const { items } = await api('GET', '/api/payroll'), cur = state.hrPayMonth || (items[0]?.month) || today().slice(0, 7);
    let detail = null; try { detail = await api('GET', '/api/payroll/' + cur); } catch { }
    const wp = can('payroll:write');
    T.innerHTML = `<div class="card"><div class="row"><label style="margin:0">${t('month')}</label><input id="pm" type="month" value="${cur}" style="width:170px">${wp ? `<button id="prun">${t('run_payroll')}</button>` : ''}${wp && detail && detail.status === 'draft' ? `<button class="bad" id="pfin">${t('finalize')}</button>` : ''}</div></div>
      ${detail ? `<div class="card"><h3>${esc(detail.month)} <span class="badge ${detail.status === 'finalized' ? 'paid' : 'issued'}">${t('pr_' + detail.status)}</span></h3><table><thead><tr><th>${t('name')}</th><th>${t('base_salary')}</th><th>${t('allowance')}</th><th>${t('unpaid_days')}</th><th>${t('deduction')}</th><th>${t('insurance')}</th><th>${t('net')}</th></tr></thead><tbody>
      ${detail.items.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${fmt(i.base)}</td><td class="num">${fmt(i.allowance)}</td><td>${i.unpaid_days}</td><td class="num">${fmt(i.deduction)}</td><td class="num">${fmt(i.insurance)}</td><td class="num"><b>${fmt(i.net)}</b></td></tr>`).join('')}</tbody></table><p class="num"><b>${t('total')}: ${fmt(detail.total_net)}</b></p></div>` : `<div class="card">${t('none')}</div>`}`;
    $('#pm').onchange = () => { state.hrPayMonth = $('#pm').value; again(); };
    if (wp) { $('#prun').onclick = run(async () => { state.hrPayMonth = $('#pm').value; await api('POST', '/api/payroll/run', { month: $('#pm').value }); again(); });
      const f = $('#pfin'); if (f) f.onclick = run(async () => { if (confirm(t('confirm'))) { await api('POST', `/api/payroll/${cur}/finalize`); again(); } }); }
  }
} });

// ---- roles and permissions editor ----
PAGES.push({ id: 'roles', perm: 'roles:read', async render(el) {
  const { items, catalog } = await api('GET', '/api/roles-admin'), canW = can('roles:write'), page = PAGES.find(p => p.id === 'roles');
  const mods = Object.keys(catalog), show = e => $('#msg').innerHTML = `<div class="err">${esc(errText(e))}</div>`;
  const cell = (r, m, a) => { const on = r.perms.includes('*') || r.perms.includes(m + ':' + a) || r.perms.includes(m + ':*'); return `<td style="text-align:center"><input type="checkbox" style="width:auto" data-r="${r.name}" data-p="${m}:${a}" ${on ? 'checked' : ''} ${r.fixed || !canW ? 'disabled' : ''}></td>`; };
  el.innerHTML = `<div class="top"><h2>${t('roles')}</h2></div><div id="msg"></div>
    ${canW ? `<div class="card"><div class="row"><input id="rn" placeholder="${t('role_name_hint')}" style="width:220px"><button id="radd">${t('add')}</button></div></div>` : ''}
    <div class="card"><table><thead><tr><th>${t('role')}</th><th>${t('users')}</th>${mods.map(m => catalog[m].map(a => `<th title="${m}:${a}">${t(m)} ${a === 'read' ? '👁' : '✎'}</th>`).join('')).join('')}<th></th></tr></thead><tbody>
    ${items.map(r => `<tr><td><b>${esc(t(r.name))}</b>${r.fixed ? ' 🔒' : ''}</td><td>${r.users}</td>${mods.map(m => catalog[m].map(a => cell(r, m, a)).join('')).join('')}<td>${canW && !r.fixed ? `<button data-save="${r.name}">${t('save')}</button> <button class="sec" data-del="${r.name}">${r.builtin ? t('reset') : t('delete')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  const run = fn => async () => { try { await fn(); } catch (e) { show(e); } };
  if (canW) {
    $('#radd').onclick = run(async () => { await api('POST', '/api/roles-admin', { name: $('#rn').value.trim(), perms: [] }); page.render(el); });
    el.querySelectorAll('[data-save]').forEach(b => b.onclick = run(async () => {
      const perms = [...el.querySelectorAll(`[data-r="${b.dataset.save}"]:checked`)].map(i => i.dataset.p);
      await api('PUT', '/api/roles-admin/' + b.dataset.save, { perms }); state.roles = null; page.render(el); }));
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = run(async () => { if (confirm(t('confirm'))) { await api('DELETE', '/api/roles-admin/' + b.dataset.del); page.render(el); } }));
  }
} });

// ---- reports ----
PAGES.push({ id: 'reports', perm: 'reports:read', async render(el) {
  const to = state.rTo || today(), from = state.rFrom || to.slice(0, 4) + '-01-01';
  const [sales, aging] = await Promise.all([api('GET', `/api/reports/sales?from=${from}&to=${to}`), api('GET', '/api/reports/aging')]);
  const stock = can('inventory:read') ? await api('GET', '/api/reports/stock-value') : null;
  const pay = can('payroll:read') ? await api('GET', '/api/reports/payroll') : null;
  const B = aging.buckets, csv = (p, q = '') => `<a class="btn noprint" href="/api/reports/${p}?${q}format=csv" style="text-decoration:none;font-size:13px">CSV</a>`;
  el.innerHTML = `<div class="top"><h2>${t('reports')}</h2><div class="row noprint"><label style="margin:0">${t('from')}</label><input id="rf" type="date" value="${from}" style="width:150px"><label style="margin:0">${t('to')}</label><input id="rt" type="date" value="${to}" style="width:150px"><button id="rg">${t('search')}</button></div></div>
    <div class="card"><div class="row"><h3 class="sp">${t('rep_sales')}</h3>${csv('sales', `from=${from}&to=${to}&`)}</div><table><thead><tr><th>${t('month')}</th><th>${t('invoices')}</th><th>${t('subtotal')}</th><th>${t('tax')}</th><th>${t('total')}</th></tr></thead><tbody>
    ${sales.months.map(m => `<tr><td>${m.month}</td><td>${m.invoices}</td><td class="num">${fmt(m.subtotal)}</td><td class="num">${fmt(m.tax)}</td><td class="num">${fmt(m.total)}</td></tr>`).join('') || `<tr><td colspan="5">${t('none')}</td></tr>`}
    <tr><td><b>${t('total')}</b></td><td><b>${sales.totals.invoices}</b></td><td class="num"><b>${fmt(sales.totals.subtotal)}</b></td><td class="num"><b>${fmt(sales.totals.tax)}</b></td><td class="num"><b>${fmt(sales.totals.total)}</b></td></tr></tbody></table></div>
    <div class="grid"><div class="card"><h3>${t('top_customers')}</h3><table><tbody>${sales.customers.map(c => `<tr><td>${esc(c.name)}</td><td class="num">${fmt(c.total)}</td></tr>`).join('') || `<tr><td>${t('none')}</td></tr>`}</tbody></table></div>
    <div class="card"><h3>${t('top_products')}</h3><table><tbody>${sales.products.map(p => `<tr><td>${esc(p.description)}</td><td>${p.qty}</td><td class="num">${fmt(p.revenue)}</td></tr>`).join('') || `<tr><td>${t('none')}</td></tr>`}</tbody></table></div></div>
    <div class="card"><div class="row"><h3 class="sp">${t('rep_aging')}</h3>${csv('aging')}</div><table><thead><tr><th>${t('age_current')}</th><th>1-30</th><th>31-60</th><th>61-90</th><th>90+</th><th>${t('total')}</th></tr></thead><tbody><tr>${[B.current, B.d1_30, B.d31_60, B.d61_90, B.d90_plus, aging.total].map(x => `<td class="num">${fmt(x)}</td>`).join('')}</tr></tbody></table></div>
    ${stock ? `<div class="card"><div class="row"><h3 class="sp">${t('rep_stock')}: <span class="num">${fmt(stock.total)}</span></h3>${csv('stock-value')}</div></div>` : ''}
    ${pay ? `<div class="card"><div class="row"><h3 class="sp">${t('rep_payroll')}</h3>${csv('payroll')}</div><table><thead><tr><th>${t('month')}</th><th>${t('hr_employees')}</th><th>${t('deduction')}</th><th>${t('insurance')}</th><th>${t('net')}</th></tr></thead><tbody>${pay.items.map(r => `<tr><td>${r.month}</td><td>${r.employees}</td><td class="num">${fmt(r.deductions)}</td><td class="num">${fmt(r.insurance)}</td><td class="num">${fmt(r.net)}</td></tr>`).join('') || `<tr><td colspan="5">${t('none')}</td></tr>`}</tbody></table></div>` : ''}`;
  $('#rg').onclick = () => { state.rFrom = $('#rf').value; state.rTo = $('#rt').value; PAGES.find(p => p.id === 'reports').render(el); };
} });

PAGES.push({ id: 'users', perm: 'users:read', async render(el) {
  const { items, roles } = await api('GET', '/api/users');
  el.innerHTML = `<div class="top"><h2>${t('users')}</h2></div><div id="msg"></div><div class="card"><div class="grid"><div><label>${t('username')}</label><input id="nu"></div><div><label>${t('name')}</label><input id="nn"></div><div><label>${t('password')}</label><input id="np" type="password"></div>
    <div><label>${t('role')}</label><select id="nr">${roles.map(r => `<option value="${r}">${t(r)}</option>`).join('')}</select></div></div><div style="margin-top:10px"><button id="ad">${t('add')}</button></div></div>
    <div class="card"><table><thead><tr><th>${t('username')}</th><th>${t('name')}</th><th>${t('role')}</th><th>${t('active')}</th><th></th></tr></thead><tbody>${items.map(u => `<tr><td>${esc(u.username)}</td><td>${esc(u.name)}</td><td>${t(u.role)}</td><td>${u.active ? '✓' : ''}</td><td>${u.id !== state.user.id ? `<button class="sec" data-t="${u.id}" data-a="${u.active ? 0 : 1}">${u.active ? '⏸' : '▶'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  $('#ad').onclick = async () => { try { await api('POST', '/api/users', { username: $('#nu').value, name: $('#nn').value, password: $('#np').value, role: $('#nr').value }); PAGES.find(p => p.id === 'users').render(el); } catch (e) { $('#msg').innerHTML = `<div class="err">${esc(errText(e))}</div>`; } };
  el.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => { await api('PUT', '/api/users/' + b.dataset.t, { active: Number(b.dataset.a) }); PAGES.find(p => p.id === 'users').render(el); });
} });
PAGES.push({ id: 'settings', perm: 'settings:read', async render(el) {
  const s = await api('GET', '/api/settings');
  el.innerHTML = `<div class="top"><h2>${t('settings')}</h2></div><div id="msg"></div><div class="card"><div class="grid"><div><label>${t('company_name')}</label><input id="cn" value="${esc(s.company_name)}"></div><div><label>${t('currency')}</label><input id="cc" value="${esc(s.currency)}"></div><div><label>${t('default_tax')}</label><input id="ct" type="number" value="${s.default_tax}"></div><div><label>${t('annual_leave_days')}</label><input id="cl" type="number" value="${s.annual_leave_days}"></div><div><label>${t('insurance_pct')}</label><input id="ci" type="number" step="any" value="${s.insurance_pct}"></div></div>
    <div style="margin-top:10px"><button id="sv">${t('save')}</button></div></div>`;
  $('#sv').onclick = async () => { await api('PUT', '/api/settings', { company_name: $('#cn').value, currency: $('#cc').value, default_tax: $('#ct').value, annual_leave_days: $('#cl').value, insurance_pct: $('#ci').value }); state.settings = await api('GET', '/api/me'); $('#msg').innerHTML = `<div class="okmsg">${t('saved')}</div>`; };
} });
setLang(lang);
