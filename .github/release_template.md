# deploy-cli __VERSION__

**Released:** __DATE__

One-command deploys for static sites: local control plane, Netlify, Vercel,
Cloudflare Pages, and S3 from a single CLI with an interactive UI, previews,
rollback, and a health-check doctor.

## What's in this release

<!-- Summarize the user-facing changes in this version here (the workflow
     fills in version/date; edit the rest per release). -->

## Provider fixes in this release

<!-- Mark the providers whose integration changed, with a one-line note each.
     History for reference:
     - Vercel: uploads via POST /v2/files keyed by SHA1 + x-now-digest; the CLI
       polls deployments until READY before claiming a URL.
     - Netlify: digest deploys resolve the `required` SHA1 list back to files,
       then PUT each by path.
     - Cloudflare Pages: content hashes are blake3(base64(content) + ext)
       truncated to 32 hex chars (wrangler's exact hashFile); deployments are
       polled via latest_stage.
     - S3: SigV4-signed uploads with content checks. -->

- [ ] Netlify
- [ ] Vercel
- [ ] Cloudflare Pages
- [ ] S3

## Pipeline

This version passed the **real-account smoke test** (see
[docs/smoke-test.md](docs/smoke-test.md)) on every configured provider —
each leg deploys to the live host, verifies served content, and rolls back:

- Netlify digest deploy + rollback
- Vercel upload → READY wait → content check → two-deploy rollback
- Cloudflare Pages direct upload (upload-token flow) + content check
- S3 upload + content check

The release workflow also **auto-cleans the smoke artifacts** after each run
(`npm run cleanup -- netlify vercel cloudflare s3 --yes`), so CI leaves no
stranded `smoke-*` sites, projects, or S3 prefixes behind.

## Install / upgrade

```bash
npm install -g @mayan1124/deploy-cli@__VERSION__
# or: npm update -g @mayan1124/deploy-cli
deploy --version
```

## All checks

- [ ] `npm test` (unit + provider-mock + CLI + UI + cleanup suites)
- [ ] Real-account smoke: Netlify, Vercel, Cloudflare Pages, S3
- [ ] Published to npm and verified from a clean install (`deploy --version`,
      `deploy doctor --json`, package API import)

---

*Cut with `npm version patch && git push origin main --tags` — the workflow
tests, smokes, publishes to npm, verifies, and creates this release.*
