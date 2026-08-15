# Provider: local (bundled control plane)

The local provider is the CLI's own hosting: a small HTTP server that stores
deploys, keeps aliases, and serves static files. It's what makes previews and
rollback trivially available with zero cloud accounts.

## Start it

```bash
deploy server
# deploy server on http://localhost:8787
#   storage: ./.deploy-storage
#   token:   dev-token
```

`--storage` changes where deploys live; `--token` changes the write token.

## Deploy

```bash
deploy login
deploy up
#   URL:    http://localhost:8787/<project>/latest/
#   Deploy: http://localhost:8787/<project>/<deployId>/
```

## URLs and aliases

| URL | Meaning |
|---|---|
| `…/latest/` | always the current production deploy (alias) |
| `…/preview-<branch>/` | preview alias, created by `deploy preview` |
| `…/<deployId>/` | immutable — that exact upload, forever |

Aliases are pointers in `storage/registry.json`. Flipping an alias is the
rollback operation — no bytes move.

## Rollback

```bash
deploy list          # find the deployId
deploy rollback <deployId>
# ✔ Rolled back <project> → <deployId> (local)
```

Rollback is instant: one alias update.

## Diff & watch

`deploy diff` and `deploy watch` work against the local provider out of the box.

## Data layout

```
.deploy-storage/
  registry.json          # projects, deploys, aliases (+ idempotency keys)
  <project>/
    <deployId>/          # one immutable folder per deploy
      index.html
      assets/...
```

## Production notes

The control plane is a prototype of the hosted service in
`ARCHITECTURE.md` — single process, single storage dir, no auth on reads (the
public side), bearer token on writes. For production hosting use a real
provider; the CLI targets both with the same commands.
