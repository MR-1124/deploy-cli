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

`SMOKE_SITE` / `SMOKE_VERCEL_PROJECT` let you pin a site/project name (the
default is a timestamped name; Netlify sites auto-create on first deploy).
A bare `npm run smoke` prints which env vars are missing for each provider.

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
| Vercel | sha256 file uploads + manifest | same, against the production alias | undocumented rollback endpoint (the one Vercel's CLI uses) |
| Cloudflare | Pages direct upload | same, against the `pages.dev` URL | n/a — no rollback API, reported as such |
| S3 | SigV4-signed PutObject | fetches the object via the path-style URL | n/a — plain S3 has no rollback |

New sites can take 5–30 s after the API reports ready for DNS/SSL/edge to
propagate, so the content check retries with backoff instead of failing on the
first 404/522.

## Notes

- **Netlify free tier:** 3 deploys/min, 100/day. Don't rerun in a tight loop;
  a 429 is retried with backoff and then reported with a hint.
- **Vercel rollback** is the highest-risk leg — the endpoint is undocumented.
  If it fails, the fix is to switch to redeploying the previous files.
- If a leg fails, paste the full output into an issue or PR — the smoke script
  exists to surface exactly these contract mismatches.
