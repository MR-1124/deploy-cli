# Quickstart

This walks through shipping your first site to the bundled local control plane
in about two minutes. See [providers](providers-local.md) for how to deploy to
Netlify, Vercel, Cloudflare Pages, or S3 instead.

## 1. Install

```bash
npm install -g deploy-cli
```

## 2. Start the local control plane

The control plane stores deploys and serves them on `:8787`:

```bash
deploy server
# deploy server on http://localhost:8787
#   storage: ./.deploy-storage
#   token:   dev-token
```

Leave it running in its own terminal.

## 3. Login

```bash
deploy login
# ✔ Credentials saved for http://localhost:8787
```

## 4. Deploy

From your project root (any project with a build script, a `public/` folder, or
an `index.html`):

```bash
deploy
```

In a terminal you get the interactive menu — pick **Deploy now**. Or skip the
menu with `deploy up`:

```bash
deploy up
```

The CLI will:

1. Detect your build: reads `package.json`, finds `"build"`, and runs it with
   the package manager detected from lockfiles (`npm`, `pnpm`, `yarn`, or `bun`).
2. Find the output folder: `dist/`, `build/`, `out/`, `public/`, or the project
   root if it's already static.
3. Upload it and print your URLs:

```
✔ Deployed 20260815-091200-ab12
  URL:    http://localhost:8787/my-app/latest/
  Deploy: http://localhost:8787/my-app/20260815-091200-ab12/
```

- `…/latest/` — the alias that always points at the current deploy.
- `…/20260815-…/` — the immutable URL for this exact deploy (never changes).

## 5. Open it

```bash
deploy up --open      # opens the URL in your browser
```

## What's next

- **Iterate:** `deploy watch` rebuilds and redeploys on every file change.
- **Preview a branch:** `deploy preview` — production is untouched.
- **Roll back:** `deploy rollback <deployId>` — instant alias re-point.
- **Compare:** `deploy diff` shows what changed vs the last local deploy.
- **Deploy to a real host:** [providers](providers-netlify.md).
