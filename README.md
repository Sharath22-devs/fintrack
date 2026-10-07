# FINTRACK · Netlify edition 2.0

Personal Financial Management & Ledger System. Responsive React interface, native Netlify Functions, persistent relational PostgreSQL database, and a transaction-backed financial engine.

**Start with [NETLIFY-DEPLOY.md](NETLIFY-DEPLOY.md).** This source package is ready to configure and deploy; it is not an already hosted site. A PostgreSQL connection URL is required. No separately hosted API server is required.

## Financial correctness

- Immutable double-entry journals in integer paise, user-scoped financial data, atomic mutations and user-row locking.
- Transfers, lending, borrowing, settlements and adjustments remain distinct from income/expenses.
- Receivables/payables preserve original amounts and every partial settlement; over-settlement is rejected.
- Corrections append reversals/new records. No silent financial overwrites or hard deletion of posted journals.
- Repeatable-read snapshots prevent inconsistent multi-query dashboards during concurrent writes.
- Relational accounts, transactions, postings, claims, settlements, categories, people, budgets, goals, recurring templates, attachments, reconciliation, monthly closing and hash-linked append-only audit history.

## Included interface and workflows

Login/register/reset/logout, dashboard, accounts, searchable paginated ledger and quick-add review, receivables/payables and aging, personal ledgers, budgets, savings allocations backed by transfers, calendar/recurring schedules/subscriptions, analytics, cash-flow forecast/what-if simulation, reports and closing, notifications, settings/import/backup/audit, profile and assistant.

Light/dark themes, mobile bottom navigation and quick-add, accessible labels/focus treatment, validation, confirmation dialogs and toasts. Dashboard totals/charts and financial health explanations use stored records. New users start empty; optional demo workspaces contain explicitly labeled sample journals.

CSV/XLSX preview import and PDF/XLSX/CSV export run in Node, without Python. Attachments are private PostgreSQL BYTEA records, not ephemeral function files. Local natural-language parsing and read-only assistant queries work without API keys. Optional generative AI and reset-email delivery need provider credentials.

## Local use (Windows, macOS or Linux)

Requires Node 22+ and managed/local PostgreSQL. From this folder:

```sh
npm ci
```

Copy `.env.example` to `.env` (Windows: `copy .env.example .env`; macOS/Linux: `cp .env.example .env`). Replace the example `DATABASE_URL` with your connection string. Then:

```sh
npm run db:migrate
npm run build
npm start
```

Open `http://localhost:3000`. Path handling uses `fileURLToPath`, including Windows drive paths. Do not use the old `server.mjs` file. `.env` is ignored by Git. The local listener is only a development convenience; Netlify uses `netlify/functions/api.mjs`.

## Tests

```sh
npm test
npm run functions:check
```

Tests execute SQL against the real PostgreSQL-compatible PGlite engine, not mocked financial queries. They cover journal invariants, isolation, authorization, CSRF, authentication throttling, settlements, reconciliation, closing, import/export, restore, private attachments and serverless routing. The function bundle check uses Netlify's official bundler and checks both functions.

For a test-only temporary preview: `npm run build && npm run preview:test`. This uses an in-memory PostgreSQL engine on port 3002 and **loses data when stopped**. It is not the production database. With that preview running, `npm run test:browser` checks desktop/mobile routes and screenshots. Set `CHROMIUM_EXECUTABLE` to a Chromium path on your machine. See `TEST-RESULTS.txt` for package validation.

## Structure

- `src/` — React application and responsive styles
- `public/` — compiled frontend and entry HTML
- `api/` — authenticated handler, ledger, SQL schema, reporting/imports
- `netlify/functions/` — API and scheduled cleanup entries
- `scripts/` — frontend build, migration, local server, function validation
- `tests/` — accounting, API, deployment and browser tests
- `netlify.toml` — build, API rewrites, SPA fallback and security headers

## Security and operations

Scrypt password hashing, hashed session/reset tokens, HTTP-only SameSite cookies (Secure in production), same-origin/CSRF protections, parameterized SQL, durable throttling and per-user authorization. PostgreSQL access stays server-side. Financial history is append-only through database triggers; administrators still control the database, so this is not an externally notarized audit system.

Provider-managed database backups, monitored hosting, reset-email service, real-provider deployment smoke tests and an independent security review remain operator responsibilities. Limits, migration instructions and environment variables are in NETLIFY-DEPLOY.md. FINTRACK does not connect to banks or move actual money; it records and analyzes your ledger.
