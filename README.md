# deploy — one-command deploys for static sites

[![release pipeline: tests + 4-provider smoke + publish](https://github.com/MR-1124/deploy-cli/actions/workflows/release.yml/badge.svg)](https://github.com/MR-1124/deploy-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@mayan1124%2Fdeploy-cli)](https://www.npmjs.com/package/@mayan1124/deploy-cli)

**🌐 Website: [`site/`](./site/) — the landing page is a static site you can
ship with the CLI itself** (it's what's serving this project's preview tab).

Run `deploy` in any project and it detects the build, ships the output, and
hands you a live URL — with immutable per-deploy URLs, aliases, instant
rollback, and preview deploys. It targets five hosts through one interface:

| Provider    | How it uploads                                             | Rollback                          |
|-------------|------------------------------------------------------------|-----------------------------------|
| `local`     | tar → bundled control plane (`:8787`)                      | alias re-point (instant)          |
| `netlify`   | digest uploads (production) / zip (previews)               | restore previous deploy           |
| `vercel`    | SHA1 file uploads (`/v2/files`) + files manifest           | instant rollback                  |
| `cloudflare`| Pages direct upload (requires `--account`)                 | dashboard (no API)                |
| `s3`        | SigV4-signed PutObject (requires `--bucket`)               | re-upload (no built-in)           |

The production design (auth, blob storage, CDN, scaling) lives in
[`ARCHITECTURE.md`](./ARCHITECTURE.md). The prototype implements the same URL
model and alias semantics locally, and the provider layer means the CLI already
talks to real hosts today.

## Pipeline status

Every tag release runs the **real-account smoke test** against all four hosts
(see [`docs/smoke-test.md`](./docs/smoke-test.md)), publishes to npm, verifies
the published package from a clean install, and creates the GitHub Release.
The badge above tracks the latest run. Last verified in `v0.3.2` (2026-08-18):

| Provider    | Smoke (deploy + content check) | Cleanup | Notes                                   |
|-------------|-------------------------------|---------|------------------------------------------|
| `netlify`   | ✔                             | ✔       | digest deploy + rollback                |
| `vercel`    | ✔                             | ✔       | upload → READY wait → rollback          |
| `cloudflare`| ✔                             | ✔       | Pages direct upload                     |
| `s3`        | ✔                             | ⚠ needs `s3:DeleteObject` on the IAM user | SigV4 upload + content check          |

Run it yourself anytime: `npm run smoke` (env vars or `deploy login`), then
`npm run cleanup` to remove the test artifacts the run leaves behind.

## Quickstart

```bash
# 1. Start the bundled control plane (serves deploys on :8787)
node cli.js server

# 2. Login (stores server URL + token in ~/.deploy-cli/config.json)
node cli.js login

# 3. From any project with a build script or static folder:
cd examples/sample-site
node ../../cli.js up
#   → http://localhost:8787/sample-site/latest/
```

You get an **alias URL** (`.../latest/`) that always points at the current
deploy and an **immutable deploy URL** that never changes.

Install it globally for a real `deploy` command: `npm link`.

## Deploying to real hosts

```bash
# Netlify — PAT from app.netlify.com → User settings → Applications
node cli.js login --provider netlify --token <PAT>
node cli.js up --provider netlify --site my-site        # site auto-created
node cli.js preview --provider netlify                  # zip branch deploy
node cli.js rollback <deployId> --provider netlify

# Vercel — token from vercel.com/account/tokens
node cli.js login --provider vercel --token <token> [--team <teamId>]
node cli.js up --provider vercel                        # target=production
node cli.js rollback <deployId> --provider vercel       # instant rollback

# Cloudflare Pages — API token with Pages:Edit + account id
node cli.js login --provider cloudflare --token <token> --account <accountId>
node cli.js up --provider cloudflare

# S3 — access key with PutObject on the bucket
node cli.js login --provider s3 --access-key <AK> --secret-key <SK> --bucket <name> [--region us-east-1] [--prefix <p>]
node cli.js up --provider s3
```

Upload strategy notes:
- **Netlify** uses the *digest method* for production (sha1 per file, only
  missing files are uploaded — avoids the 25k-file zip cap and 30 s request
  timeout). Branch/preview deploys use the zip method (the documented way).
  Override with `--method zip|digest`.
- **Vercel** uploads every file once via `POST /v2/files` keyed by SHA1 (the
  current documented contract), then creates a deployment referencing the shas
  (no giant JSON manifest).
- Both hosts are polled until the deploy is `ready`/`success` by default
  (`--no-wait` to skip; `--timeout <seconds>` to bound polling).
- All requests retry network failures and 5xx/429 with exponential backoff;
  local deploys are idempotent (a retried upload never creates duplicates).

## Commands

| Command                     | What it does                                             |
|-----------------------------|----------------------------------------------------------|
| `deploy` / `deploy up`      | build (if a build script exists) + upload + print URL    |
| `deploy preview`            | deploy to a preview URL — never touches production       |
| `deploy rollback <id>`      | re-point the production alias at a previous deploy       |
| `deploy list`               | deploy history, ★ marks current production               |
| `deploy status`             | login state per provider, project, last deploy           |
| `deploy diff`               | added/changed/removed vs the latest local deploy         |
| `deploy watch`              | rebuild + redeploy on file changes (Ctrl+C to stop)      |
| `deploy login`              | save credentials (`--provider` for host providers)       |
| `deploy server`             | start the local control plane (`--port`, `--storage`)    |
| `deploy completion <shell>` | bash / zsh / fish completions                            |
| `deploy token`              | print the dev server token                               |

### Options

```
--project <name>   override the project name
--dir <path>       upload this folder instead of the detected output dir
--no-build         skip the build step
--provider <name>  local | netlify | vercel | cloudflare | s3
--site <name>      Netlify site (auto-created if missing)
--method <m>       Netlify upload method: digest (default) | zip
--team <teamId>    Vercel team id
--account <id>     Cloudflare account id
--bucket <name>    S3 bucket            --region <r>    S3 region
--prefix <p>       S3 key prefix (default: project name)
--wait/--no-wait   wait for the host to finish processing
--timeout <s>      polling timeout (default 60)
--open             open the deploy URL in your browser
--force            skip pre-flight caps (file count / total size)
--json             machine-readable output (great for CI)
--verbose          stack traces on errors
```

## CI

`--json` makes deploys scriptable. The repo ships
[`.github/workflows/preview.yml`](.github/workflows/preview.yml): on every PR it
starts the bundled control plane, deploys the branch, and comments the preview
URL — no external tokens needed. Swap the deploy step for Netlify/Vercel if you
prefer hosting previews there.

A real-account smoke test is in `scripts/smoke-real.mjs` (the mock tests verify
what we send; this verifies what the hosts return). Run it with real
`NETLIFY_AUTH_TOKEN` / `VERCEL_TOKEN` etc. — the only verification the mocks
can't do.

## Project detection

Order of resolution for what gets uploaded:

1. `.deployrc.json` → `{ "outDir", "buildCommand", "project", "netlify": {"site"}, "vercel": {"project"}, ... }` (see `examples/sample-site/.deployrc.json`)
2. `package.json` build script → first existing of `dist/`, `build/`, `out/`, `public/`
3. `public/` folder, or a static site at the project root (`index.html`)

The package manager is sniffed from lockfiles (`pnpm-lock.yaml` → pnpm, etc.).

Pre-flight checks run before every upload: file count and total size are
reported, soft thresholds warn, and hard caps (25k files / 250 MB) abort unless
`--force` is passed.

## Configuration

- **Credentials:** `deploy login` writes `~/.deploy-cli/config.json` (0600).
  Provider tokens live under `providers.netlify` / `providers.vercel` /
  `providers.cloudflare` / `providers.s3` in the same file. Override the
  location with `DEPLOY_CONFIG_DIR` (useful for CI and sandboxes).
- **Tokens can also come from env vars:** `NETLIFY_AUTH_TOKEN`,
  `VERCEL_TOKEN`, `CLOUDFLARE_API_TOKEN`, `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`.
- **API endpoints are overridable** with `NETLIFY_API_BASE`,
  `VERCEL_API_BASE`, `CLOUDFLARE_API_BASE`, `AWS_S3_ENDPOINT` — the tests use
  this to run against mock servers.
- **Default provider:** set `"defaultProvider": "netlify"` in the config file.
- **Local control plane:** stores deploys under `.deploy-storage/<project>/<id>/`
  plus `registry.json` of aliases. Change with `deploy server --storage <path>`.
  Auth is enforced on all write endpoints (default token `dev-token`).

## Tests

```bash
npm test
```

Three suites, run against mock servers and in-process:
- `test/run.js` — tar round-trip, server flow, aliases, rollback, **idempotency**, files listing
- `test/providers.js` — Netlify (digest + zip + auto-create + restore), Vercel
  (sha upload + manifest + rollback), Cloudflare (direct upload), S3 (SigV4
  signatures recomputed and verified by the mock)
- `test/cli.js` — argument parsing, kebab-case normalization, `--dir` resolution, command error paths
- `test/ui.js` — interactive prompts (spawned, line-driven)

## Layout

```
cli.js                   entry point (up / preview / rollback / list / status / diff / watch / …)
lib/args.js              argument parser (extracted for unit testing)
lib/format.js            colors, clickable links, progress, tables
lib/http.js              fetch with retry/backoff, timeouts, tagged errors
lib/preflight.js         file-count / size checks before upload
lib/tar.js               zero-dependency POSIX ustar tar writer + safe extractor
lib/zip.js               zero-dependency ZIP writer (store) for Netlify previews
lib/files.js             shared file walker (paths, sizes, mtimes)
lib/server.js            bundled control plane: storage, aliases, idempotency, rollback
lib/upload.js            HTTP client for the local control plane
lib/build.js             project detection: build command, output dir, branch
lib/config.js            credential storage
lib/providers/           provider layer: local, netlify, vercel, cloudflare, s3
examples/sample-site/    demo site with a real build script + .deployrc.json
site/                    the landing website (static, deployable with this CLI)
docs/                    full guide set: install, quickstart, commands, providers, CI, publish
docs/publish.md          publishing to npm (package layout, dry-run, login, publish)
.github/workflows/       PR preview deploys (comments the URL)
scripts/smoke-real.mjs   real-account smoke test (needs your tokens)
test/                    four test suites (run.js, providers.js, cli.js, ui.js)
ARCHITECTURE.md          the production design this prototype models
```
