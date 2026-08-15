# Architecture: A One-Command Deployment Platform

A production system that lets a developer run `deploy` (or `deploy --preview`) from
any project and get back a live, shareable URL in seconds. This document covers the
full design — the parts a prototype can fake and the parts that matter at scale.

---

## 1. Goals & non-goals

**Goals**
- One command from any directory: detect project, build, upload, return a URL.
- Immutable deploys: every upload is addressable forever at its own URL.
- Aliases (`latest`, `preview-<branch>`) that can be flipped instantly — rollback
  is just re-pointing an alias, never a re-deploy.
- Preview deploys for feature branches that never touch production aliases.
- Zero-config for the happy path; config file for the rest.

**Non-goals (initially)**
- Server-side builds / serverless functions / databases (later phases, see §12).
- Multi-tenant billing and quota enforcement (design leaves hooks, doesn't ship them).
- Edge compute or distributed functions.

---

## 2. System overview

```
┌─────────────┐   HTTPS    ┌──────────────────────────────────────────┐
│  CLI        │ ─────────▶ │  Control Plane (API)                     │
│  (local)    │            │  auth / projects / deploys / aliases     │
└─────────────┘            └───────┬──────────┬──────────────┬────────┘
                                   │          │              │
                      ┌────────────▼──┐  ┌────▼─────┐   ┌────▼────────────┐
                      │  Blob storage │  │   DB     │   │  CDN / edge     │
                      │  (immutable   │  │ projects,│   │  (cache, TLS,   │
                      │   objects)    │  │ deploys, │   │   customdoms)   │
                      └───────────────┘  │ aliases  │   └─────────────────┘
                                         └──────────┘
```

Two planes, deliberately split:

- **Control plane (API):** small, transactional, stateful. Handles auth, project
  metadata, deploy records, and alias pointers. Written to be moved behind a load
  balancer with a Postgres/MySQL database.
- **Data plane (CDN + blob storage):** dumb, fast, stateless. Serves bytes with
  aggressive caching. The control plane never serves files itself at scale.

The split matters because the two planes scale differently: the control plane
scales on *transactions* (thousands/min), the data plane on *bytes served*
(millions/sec). A monolith that streams files will fall over at the first
viral share; a CDN absorbs that for you.

---

## 3. URL model — the core concept

Everything hangs off the URL scheme. Deploys are immutable; aliases are mutable.

```
https://<project>.deploy.app/            → alias `latest` (production)
https://<project>.deploy.app/<deployId>/ → immutable, never changes
https://<project>.deploy.app/preview-<branch>/ → alias, per branch
```

| Concept   | Immutable? | Example                          | Used for                    |
|-----------|-----------|----------------------------------|-----------------------------|
| Deploy ID | yes       | `20260815-123456-a1b2`           | rollback target, audit      |
| Alias     | no        | `latest`, `preview-feat/login`   | promotion, PR previews      |

Rules:
1. **Deploy IDs are content-addressable-ish:** generated server-side
   (`<timestamp>-<random>`), collision-resistant, never reused, never deleted.
2. **Aliases are pointers in a database row**, resolved by the control plane at
   request time (or materialized to the CDN, §5.4).
3. **A deploy is never edited.** To "update" the site you upload a new deploy and
   flip the alias. This makes rollback trivial and every deploy auditable.

Custom domains (`myapp.com`) map a verified domain to an alias, not a deploy, so
custom-domain rollback is the same alias flip.

---

## 4. Auth

Three personas: **developer** (CLI), **CI robot** (token), **edge** (CDN↔control
plane, mTLS).

### 4.1 Developer login (`deploy login`)
- CLI opens browser → `https://deploy.app/oauth/authorize?client_id=...&code_challenge=...`
  (PKCE flow against GitHub / Google / email magic-link).
- Callback returns a short-lived **access token** (JWT, ~15 min) plus a
  long-lived **refresh token** (~30 days, rotating).
- Tokens are stored in the OS keychain (`keytar` on macOS/Windows, `libsecret` on
  Linux), *not* in plaintext config. Fallback to `0600` file with a warning.
- The access token is sent as `Authorization: Bearer <jwt>`; the CLI refreshes
  silently when it expires. The refresh token is never sent to the API — only to
  the token endpoint, over the same TLS connection that issued it.

### 4.2 CI / machine tokens
- `deploy token create --name "github-actions" --scope deploy:project=myapp`
- Stored by the CI provider as a secret. Long-lived but **revocable** and
  **scoped** (project-level, no account admin).
- Rotation: tokens have `created_at`/`last_used_at`; UI lists them for revoke.

### 4.3 Edge trust
- CDN → control plane calls use **mTLS** (client certificates), never shared
  bearer tokens, so a leaked JWT can't impersonate the edge.

### 4.4 Enforcement points
| Action                  | Who can do it                            |
|-------------------------|------------------------------------------|
| `deploy up`             | owner / CI token with project scope      |
| `deploy rollback`       | owner / maintainer                       |
| `deploy token create`   | owner only                               |
| Read public site        | anyone (no auth) — that's the product    |
| Read `preview-*`        | anyone with link, unless project sets `previewRequiresAuth` |

---

## 5. Data plane

### 5.1 Blob storage (S3-compatible)
- One **immutable object per file**: `s3://deploys/<project>/<deployId>/<relpath>`.
  Uploaded once, never overwritten.
- **Multipart upload** above ~100 MB with checksums per part; the API records the
  final object's ETag (MD5 of the assembled object) so corruption is detectable
  at serve time.
- Object metadata carries `cache-control` computed at upload: hashed filenames
  (`app.a1b2c3.js`) get `public, max-age=31536000, immutable`; `index.html` gets
  `no-cache` so alias flips propagate instantly. This single convention is what
  makes instant rollback actually instant.
- A tarball of the whole deploy is also stored (`deploys/<project>/<deployId>.tar.gz`)
  for point-in-time restore and cheap transfer between regions.

### 5.2 CDN
- CloudFront / Cloudflare / Fastly in front of the blob store. Edge nodes cache by
  object key; origin fetch happens at most once per key per region.
- **Cache invalidation on alias flip** (§6): when `latest` moves, the edge purges
  (or revalidates) the `no-cache` documents so the new index.html is served within
  seconds globally.
- **TLS**: automatic certificates for `*.deploy.app` and per-custom-domain certs
  (Let's Encrypt + ACME HTTP-01 challenge validated by the control plane).
- **Compression**: Brotli at the edge for text types, negotiated by
  `Accept-Encoding` — the CLI stores bytes verbatim, so it doesn't pay for
  re-compressing per variant.

### 5.3 Routing
`<project>.deploy.app` wildcard DNS terminates at the CDN. The CDN needs to know
which *object prefix* a request maps to — the one piece of state the edge holds.
Two options:

1. **DB-backed edge (recommended at small scale):** the edge calls the control
   plane's `GET /internal/routes?host=` and caches the result ~30 s. Simple, and
   invalidation latency is bounded by the TTL.
2. **Materialized route table (at scale):** every alias mutation publishes a
   small file to a route bucket the edge reads. Instant and offline-capable.

### 5.4 Integrity & security headers
- `ETag` = object checksum; clients and edge both get conditional-request safety.
- `Content-Security-Policy` injected by the edge as a baseline, overridable per
  project. `X-Content-Type-Options: nosniff`, HSTS preload on the apex domain.

---

## 6. Deploy, rollback, promotion

### 6.1 Happy path (`deploy up`)
```
CLI                    API                    Blob           DB        CDN
 │ build (local)        │                       │              │         │
 │ tar + stream         │                       │              │         │
 │─────────────────────▶│ createDeploy(project) │              │         │
 │                      │──────────────────────▶│              │         │
 │                      │   multipart upload    │              │         │
 │                      │◀──────────────────────│              │         │
 │                      │ verify checksums      │              │         │
 │                      │ INSERT deploy         │              │         │
 │                      │───(transaction)──────▶│              │         │
 │                      │ flip alias `latest`   │              │         │
 │                      │ purge cache           │             │────────▶│
 │◀─────────────────────│ { url, deployId }     │              │         │
```

Key point: the deploy is *registered* only after its bytes are verified; the
alias flip is the last step. A crash anywhere before the flip leaves an orphaned
immutable deploy and zero user-visible harm.

### 6.2 Rollback (`deploy rollback <deployId>`)
No bytes move. The API updates one row — `aliases.latest = <deployId>` — and
purges the `no-cache` documents at the edge. Because `index.html` is never
long-cached, visitors get the old version on their next navigation. Target
latency: **< 5 seconds to full global effect**.

Rollbacks are themselves recorded in the `audit_log` (§8) with the actor and
reason, so "what changed and who did it" is always answerable.

### 6.3 Preview deploys
- `deploy preview` (or a GitHub webhook on push to a PR) uploads with
  `branch = feat/login`.
- It is stored as an ordinary immutable deploy and bound to the alias
  `preview-feat-login`. Production aliases (`latest`, custom domains) are
  **untouched by construction** — a preview can never accidentally promote itself.
- CI output comments the preview URL on the PR via the GitHub API.
- **Garbage collection:** previews expire after N days (default 7) or when the
  branch is deleted; a sweep job deletes objects and rows. Production deploys
  are retained per the project's retention policy.
- Optional: `previewRequiresAuth` gates preview URLs behind a short-lived link
  so unpublished work isn't world-readable.

---

## 7. Control plane

### 7.1 API surface (REST, JSON)
```
POST /api/deploy                 upload (streaming) → { deployId, url }
POST /api/rollback               { project, deployId } → { url }
GET  /api/projects               list projects + latest deploy
GET  /api/projects/:name/deploys history (paginated)
POST /api/tokens                 create CI token
DELETE /api/tokens/:id           revoke
POST /api/domains                verify + attach custom domain
GET  /internal/routes            edge route resolution (mTLS)
```
All mutating endpoints require auth (§4); idempotency keys on uploads prevent
double-charging when the CLI retries.

### 7.2 Database schema (Postgres)

```sql
projects    (id uuid pk, name citext unique, owner_id uuid fk users,
             created_at, settings jsonb)            -- retention, preview auth, CSP

deploys     (id text pk, project_id uuid fk, created_at timestamptz,
             branch text, commit_sha text, size_bytes bigint,
             checksum text, status text,              -- 'active' | 'orphaned'
             UNIQUE (project_id, id))

aliases     (project_id uuid, name text, deploy_id text, updated_at,
             updated_by uuid, PRIMARY KEY (project_id, name))

tokens      (id uuid pk, project_id uuid fk nullable, scopes text[],
             name text, hash text,                      -- SHA-256, never raw
             created_at, last_used_at, revoked_at)

domains     (id uuid pk, project_id uuid fk, host text unique,
             alias_name text, verified_at, cert_status text)

audit_log   (id bigserial pk, actor_type text, actor_id text,
             action text, project_id uuid, metadata jsonb, at timestamptz)
            -- indexed on (project_id, at) for the activity feed
```

Notes:
- `deploys` is **append-only**: rows are never updated, only inserted (status
  changes aside). This is what makes the deploys list an audit trail for free.
- Alias rows are the only hot path that mutates. Everything else is insert-only.
- `tokens.hash` stores only a SHA-256 of the token; the raw value is shown once
  at creation, so a DB leak doesn't leak credentials.

---

## 8. Security hardening

- **Upload validation:** file count, total size, and path depth caps; strip
  anything outside the project namespace (no `../`, no absolute paths, no
  symlink targets escaping the upload root). Reject binary executable bits on
  static hosting.
- **Object keys** are server-constructed from `project + deployId + relative
  path` — user input never concatenates into a key.
- **Tenant isolation:** every query is scoped by `project_id` obtained from the
  authenticated token, never from the request body.
- **Secrets:** tokens hashed at rest; S3/CDN credentials live only in the
  control plane's secret manager; edge has none.
- **Rate limits:** per-token on deploy creation, per-IP on login.
- **DoS:** deploy size caps per plan; preview GC bounds stored bytes; CDN absorbs
  read spikes by design.

---

## 9. Observability

- **Metrics** (Prometheus): deploy count/latency, upload throughput, alias flip
  latency, edge cache hit ratio, rollback frequency.
- **Logs** (structured, correlation IDs): every API call tagged with `deploy_id`
  and `project_id`; edge logs sampled at the CDN.
- **Traces**: `deploy up` spans across CLI → API → S3 → alias flip → purge, so a
  slow deploy is diagnosable end-to-end.
- **Audit**: `audit_log` doubles as the "activity feed" in the dashboard.

---

## 10. Failure modes & mitigations

| Failure                  | Impact                        | Mitigation                            |
|--------------------------|-------------------------------|---------------------------------------|
| Blob store down          | deploys fail; *reads* still work | CDN cache + edge serves from cache  |
| Control plane down       | no new deploys/rollbacks      | read path is CDN-only; site stays up  |
| Alias flip during purge  | mixed old/new index.html      | purge is async + convergent: both old and new deploy are always fully servable |
| Partial upload           | orphaned deploy               | idempotency key + GC sweep            |
| Cert expiry              | custom domain breaks          | ACME auto-renew + monitoring          |
| Preview GC deletes active branch | PR preview 404            | webhook "branch deleted" is the signal, plus a grace window |

The design goal: **reads never depend on the control plane**, so the product's
core promise (your site stays up) holds through most incidents.

---

## 11. CLI design (client)

```
deploy                    # build + upload + print URL
deploy up --project myapp # explicit name; --no-build, --dir dist
deploy preview            # upload bound to preview-<branch>
deploy rollback <id>      # flip latest
deploy list               # history for this project
deploy login              # OAuth PKCE → keychain
deploy token create       # CI tokens
deploy server             # dev: local control plane (what the prototype bundles)
```

**Provider abstraction:** the CLI is host-agnostic. A thin provider interface
(`deploy`/`rollback`/`list`/`login`) sits behind `--provider
local|netlify|vercel|cloudflare|s3`, so the same build detection and command
surface ship the same folder to the bundled control plane, the Netlify API
(digest uploads for production, zip for branch deploys), the Vercel API
(sha256 file uploads + manifest), Cloudflare Pages (direct upload), or S3
(SigV4-signed PutObject). Each provider also handles its own polling until the
host reports ready, with retries/backoff shared via `lib/http.js`. This is how
the CLI can both dogfood its own control plane and target real hosts today;
the production control plane simply becomes another provider.

The prototype implements it: `lib/providers/` with `local.js`, `netlify.js`,
`vercel.js`, `cloudflare.js`, `s3.js`, exercised by mock-API tests in
`test/providers.js` (the S3 mock recomputes the SigV4 signature from the
received request to prove signing correctness).

Implementation notes:
- Single self-contained binary (Bun/Node SEA or Go) — no runtime deps on the
  developer machine beyond the tool itself.
- Project detection order: `.deployrc.json` → `package.json` scripts → known
  output dirs (`dist`, `build`, `out`, `public`) → static root.
- Package manager sniffing by lockfile (`pnpm-lock.yaml` → pnpm, etc.).
- Streaming upload with progress; resumable on network failure via the
  idempotency key.
- Sends `User-Agent: deploy-cli/<version>`, reports version in `--version`.

---

## 12. Roadmap phases

1. **v0 (this repo):** local control plane + CLI + tar upload + aliases +
   rollback + previews. Proves the URL model end-to-end.
2. **v1:** hosted API, S3 storage, CDN in front, OAuth login, custom domains,
   CI tokens, per-project auth gates.
3. **v2:** server-side builds (GitHub/GitLab integrations), edge functions,
   preview auth links, team roles/billing.
4. **v3:** global edge deploys, function bundling, analytics on edge logs,
   enterprise SSO (SAML/OIDC).

---

## 13. What the prototype in this repo implements (and what it fakes)

| Production concept            | Prototype equivalent                                |
|-------------------------------|-----------------------------------------------------|
| Control plane API             | `lib/server.js` — local HTTP server on :8787        |
| Auth (OAuth + keychain)       | `deploy login` stores tokens in `~/.deploy-cli/config.json` (env `DEPLOY_CONFIG_DIR` overrides) |
| Blob storage                  | `storage/` directory, one folder per deploy         |
| Streaming tar upload          | real POSIX ustar tar, POSTed as a single body       |
| Real hosts                    | provider layer: Netlify digest/zip, Vercel sha-upload, Cloudflare Pages, S3 SigV4 |
| Per-deploy URLs               | `http://localhost:8787/<project>/<id>/`             |
| Aliases                       | `latest`, `preview-<branch>` pointers in `registry.json` |
| Rollback                      | `deploy rollback <id>` re-points `latest` (local); restore/promote on hosts |
| Preview deploys               | `deploy preview` → `preview-<branch>` alias         |
| Retries / backoff             | `lib/http.js` — retries network errors + 5xx/429 with jitter |
| Idempotency                   | `x-idempotency-key` header, deduped by the local server |
| Pre-flight checks             | `lib/preflight.js` — file-count/size caps with `--force` override |
| CDN / caching / TLS           | faked — local static serving, no cache              |
| Checksums                     | sha1 (Netlify digest), sha256 (Vercel upload), SigV4 payload hashes (S3) |

The URL model, alias semantics, and rollback mechanics are *real* and portable:
the same client logic speaks to the production API by changing `--server`.
