# Real-account smoke test

The mock-API test suites verify **what the CLI sends**. `npm run smoke` verifies
**what the hosts actually return** — the one gap mocks can't close. It deploys a
tiny two-file site to each host you select, fetches the returned URL, asserts the
content actually serves, and (where supported) rolls back.

> Credentials are read from environment variables only. The script never writes
> to `~/.deploy-cli/config.json` — nothing gets persisted.

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
vars are missing for each provider.

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

## Notes

- **Netlify free tier:** 3 deploys/min, 100/day. Don't rerun in a tight loop;
  a 429 is retried with backoff and then reported with a hint.
- **Vercel rollback** is the highest-risk leg — the endpoint is undocumented.
  If it fails, the fix is to switch to redeploying the previous files.
- If a leg fails, paste the full output into an issue or PR — the smoke script
  exists to surface exactly these contract mismatches.
