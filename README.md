# Open ERP Lite

An Arabic-first ERP for **small and mid-size companies**, built module by module. Arabic (RTL) and English UI, a real HTTP API, a real SQLite database. No build step and **zero npm dependencies** (Node 22.5+).

## What this is, honestly

This is a generic, configurable ERP core for a small business. It is **not** a replacement for SAP, Oracle or Odoo. It has no country tax packs, no bank or e-invoicing integrations, no multi-company, no manufacturing, and it has not been load tested beyond a single small company on one server. Treat it as a solid starting point you can adapt to a real client, not a finished product.

## Modules and status

| # | Module | Status |
|---|--------|--------|
| 1 | Core (login, roles, users, settings, audit log), Customers, Products, **Invoices** (draft, issue, payments, void, receivables) | Done, tested |
| 2 | **Inventory**: warehouses, receive / adjust / transfer, stock derived from movements, stock deducted when an invoice is issued (blocked if not enough), returned on void, low-stock flag | Done, tested |
| 3 | **Sales**: quotes (draft, sent, accepted or rejected), accepted quote to sales order, order to draft invoice (stock moves when that invoice is issued) | Done, tested |
| 4 | **HR**: employees (terminate, never delete), attendance, leave with balances and approval, monthly payroll (unpaid days, insurance %, partial months, finalize and lock) | Done, tested |
| 5 | **Roles and permissions editor**: custom roles, per-module read/write checkboxes, saved in the database, effective on the next request, admin role fixed | Done, tested |
| 6 | **Reports**: sales by month, top customers and products, receivables ageing, stock value at cost, payroll cost, CSV export | Done, tested |

Each module was added only after the previous one passed its tests. All six planned modules are done. What is still missing for real production use is listed under "Not included" below.

## Not included (be aware before using it for a client)

Purchasing and suppliers, a general ledger and chart of accounts, multi-currency, bank reconciliation, country tax and e-invoice formats (for example the Egyptian e-invoice portal), multi-branch accounting, file attachments, email sending, backups (copy the `erp.db` file), HTTPS (put it behind a reverse proxy), and any load testing. Sessions and the role map live in a single process, so run one instance.

## Run it

```bash
node server.js
# first run prints:  First run. Login: admin / <generated password>
```

Options (environment variables): `PORT` (default 3000), `DB_FILE` (default `erp.db`), `ADMIN_PASSWORD` (sets the first admin password instead of generating one).

Open http://localhost:3000 . Use the language button in the sidebar to switch Arabic / English (the layout flips RTL / LTR).

## Test

```bash
npm test
```

Tests start the real server on a random port with an in-memory database and call the HTTP API.

## Design notes

- **Money** is stored and sent as integer minor units (piasters or cents). Totals are always recomputed on the server from the lines.
- **Invoices**: draft invoices are editable. Issuing assigns a gapless number (`INV-000001`) and locks the invoice. Issued invoices are never deleted, only voided (and only if unpaid). Payments cannot exceed the balance.
- **Auth**: passwords hashed with scrypt, random session tokens in an HttpOnly cookie, role based permissions (`module:action`) checked on every API route.
- **Hardening**: login lockout after 8 failed attempts (15 min), security headers, the static server only serves the four UI files (never source or the database), CSV export neutralises spreadsheet formulas.
- **Audit log** records logins and every create, update, issue, payment and void.
- **Inventory**: stock on hand is never stored, it is the sum of signed movements, so history and balance cannot drift. Issuing an invoice deducts from the default warehouse in the same transaction: if any line is short, the whole issue fails and no invoice number is used. Voiding returns the stock.
- **Payroll** (deliberately simple and configurable, not a country payroll pack): net = base + allowance - base/30 x unpaid days - insurance% of base. Unpaid days are distinct calendar days that are absent or inside an approved unpaid leave, so a day is never deducted twice. Mid-month joiners and leavers are paid on a 30-day basis for the days employed. There is no income tax, overtime or social-insurance tables: add the rules your country needs before using it for real salaries.
- **Hooks**: later modules plug into invoice issue and void (for example stock deduction) without changing the invoice code.
- **Layout**: all files sit in the repo root on purpose, to keep the project easy to read and to copy. `http.js` is the tiny router, `db.js` the schema, one file per module, `ui.js` the browser app, `i18n.js` all Arabic and English text.

## License

MIT
