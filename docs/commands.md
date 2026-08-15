# Commands

```
deploy                    interactive menu (in a terminal); otherwise = up
deploy up                 build + upload + print the live URL
deploy preview            deploy to a preview URL — never touches production
deploy rollback <id>      re-point the production alias at a previous deploy
deploy list               deploy history for this project (★ = current production)
deploy status             login state per provider, project, last deploy
deploy diff               added/changed/removed vs the latest local deploy
deploy watch              rebuild + redeploy on file changes (Ctrl+C to stop)
deploy login              save credentials (--provider for host providers)
deploy server             start the bundled local control plane
deploy completion <shell> bash / zsh / fish completions
deploy token              print the local control plane's dev token
deploy help               this help
```

## deploy up / preview

Builds (unless `--no-build`), finds the output folder, uploads it, and prints
the URL(s).

- `--project <name>` — override the project name (default: `package.json` name or folder name).
- `--dir <path>` — upload this folder instead of the detected output dir.
- `--no-build` — skip the build step entirely.
- `--provider <name>` — `local | netlify | vercel | cloudflare | s3`.
- `--open` — open the deploy URL in your browser.
- `--wait` / `--no-wait` — wait for the host to finish processing (default: wait).
- `--timeout <seconds>` — polling timeout (default 60).
- `--force` — skip pre-flight caps (25k files / 250 MB).
- `--json` — machine-readable output; human messages go to stderr.

`deploy preview` uses the current git branch (fallback `preview`) and never
touches production aliases.

## deploy rollback <deployId>

Re-points the production alias (`latest`) at an earlier deploy.

- Local: instant alias flip. Netlify: restore endpoint. Vercel: instant rollback.
- Cloudflare Pages and S3 have **no rollback API** — the command tells you
  clearly instead of pretending.
- With no id in a terminal, you're asked which deploy to roll back to.

## deploy list

History for the current project, newest-first where the provider supports it.
`★ production` marks the currently live deploy.

## deploy status

Shows your project, default provider, per-provider login state, `.deployrc`
overrides, and the last deploy for the default provider.

## deploy diff

Compares local output vs the latest **local** deploy (size-based, per file).
Works with the `local` provider; other providers explain why not.

## deploy watch

Deploys once, then polls for file changes (1s interval, debounced per deploy)
and redeploys. Press Ctrl+C to stop. Skips `.git`, `node_modules`, and
`.deploy*` paths.

## deploy login

- `deploy login` — local control plane (interactive in a terminal).
- `deploy login --provider netlify --token <PAT>`
- `deploy login --provider vercel --token <token> [--team <teamId>]`
- `deploy login --provider cloudflare --token <token> --account <accountId>`
- `deploy login --provider s3 --access-key <AK> --secret-key <SK> --bucket <name> [--region us-east-1] [--prefix <p>]`

Credentials live in `~/.deploy-cli/config.json` (0600). Tokens can also come
from env vars (`NETLIFY_AUTH_TOKEN`, `VERCEL_TOKEN`, `CLOUDFLARE_API_TOKEN`,
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`).

## deploy server

Starts the bundled control plane. Flags: `--port` (default 8787),
`--storage` (default `./.deploy-storage`), `--token` (default `dev-token`, or
`DEPLOY_SERVER_TOKEN`).

## deploy completion <bash|zsh|fish>

Prints a completion script to stdout; wire it into your shell, e.g.:

```bash
deploy completion bash >> ~/.bashrc
# or
deploy completion zsh > ~/.zsh/completions/_deploy
```

## Global flags

`--verbose` (stack traces), `--version`, `--help`. Set the default provider
with `"defaultProvider": "netlify"` in the config file, or per project with
`.deployrc.json` (`project`, `outDir`, `buildCommand`, `netlify.site`,
`vercel.project`, `cloudflare.project`, `s3.prefix`).
