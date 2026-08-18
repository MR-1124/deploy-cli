# Security Policy

## Reporting a vulnerability

Please report security issues privately — do **not** open a public issue.

- **Preferred:** GitHub's [private vulnerability reporting](https://github.com/MR-1124/deploy-cli/security/advisories/new)
  (the "Report a vulnerability" button on the repo's Security tab).
- **Fallback:** email the maintainer (address linked on the GitHub profile) with
  the subject `[deploy-cli security]`.

You'll get an acknowledgement within 5 business days and a timeline for a fix.
Security fixes are released as quickly as possible; if the issue is embargoed,
mention that so we coordinate disclosure.

## Scope

Things to look at (and report on):

- **Credential handling** — `~/.deploy-cli/config.json` holds provider tokens
  (written 0600). Anything that could leak tokens: logging, error output,
  `--verbose` traces, the `deploy token` command, env-var precedence.
- **The bundled control plane** (`lib/server.js`) — auth on write endpoints,
  path traversal against `storageDir` (the `safeJoin` guards), tar extraction
  safety, registry handling.
- **The upload path** — `lib/tar.js` extraction and `lib/zip.js` writing,
  symlink handling, file exclusions.
- **Provider credentials in CI** — the release workflow's secrets and what the
  smoke/cleanup scripts print (tokens must stay masked).

## Out of scope

- The npm registry package's own signing/attestation (npm handles that).
- Host-side vulnerabilities (Netlify/Vercel/Cloudflare/AWS) — report those to
  the respective vendor's security program.

## Security-relevant practices in this repo

- Provider tokens are env-var-first, config-file-second; neither is ever
  committed.
- Write endpoints on the control plane require a bearer token and compare with
  `crypto.timingSafeEqual`.
- All file paths under storage are resolved through `safeJoin` to prevent
  traversal, and uploads are extracted with a bounded tar extractor.
- CI runs smoke tests against real hosts with masked secrets; run logs never
  print tokens.
