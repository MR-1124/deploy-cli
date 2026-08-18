# Real-account smoke test

The mock-API test suites verify **what the CLI sends**. `npm run smoke` verifies
**what the hosts actually return** — the one gap mocks can't close. It deploys a
tiny two-file site to each host you select, fetches the returned URL, asserts the
content actually serves, and (where supported) rolls back.

> Credentials come from environment variables first, then fall back to the
> `deploy login` config (`~/.deploy-cli/config.json`) — so logging in once per
> machine makes every later `npm run smoke` work in any shell. The script never
> writes to the config — nothing gets persisted.

## Requirements

- Node ≥ 18
- One or more of the credentials below

## Credentials

| Provider | Env vars | Where to get them |
|---|---|---|
| Netlify | `NETLIFY_AUTH_TOKEN` · optional `SMOKE_SITE` | app.netlify.com → User settings → Applications → Personal access tokens |
| Vercel | `VERCEL_TOKEN` · optional `SMOKE_VERCEL_PROJECT` | vercel.com/account/tokens |
| Cloudflare | `CLOUDFLARE_API_TOKEN` **and** `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → My Profile → API Tokens (**Pages:Edit** permission); account ID on the dashboard overview |
| S3 | `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY` · `SMOKE_S3_BUCKET` · optional `AWS_REGION` (default `us-east-1`) | IAM user with PutObject on the bucket |

`SMOKE_SITE` / `SMOKE_VERCEL_PROJECT` let you pin a site/project name. The
defaults are fresh timestamped names (Netlify sites and Vercel projects
auto-create on first use) — a fresh Vercel project per run keeps the leg
hermetic, so a shared project's accumulated alias history or Deployment
Protection settings can't interfere. A bare `npm run smoke` prints which env
vars (or `deploy login` commands) are missing for each provider.

Prefer `deploy login --provider netlify --token <PAT>` (and the equivalent for
vercel/cloudflare/s3) once per machine — the smoke picks those up
automatically, so you never paste tokens into a shell again.

## Running

```bash
# all four providers
npm run smoke

# or pick specific ones
npm run smoke -- netlify vercel
node scripts/smoke-real.mjs s3
```

A provider without credentials is skipped (exit stays 0). A provider that
**fails** prints `✖ <provider>: <reason>` and the script exits non-zero.

## What each leg verifies

| Provider | Upload path | Content check | Rollback check |
|---|---|---|---|
| Netlify | digest upload (sha1 per file) | fetches the returned URL until it serves `smoke-ok` | `POST .../restore` accepted |
| Vercel | SHA1 file uploads (`/v2/files`) + manifest | deployment URL serves `smoke-ok` / `smoke-v2` (authoritative that files attached), then the production alias after rollback | deploys twice, rolls back to the first (Vercel 422s if you roll back to the already-live deploy) |
| Cloudflare | Pages direct upload | same, against the `pages.dev` URL | n/a — no rollback API, reported as such |
| S3 | SigV4-signed PutObject | fetches the object via the path-style URL | n/a — plain S3 has no rollback |

New sites can take 5–30 s after the API reports ready for DNS/SSL/edge to
propagate, so the content check retries with backoff instead of failing on the
first 404/522.

**Vercel Deployment Protection gotcha:** new Vercel projects have Vercel
Authentication **enabled by default** — anonymous visitors get redirected to
`vercel.com/login` with HTTP 200 (that's the misleading "expected content
missing" you'd otherwise see, since the logged-in browser shows the files
fine). The smoke automatically disables it on its project
(`PATCH /v9/projects/{id}` with `ssoProtection: null`), and the check names it
explicitly if it ever still trips. If you pin `SMOKE_VERCEL_PROJECT`, the same
disable call is applied to your pinned project.

## Setting up credentials (mistake-proof, least privilege)

### Cloudflare

1. Sign in at dash.cloudflare.com → **My Profile** (top-right avatar) → **API Tokens** → **Create Token** → **Create Custom Token**.
2. Set the permissions exactly:
   - **Permissions**: `Cloudflare Pages` → `Edit`
   - **Account Resources**: Include → **All accounts** (required: the smoke auto-creates `smoke-<timestamp>` projects, so a single-project scope won't work)
   - **Zone Resources**: leave at default / *All zones* (Pages is account-level; no zone permission is needed)
   - **Continue** → **Create Token**.
3. Copy the token — it is shown **once**.
4. Get your **Account ID**: the right sidebar of any dashboard page (under the account switcher), or run the verification below.
5. Verify the token before saving it anywhere:
   ```bash
   curl -s "https://api.cloudflare.com/client/v4/accounts" -H "Authorization: Bearer <TOKEN>"
   ```
   Expect `"success":true` and your account `id` in the result.

**Only `Pages:Edit` is needed** — no zone, DNS, or Workers permissions.

### AWS (S3)

1. **Create the bucket** (S3 console → Create bucket): any globally unique name, **note the region** — the smoke defaults to `us-east-1` and 403s with `PermanentRedirect` on a mismatch.
2. **Make it public-readable** — the smoke fetches the uploaded objects anonymously:
   - In the bucket → **Permissions** → **Block public access**: uncheck *Block all public access* (bucket settings) → Save.
   - **Bucket policy** → Edit → paste:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": "*",
         "Action": ["s3:GetObject"],
         "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
       }
     ]
   }
   ```
   Keep this bucket test-only — it is world-readable by design.
3. **Create the IAM user** (IAM → Users → Create user): name e.g. `deploy-cli-smoke`, **Attach policies directly** → **Create inline policy** → paste (replace the bucket name):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
         "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
       },
       {
         "Effect": "Allow",
         "Action": ["s3:ListBucket"],
         "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME"
       }
     ]
   }
   ```
   These are exactly the calls the CLI makes: `PutObject` (upload), `GetObject` (content checks), `ListBucket` (`deploy list` + `deploy doctor`).
   `DeleteObject` is only used by `npm run cleanup` — if you already created the
   IAM user without it, just add the one action to the inline policy (or skip it
   and never run the s3 cleanup leg).
4. **Create the access key**: user → **Security credentials** → **Create access key** → *Application running outside AWS* → copy **Access key ID** and **Secret access key** — the secret is shown **once**.

### Where the values go

| Env var | From | Required for |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare step 3 | Cloudflare leg |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare step 4 | Cloudflare leg |
| `AWS_ACCESS_KEY_ID` | AWS step 4 | S3 leg |
| `AWS_SECRET_ACCESS_KEY` | AWS step 4 | S3 leg |
| `SMOKE_S3_BUCKET` | AWS step 1 (bucket name) | S3 leg |
| `AWS_REGION` | AWS step 1 (only if not `us-east-1`) | S3 leg |

Add them as **repo secrets** (GitHub → Settings → Secrets and variables → Actions) so the release workflow's smoke step exercises those legs, and/or run once per machine so local `npm run smoke` picks them up:

```bash
node cli.js login --provider cloudflare --token <TOKEN> --account <ACCOUNT_ID>
node cli.js login --provider s3 --access-key <AK> --secret-key <SK> --bucket <NAME> [--region <R>]
```

## Cleaning up leftover smoke artifacts

Every smoke run leaves a `smoke-<timestamp>` Netlify site, Vercel project, and
Cloudflare Pages project behind (plus objects under `smoke-<timestamp>/` in the
S3 bucket). The cleanup script deletes them:

```bash
npm run cleanup                 # netlify + vercel + cloudflare
npm run cleanup -- s3           # also remove S3 objects (opt-in: shared bucket)
npm run cleanup -- --dry-run    # list what would be deleted, delete nothing
npm run cleanup -- --yes        # skip the confirmation prompt (required in CI / non-TTY)
```

Credentials resolve exactly like the smoke: env vars win, then the `deploy login`
config. **Safety rule:** only auto-generated names matching `smoke-<10+ digits>`
are ever touched — a pinned `SMOKE_SITE` / `SMOKE_VERCEL_PROJECT` (or any
custom-named project) is never matched, so your real projects can't be deleted.
Anything you want gone but not auto-named (e.g. an older `smoke-mayan-*`
project) must be deleted by hand from the provider dashboard.

**The release workflow runs cleanup automatically** after the smoke, with the
repo secrets (`npm run cleanup -- netlify vercel cloudflare s3 --yes`), so
CI no longer strands artifacts. Known constraint: the Cloudflare Pages
projects list API rejects `per_page` above 10 (returns 400), which the script
handles; and the s3 leg needs `s3:DeleteObject` on the IAM user (see the
permission section above) — until then it 403s and the step is skipped
non-fatally.

## Notes

- **Netlify free tier:** 3 deploys/min, 100/day. Don't rerun in a tight loop;
  a 429 is retried with backoff and then reported with a hint.
- **Vercel rollback** is the highest-risk leg — the endpoint is undocumented.
  If it fails, the fix is to switch to redeploying the previous files.
- If a leg fails, paste the full output into an issue or PR — the smoke script
  exists to surface exactly these contract mismatches.
