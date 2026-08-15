# deploy-cli — documentation

One-command deploys for static sites. Local control plane, Netlify, Vercel,
Cloudflare Pages, and S3 from a single CLI.

## Guides

| Guide | What it covers |
|---|---|
| [Install](install.md) | Install from npm, `npm link`, requirements |
| [Quickstart](quickstart.md) | First deploy in 2 minutes |
| [Interactive UI](interactive.md) | The menu, prompts, and masked token entry |
| [Commands](commands.md) | Full reference for every command and flag |
| Providers | [local](providers-local.md) · [netlify](providers-netlify.md) · [vercel](providers-vercel.md) · [cloudflare](providers-cloudflare.md) · [s3](providers-s3.md) |
| [React & Vite](react.md) | Deploying React apps, incl. client-side routing |
| [CI/CD](ci.md) | GitHub Actions, `--json`, previews on PRs |
| [Publishing](publish.md) | Shipping this CLI to npm |
| [Smoke test](smoke-test.md) | Verifying against real Netlify/Vercel/Cloudflare/S3 accounts |
| [Troubleshooting](troubleshooting.md) | Common errors and fixes |

## Quick orientation

```
deploy                  # interactive menu (in a terminal)
deploy up               # build + upload + URL
deploy up --provider netlify
deploy preview          # preview URL, never touches production
deploy rollback <id>    # instant rollback
deploy list             # history, ★ marks current production
deploy status           # login state + last deploy
deploy doctor           # health report: config, login state, connectivity
deploy diff             # what changed vs the last local deploy
deploy watch            # rebuild + redeploy on every change
```

The production design (auth, blob storage, CDN, URL model) is documented in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md).
