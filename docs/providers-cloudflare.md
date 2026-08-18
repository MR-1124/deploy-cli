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
- Upload strategy (current direct-upload contract, same as wrangler): the CLI
  fetches a short-lived **upload JWT**, uploads file content keyed by the
  Pages content hash (only the hashes Pages doesn't already have), then creates
  the deployment with a `manifest` JSON field mapping file paths → content
  hash. The hash is **blake3(base64(content) + extension)** truncated to 32 hex
  chars — wrangler's exact `hashFile` (plain sha256 is rejected at serve time
  with HTTP 500). The deployment is **polled until `success`** (default;
  `--no-wait` skips).
- Note: asset uploads are authorized by the short-lived upload JWT, not your
  API token (the CLI handles this).

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
