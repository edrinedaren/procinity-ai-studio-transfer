# Procinity: full-stack Cloudflare Worker (Worker + Static Assets + D1)

## Which deployment method is this?
**A Cloudflare Worker deployed with Wrangler (`wrangler deploy`), usually run for you by Cloudflare "Workers Builds" when you connect a GitHub repository.**

- It is a **real Worker**: `wrangler.toml` points `main` at `src/index.js`, the backend code.
- The website lives in `public/` and is attached with the supported **Workers Static Assets** setting (`[assets]`).
- Because the Worker has real code, you **can** add bindings (D1, variables, secrets) to it.
- It is **not** a Pages project, **not** the drag-and-drop upload, and **not** a static-assets-only Worker.

## How requests are handled
| Request | Who answers |
|---|---|
| `/api/*` | `src/index.js` (accounts, sessions, passkeys, saved state) |
| everything else (pages, photos, icons, `auth.js`) | Cloudflare serves the files in `public/` directly. The Worker does not run, so these do not count against the Worker request quota |
| unknown page address | the app (`index.html`), because it is a single-page app |

## What is in this folder
```
wrangler.toml     Worker settings: entry point, assets folder, D1 binding "DB"
package.json      lets Cloudflare install Wrangler
schema.sql        database tables (already run in your D1 database "procinity")
src/index.js      the Worker: registration, login, password hashing, sessions,
                  passkeys, password reset, rate limiting, saved state
public/           your Procinity frontend, unchanged (index.html, auth.js, sw.js,
                  manifest, icons/, images/, _headers)
```
`schema.sql` and the setup notes are outside `public/`, so visitors cannot download them.

## The one thing you must edit
Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with the real ID
(Cloudflare dashboard > Storage & databases > D1 SQL database > procinity > Database ID).
Also make sure `name = "procinity"` is exactly the name of your Worker.

## Variables and secrets (optional, set in the dashboard)
Worker > Settings > Variables and Secrets:
- `GOOGLE_CLIENT_ID` (variable) for the Google button
- `RESEND_API_KEY` (secret) and `MAIL_FROM` (variable, like `Procinity <no-reply@yourdomain.com>`) for password-reset emails

`keep_vars = true` in `wrangler.toml` stops deploys from deleting variables you set in the dashboard.

## Good to know
- Passkeys and Google sign-in are tied to the web address. If the address changes (different Worker name or a custom domain), people must register passkeys again, and the new address must be added in your Google OAuth settings.
- Deploy from a computer with: `npm install` then `npx wrangler deploy`.
