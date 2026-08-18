# Contributing to deploy-cli

Thanks for wanting to help! This project is a small, dependency-light CLI for
deploying static sites to five hosts — it's an ideal size to learn from and
hack on. Everything below is what you need to make your first PR painless.

## Code of conduct

Be kind and assume good faith. This project was built with AI assistance (see
the README); treat the code as a starting point, not scripture — the best
contributions fix real gaps and improve the code for everyone.

## Getting started

Requirements: **Node.js ≥ 18** (the repo's CI runs Node 24) and git. There are
no other runtime dependencies — `npm install` only installs test tooling.

```bash
git clone https://github.com/MR-1124/deploy-cli.git
cd deploy-cli
npm install
npm test          # all four suites, no network needed
```

To see the CLI in action with zero accounts:

```bash
node cli.js server                                   # control plane on :8787
# in another terminal:
node cli.js login                                    # accept defaults (dev-token)
cd examples/sample-site && node ../../cli.js up      # → localhost:8787/sample-site/latest/
```

The React Router example works the same way (`examples/react-spa` — it has its
own `package.json`; run `npm install && npm run build` inside it first).

## How the repo is laid out

```
cli.js                entry point: arg parsing, command dispatch, provider routing
lib/                  args, http (retry/backoff), tar, zip, build detection,
                      config, the bundled control-plane server, provider layer
lib/providers/        one file per host: local, netlify, vercel, cloudflare, s3
test/                 run.js · providers.js · cli.js · ui.js — mock-server tests
scripts/smoke-real.mjs  real-account smoke test against actual hosts (CI runs it)
docs/                 the guide set; site/ is the website (deployable with the CLI)
```

The README's Layout section has a one-line description of every file.

## Running the tests

```bash
npm test
```

The suites run against **mock HTTP servers**, so they're fast and need no
credentials. The provider tests recompute signatures (e.g. S3 SigV4) server-side
and assert exactly what the CLI would send to the real hosts. When you change a
provider, you should see a corresponding change needed in `test/providers.js` —
that's the intended loop.

Key detail for testing: provider API bases are overridable via env vars
(`NETLIFY_API_BASE`, `VERCEL_API_BASE`, `CLOUDFLARE_API_BASE`,
`AWS_S3_ENDPOINT`), which is how the tests point the real client code at the
mocks. Use the same mechanism for new providers.

## What makes a good PR

- **One concern per PR.** A fix, a feature, or a docs improvement — not all three.
- **Tests pass** (`npm test`) and, if you touched behavior, you added a test for it.
- **No secrets.** Never commit tokens, `.deploy-cli` config, `.deploy-storage`,
  or `.freebuff/` files. `.gitignore` covers them; keep it that way.
- **Match the style.** Plain ESM (`import`/`export`), zero new runtime
  dependencies (prefer Node built-ins), no formatting config — the code reads
  like a small library, keep it that way.
- **Link the issue** you're fixing in the PR description.

Commit messages follow the repo's style: a short imperative summary line
("Add SPA fallback to the local control plane"), optionally a body paragraph
explaining the *why*.

## Good first issues

Ideas that are genuinely approachable for a first PR (look for the
`good first issue` label, or pick one of these):

- **Docs gaps** — the docs are thorough but young; anything confusing, stale,
  or missing (e.g. a host's rate limits) is a welcome fix.
- **Error message quality** — run `deploy` against a misconfigured host and
  improve the message when something fails. The CLI's errors are tagged with
  provider + HTTP status; hunt for ones that don't tell you what to do next.
- **Provider polish** — e.g. S3's cleanup leg (the IAM story is documented in
  `docs/smoke-test.md`), or Cloudflare's project listing pagination. Each
  provider is one file; the mocks make it testable without an account.
- **The website** — `site/` is plain HTML/CSS/JS; adding pages or polishing
  the landing page is low-risk and visible immediately.
- **Test coverage** — the tar round-trip and the control-plane server have
  good coverage; edge cases (malformed tars, path-traversal attempts,
  concurrent deploys) are cheap to add and valuable.

If you're unsure whether an idea fits, open an issue first and ask — that's
exactly what issues are for.

## The smoke test (optional, needs real accounts)

`npm test` proves what the CLI *sends*. `npm run smoke` proves what the real
hosts *do* — it deploys a tiny site to Netlify, Vercel, Cloudflare Pages, and
S3, checks the content, exercises rollback, and cleans up after itself. It
needs real tokens (see `docs/smoke-test.md`), so it only runs when you want it
to — the release workflow runs it on tag pushes with the repo secrets.

```bash
npm run smoke          # uses `deploy login` credentials or env vars
npm run cleanup        # removes any artifacts a smoke run left behind
```

## Releases

Releases are fully workflow-driven. Maintainers cut one with two commands:

```bash
npm version patch      # bumps version, commits, tags vX.Y.Z
git push origin main --tags
```

The tag push runs the whole pipeline: tests → four-provider smoke → cleanup →
npm publish → clean-install verify → GitHub Release from
`.github/release_template.md`. See `docs/publish.md` for the full walkthrough.
