# Provider: Netlify

Deploys through the official Netlify REST API — no Netlify CLI needed.

## Setup

1. Create a **Personal Access Token** at app.netlify.com → User settings →
   Applications → Personal access tokens.
2. Save it:

```bash
deploy login --provider netlify --token <PAT>
```

## Deploy

```bash
deploy up --provider netlify --site my-site
#   URL:    https://my-site.netlify.app
#   Deploy: https://<hash>--my-site.netlify.app
```

- The site is **auto-created** if it doesn't exist (name from `--site`, or
  `netlify.site` in `.deployrc.json`, or the project name).
- Site names must be globally unique on `*.netlify.app`; a taken name returns a
  clear error.

## How uploads work

- **Production (`up`):** the *digest method* — the CLI sends the sha1 of every
  file, Netlify says which are missing, and only those are uploaded. No zip
  size caps, no 30-second request limit, deduped across deploys.
- **Previews (`deploy preview`):** branch deploys use the *zip method* with a
  `branch` query param — the documented way to create branch deploys.
- Override with `--method zip|digest`.
- The CLI **polls until the deploy is `ready`** (default; `--no-wait` skips,
  `--timeout <s>` bounds it).

## Rollback

```bash
deploy list --provider netlify          # find the deployId
deploy rollback <deployId> --provider netlify
```

Uses the restore endpoint — the previous deploy becomes production again.

## Limits

- 3 deploys/min and 100 deploys/day per account via the API.
- 25,000 files per zip extraction (digest mode avoids this entirely).

## Headers & redirects

Netlify reads `_redirects` / `_headers` from the build output (add them to your
`public/` folder). For React Router, see [react.md](react.md).
