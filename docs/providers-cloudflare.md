# Provider: Cloudflare Pages

Deploys via the Cloudflare Pages **direct upload** API.

## Setup

1. Create an API token at dash.cloudflare.com → My Profile → API Tokens with
   **Cloudflare Pages: Edit** permission.
2. You also need your **account id** (dashboard → right sidebar, or any Pages
   URL).
3. Save both:

```bash
deploy login --provider cloudflare --token <token> --account <accountId>
```

Or set `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` env vars.

## Deploy

```bash
deploy up --provider cloudflare
#   URL: https://<hash>.<project>.pages.dev
```

- The project is **auto-created** on first deploy (`production_branch: main`).
- Upload strategy: the CLI advertises the sha256 of every file; Pages returns
  a pre-signed upload URL plus the missing files; each is uploaded as a
  multipart form with the signed fields. The deployment is **polled until
  `success`** (default; `--no-wait` skips).
- Note: Cloudflare asset uploads don't carry your bearer token — the pre-signed
  URL is the credential (the CLI handles this).

## Rollback

```bash
deploy rollback <id> --provider cloudflare
# ✖ Cloudflare Pages has no rollback API — restore from your dashboard …
```

Cloudflare Pages has **no rollback endpoint**, so the command explains that
clearly instead of pretending. Use the dashboard's rollback UI, or redeploy the
previous content.

## List

`deploy list --provider cloudflare` shows deployments, marking the current
production (the latest `production_branch` deploy).
