# Troubleshooting

## Run `deploy doctor` first

`deploy doctor` is the fastest way to diagnose most problems — it checks the
config file, your login state per provider, and actually probes each host with
a cheap authenticated request to verify the credentials work:

```bash
deploy doctor            # human-readable health report
deploy doctor --json     # machine-readable (stdout stays pure JSON)
deploy doctor --provider netlify   # check one provider
```

Exit code is `0` when everything is healthy and `1` when a logged-in provider
fails a connectivity check. The report also flags common misconfigurations:

- `defaultProvider "<name>" is not logged in` — your default provider has no
  credentials, so `deploy up` will fail immediately. Fix: `deploy login
  --provider <name>`.
- `.deployrc.json outDir "<path>" does not exist` — the project config points
  at an output folder that isn't there. Fix: fix the path or `deploy up
  --dir <path>`.

Checks that can't run (not logged in) show `—` and don't affect the exit code,
so you can call `deploy doctor --json` in CI as a pre-flight gate.

## "Not logged in. Run: deploy login"

Credentials for the chosen provider are missing. Run `deploy login` (or
`deploy login --provider <name> --token <token>`), or set the provider's env
token. Credentials live in `~/.deploy-cli/config.json` (or
`$DEPLOY_CONFIG_DIR/config.json`).

## "No deployable site found"

Nothing to ship. Add one of:
- a `package.json` build script → the CLI runs it and looks in
  `dist/` / `build/` / `out/` / `public/`,
- a `public/` folder,
- an `index.html` at the project root,
- or point at a folder explicitly: `deploy up --dir <path>`.

## "Build script found but no output directory"

The build runs but the output folder isn't `dist`/`build`/`out`/`public`.
Configure it: `.deployrc.json` → `{ "outDir": "custom-out" }`, or
`deploy up --dir custom-out`.

## Deploy takes forever

Large sites hit pre-flight warnings. Pass `--force` to override the 25k-file /
250 MB caps, `--no-wait` to skip host polling, and `--timeout <s>` to bound it.

## 401 / token rejected

The token is wrong, expired, or lacks permission. Re-login:
- Netlify: PAT from user settings, `deploy login --provider netlify --token <PAT>`.
- Vercel: token from vercel.com/account/tokens.
- Cloudflare: token needs **Pages:Edit**.
- S3: key needs `s3:PutObject` on the bucket.

## Rate limited (429)

- Netlify: 3 deploys/min and 100/day per account. Wait, or use previews sparingly.
- Others: wait for the backoff to clear — the CLI retries 5xx/429
  automatically with exponential backoff.

## Deep links 404 (React Router)

Static hosts need an SPA fallback — see [react.md](react.md) for the
`_redirects` / `vercel.json` config per host.

## Rollback says "no rollback API"

Cloudflare Pages and S3 don't expose rollback endpoints — the CLI refuses to
guess. Use the host's dashboard (Cloudflare) or re-upload previous content (S3).

## Interactive menu doesn't appear

`deploy` with no arguments shows the menu only when stdout is a terminal
(stdin can be anything, but stdout must be a TTY). In scripts/pipes it behaves
as `deploy up`. Force it with `DEPLOY_FORCE_TTY=1`.

## Port 8787 already in use

Start the server elsewhere: `deploy server --port 9000`, then
`deploy login --server http://localhost:9000`.

## "Unknown provider"

Check the name: `local | netlify | vercel | cloudflare | s3`.
Set a default once with `"defaultProvider": "netlify"` in the config file.

## Debugging

- `--verbose` prints stack traces.
- `NETLIFY_API_BASE`, `VERCEL_API_BASE`, `CLOUDFLARE_API_BASE`,
  `AWS_S3_ENDPOINT` override API endpoints (used by tests; useful with proxies).
