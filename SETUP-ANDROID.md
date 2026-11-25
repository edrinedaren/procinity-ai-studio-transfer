# Deploy Procinity from an Android phone (GitHub + Cloudflare Workers)

Use Chrome. For the Cloudflare and GitHub pages, tap the three dots and tick **Desktop site**.
You need: a free GitHub account, your Cloudflare account, and the D1 database `procinity`
with its tables already created (if not, open the database > Console and run `schema.sql`).

## 1. Copy your D1 Database ID
Cloudflare > Storage & databases > D1 SQL database > `procinity`. Copy the **Database ID**
(a long code like `a1b2c3d4-...`). Keep it for step 4.

## 2. Unzip the upload kit
Open **procinity-phone-upload-kit.zip** in the Files app, tap Extract. You get numbered folders 1 to 6.

## 3. Create the GitHub repository and upload the files
1. github.com > **+** > **New repository**. Name: `procinity`. Choose **Private**.
   **Tick "Add a README file"** (this matters) > **Create repository**.
2. Do these uploads **in order**. For each one, open the web address (replace `YOURNAME` with your
   GitHub username), tap **choose your files**, open the numbered folder, tap **Select all**,
   wait for the files to finish loading, then **Commit changes**.

| # | Open this address | Upload everything from |
|---|---|---|
| 1 | `github.com/YOURNAME/procinity/upload/main` | folder `1-repo-root` |
| 2 | `github.com/YOURNAME/procinity/upload/main/src` | folder `2-src` |
| 3 | `github.com/YOURNAME/procinity/upload/main/public` | folder `3-public` |
| 4 | `github.com/YOURNAME/procinity/upload/main/public/icons` | folder `4-icons` |
| 5 | `github.com/YOURNAME/procinity/upload/main/public/images` | folder `5-images-A` |
| 6 | `github.com/YOURNAME/procinity/upload/main/public/images` | folder `6-images-B` |

GitHub accepts at most 100 files per upload, which is why the photos are split into A and B.
If an address says "not found", tap **Add file > Create new file**, type a name like
`src/placeholder.txt` (the slash creates the folder), commit, then try the address again.

## 4. Put your Database ID in wrangler.toml
In the repository tap `wrangler.toml` > the pencil icon. Replace
`REPLACE_WITH_YOUR_D1_DATABASE_ID` with your real ID (keep the quotes). Tap **Commit changes**.

## 5. Connect the repository to Cloudflare
1. Cloudflare dashboard > **Workers & Pages** > **Create** > **Import a repository** (Workers).
2. Connect GitHub, choose `procinity`.
3. Project / Worker name: `procinity`. It must match `name` in `wrangler.toml`.
   (If your existing Worker has a different name, either change `name` in `wrangler.toml` to
   that exact name, or use `procinity` and delete the old static-only Worker later.)
4. Leave the build command empty. Deploy command: `npx wrangler deploy`. Tap **Save and Deploy**.
5. Wait for the build to finish. Open the `.workers.dev` link it gives you.

## 6. Add your variables (only if you use them)
Worker > **Settings** > **Variables and Secrets**: add `GOOGLE_CLIENT_ID`, `RESEND_API_KEY`
(as a Secret) and `MAIL_FROM`. Tap **Deploy** after saving.

## 7. Check it works
- `YOUR-LINK.workers.dev/api/config` shows a short line of text starting with `{`.
- The app opens and you can create an account and sign in.
- Worker > **Settings** > **Bindings** lists `DB` (D1) and `ASSETS`.

## Updating later
Edit or upload files in GitHub. Every change deploys automatically in about a minute.

## If something fails
- **Build says database_id invalid / not found**: step 4 was skipped or the ID has a typo.
- **Build says the name does not match**: make `name` in `wrangler.toml` identical to the Worker's name.
- **Page works but sign-in says the database is not connected**: the build did not finish; check the build log.
- **A photo is missing**: one of the image uploads (5 or 6) did not finish. Repeat it.
