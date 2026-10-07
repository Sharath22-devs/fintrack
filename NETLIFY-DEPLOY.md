# Launch FINTRACK on Netlify

This is the native Netlify edition, not the old `server.mjs`/SQLite package. The frontend and API deploy together to Netlify. Persistent financial data lives in PostgreSQL, not a function's temporary filesystem. No separately hosted Node server or Python installation is required.

## 1. Create the database

Create a managed PostgreSQL database, for example on Neon or another PostgreSQL provider. Copy the provider's **pooled connection string with TLS enabled**. It normally starts with `postgresql://` and includes `sslmode=require`.

Keep this URL private: it contains your database password. Choose a database region reasonably close to your Netlify function region. Use a dedicated database for this app.

## 2. Put the app in GitHub

Unzip the package. Upload the contents of the `fintrack-netlify` folder to a GitHub repository. The repository root should contain `package.json`, `netlify.toml`, `api/`, `public/` and `netlify/functions/`.

Do **not** upload `node_modules` or `.env`. Do **not** drag just the `public` folder into Netlify: that deploys only the frontend, not the required API functions.

## 3. Import the repository in Netlify

In Netlify, choose **Add new project / Import an existing project**, select GitHub, then the repository. Leave the base directory empty if the app files are at repository root. If you uploaded the enclosing folder instead, set base directory to `fintrack-netlify`.

`netlify.toml` supplies these settings:

| Setting | Value |
| --- | --- |
| Build command | `npm run db:migrate && npm run build` |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |
| Build Node version | `22` |

## 4. Add server-side environment variables BEFORE the successful build

In project configuration → environment variables, add:

| Variable | Required? | Scope / use |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | **Builds and Functions**; secret PostgreSQL connection URL |
| `APP_ORIGIN` | Recommended | Functions; your exact HTTPS site origin, with no trailing slash |
| `ENABLE_DEMO` | No | Functions; `true` enables private seeded demo workspaces. Default disabled |
| `OPENAI_API_KEY` | No | Functions; enables optional generative AI mode |
| `OPENAI_MODEL` | No | Functions; defaults to `gpt-4.1-mini` |
| `RESET_DELIVERY_URL` | For password-reset delivery | Functions; HTTPS webhook to your email delivery service |
| `RESET_DELIVERY_SECRET` | Recommended with webhook | Functions; bearer secret for that service |

For first deployment, you may leave `APP_ORIGIN` unset; the app uses the request origin. After receiving the site URL, set it to `https://YOUR-SITE.netlify.app` (or your custom domain) and redeploy.

Never expose these values in `public/`, React environment variables or Git. Do not set `DEV_SHOW_RESET` in production.

Use **Production** deployment context for production secrets. Disable deploy previews or give previews a separate database and matching origin. Do not point untrusted preview code at production financial records.

## 5. Deploy and verify

Trigger deployment. The build applies the versioned PostgreSQL schema transactionally, then builds React and bundles functions. Migration failure stops deployment rather than serving a broken financial app.

After deployment:

1. Open the site and create a new account. New accounts start empty.
2. Create an account and an opening balance; post an income, an expense and a transfer.
3. Confirm that a transfer changes account balances but not income or expenses.
4. Create a receivable, record a partial receipt and verify the remaining amount.
5. Refresh and sign in again to verify database persistence.
6. Test CSV, Excel and PDF export; test reset delivery if configured.
7. Review Netlify function logs and your database provider's metrics.

`/api/config` is a public non-secret configuration check. Netlify should list the `api` function and the scheduled `maintenance` function. Scheduled cleanup removes expired sessions, reset tokens and rate-limit entries; it does not delete financial records or post recurring payments.

## Password-reset delivery contract

FINTRACK sends an HTTPS POST to `RESET_DELIVERY_URL`, with `Authorization: Bearer <RESET_DELIVERY_SECRET>` and JSON containing `email`, `reset_url` and `expires_in_minutes`. Your email service must deliver the link and return a successful status. Tokens are stored hashed, expire and are single-use. Without a configured delivery service, production reset delivery reports a configuration error; it does not pretend an email was sent.

## Moving from the Windows/SQLite edition

Keep the old app's data safe. In the old app, download a full FINTRACK backup. In the new app, register an **empty** workspace, then Settings → Import & backup → review and restore the backup. Original transaction IDs, relationships, attachments and financial history are restored. Never replace or delete the old database until totals and history have been verified. Large backups may exceed function limits and require a controlled server-side migration rather than browser restore.

## Practical limits and production responsibilities

- Single base currency INR; amounts are integer paise. No invented exchange rates.
- Maximum attachment/import file: 2 MB. Import: up to 10,000 rows and 100 columns; preview before commit.
- Request and response safety limit: 4 MB. Browser backup restore: 3 MB. Limit export date ranges if necessary; PDF/XLSX exports are capped at 10,000 rows.
- Durable data and attachment storage are in PostgreSQL. **There are no local SQLite snapshots in this edition.** Enable provider-managed backups / point-in-time recovery, encrypted off-site storage and a tested recovery procedure. Downloaded JSON backups contain sensitive, unencrypted data.
- The optional AI provider receives the financial context requested by that feature. Local query mode works without an AI key and is clearly labeled, not fake generative AI.
- Recurring templates forecast future occurrences; actual posting requires the explicit post action. The scheduler is cleanup only.
- Netlify/database/email/AI services may have usage charges and plan limits. Select appropriate plans and configure monitoring. This package is tested locally, not independently security-audited or deployed to your account.

## Troubleshooting

**Build says DATABASE_URL missing:** add it to both Builds and Functions, then redeploy.

**Database connection or TLS error:** use the provider's exact pooled URL, check credentials and network access, and keep TLS enabled. URL-encode special password characters if assembling a URI manually.

**Frontend opens, API returns 404:** deploy the repository with `netlify.toml`, not a static-folder drag-and-drop. Check base directory and Functions listing.

**Requests rejected as cross-origin:** `APP_ORIGIN` must exactly match the visible site's HTTPS origin. Redeploy after changing it. Use a separate origin/database for previews.

**Export too large:** reduce the report date range. Do not remove serverless size guards to work around platform limits.

**Original Windows C:\\C:\\ error:** use this package's `npm start`. It uses `fileURLToPath` and works with Windows drive paths; the old server file is not used.
