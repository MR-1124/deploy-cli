# Provider: Vercel

Deploys through the Vercel REST API.

## Setup

1. Create a token at **vercel.com/account/tokens**.
2. Save it (team id is optional, for team-owned projects):

```bash
deploy login --provider vercel --token <token>
# or with a team:
deploy login --provider vercel --token <token> --team <teamId>
```

## Deploy

```bash
deploy up --provider vercel
#   URL:    https://<project>.vercel.app
#   Deploy: https://<project>-<hash>.vercel.app
```

- The project is auto-created on first deploy.
- `deploy up` sets `target: production`; `deploy preview` omits it (preview
  deployment with its own URL).
- The CLI uploads **already-built** output and tells Vercel not to run its own
  build (`projectSettings` with null commands).

## How uploads work

Every file is uploaded once via `POST /v2/files` keyed by **SHA1**
(`x-vercel-digest` header; a 409 means "already uploaded" and is treated as
success). The deployment then references the shas — no giant base64 request
body, and unchanged files between deploys are naturally deduped.

## Rollback

```bash
deploy list --provider vercel           # find the deployment id
deploy rollback <deploymentId> --provider vercel
```

Uses Vercel's instant-rollback endpoint (the same one the Vercel CLI uses;
technically undocumented but stable in practice). Project id is resolved by
name via the API.

## Notes

- Preview deployments don't receive the production alias — `rollback` and
  `list` target the project's production line.
- Vercel rate limits apply per token; the CLI retries 5xx/429 with backoff.
