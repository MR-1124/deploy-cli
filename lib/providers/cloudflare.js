// Cloudflare Pages provider. Uses the current direct-upload API (the same flow
// wrangler uses):
//   GET  .../projects/{p}/upload-token    short-lived upload JWT
//   POST /pages/assets/check-missing      which content hashes are missing (Bearer JWT)
//   POST /pages/assets/upload             upload missing files, keyed by hash (Bearer JWT)
//   POST /pages/assets/upsert-hashes      register the hashes (Bearer JWT)
//   POST .../projects/{p}/deployments     create deployment — multipart form-data with a
//                                         `manifest` JSON field: {path: hash} (API token)
//   GET  .../deployments/{id}             poll until success
// Content hashes must match wrangler exactly: the API keys assets by
//   blake3(base64(file contents) + file extension).hex.slice(0, 32)
// (see @cloudflare/deploy-helpers hashFile), NOT plain sha256 of the bytes.
// Using any other hash makes the deployment "succeed" but serve HTTP 500 for
// every asset, because the platform can't resolve the manifest to stored files.
// Tokens: Cloudflare API token with "Cloudflare Pages: Edit" permission.
// Note: Pages has no rollback API — that command reports it clearly.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { blake3 } from "hash-wasm";
import { apiFetch, hintForStatus, taggedError } from "../http.js";
import { progress } from "../format.js";
import { preflight } from "../preflight.js";

const BASE = () => process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4";

export const name = "cloudflare";

function tokenFor(config) {
  return config.providers?.cloudflare?.token || process.env.CLOUDFLARE_API_TOKEN || null;
}

function accountFor(flags, config) {
  return flags.account || config.providers?.cloudflare?.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || null;
}

function projectFor({ flags, rc, project }) {
  return flags.project || rc.cloudflare?.project || project;
}

async function request(pathname, { method = "GET", token, body, headers = {}, retries = 3, what = "project" } = {}) {
  const res = await apiFetch(new URL(BASE() + pathname), {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
    retries,
    provider: "cloudflare",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.errors?.[0]?.message || data.message || res.statusText;
    throw taggedError(`Cloudflare API ${res.status}: ${detail}`, {
      status: res.status,
      provider: "cloudflare",
      hint: hintForStatus(res.status, "cloudflare", what),
    });
  }
  return data;
}

/**
 * Cloudflare Pages content hash — must match wrangler byte-for-byte:
 *   hashFile = blake3(base64(contents) + extname(file).slice(1)).hex.slice(0, 32)
 */
async function pagesHash(file, rel) {
  const content = await fs.promises.readFile(file);
  const ext = path.extname(String(rel)).slice(1);
  return (await blake3(content.toString("base64") + ext)).slice(0, 32);
}

/** Multipart/form-data body with text fields only (the manifest form). */
function formFields(fields) {
  const boundary = "----deploycli" + crypto.randomBytes(8).toString("hex");
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const MIME_BY_EXT = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".mjs": "application/javascript", ".json": "application/json", ".map": "application/json",
  ".txt": "text/plain", ".md": "text/markdown", ".xml": "application/xml", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject", ".pdf": "application/pdf", ".wasm": "application/wasm",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
};

const contentTypeFor = (rel) => MIME_BY_EXT[path.extname(String(rel)).toLowerCase()] || "application/octet-stream";

const assetUrl = (p) => new URL(BASE() + p);

export async function login({ flags }) {
  const token = flags.token || process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error(
      "Pass a token with --token (create one at dash.cloudflare.com → My Profile → API Tokens, with Pages:Edit permission)"
    );
  }
  return { token, accountId: flags.account || process.env.CLOUDFLARE_ACCOUNT_ID || null };
}

export async function deploy({ project, outDir, branch, preview, flags, config, rc }) {
  const token = tokenFor(config);
  if (!token) {
    throw new Error("Not logged in for Cloudflare Pages. Run: deploy login --provider cloudflare --token <token>");
  }
  const account = accountFor(flags, config);
  if (!account) {
    throw new Error("Cloudflare account id required: pass --account or set providers.cloudflare.accountId");
  }
  const name = projectFor({ flags, rc, project });
  const pre = await preflight(outDir, { force: !!flags.force });
  console.log(`→ ${pre.count} files, ${(pre.total / 1024).toFixed(0)} KB (cloudflare pages)`);

  // manifest: { "/index.html": "<blake3 hash>" } — the exact shape the API expects
  const digests = {};
  for (const f of pre.files) digests["/" + f.rel] = await pagesHash(f.path, f.rel);
  const projBase = `/accounts/${encodeURIComponent(account)}/pages/projects`;

  // ensure the project exists (auto-create on 404)
  try {
    await request(`${projBase}/${encodeURIComponent(name)}`, { token, what: `project "${name}"` });
  } catch (err) {
    if (err.status !== 404) throw err;
    await request(projBase, {
      method: "POST",
      token,
      body: JSON.stringify({ name, production_branch: "main" }),
      headers: { "Content-Type": "application/json" },
      what: "project creation",
    });
  }

  // Direct upload: a short-lived JWT authorizes asset uploads keyed by content
  // hash; the deployment then references those hashes via the manifest field.
  const jwtData = await request(`${projBase}/${encodeURIComponent(name)}/upload-token`, {
    token,
    what: "upload token",
  });
  const jwt = jwtData.result?.jwt || jwtData.jwt;
  if (!jwt) {
    throw new Error(`Cloudflare upload-token response missing jwt: ${JSON.stringify(jwtData).slice(0, 200)}`);
  }

  const hashes = Object.values(digests);
  const filesByHash = new Map(pre.files.map((f) => [digests["/" + f.rel], f]));

  // optimization: skip content Cloudflare already has; on failure upload all
  let missing = hashes;
  try {
    const res = await apiFetch(assetUrl("/pages/assets/check-missing"), {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hashes }),
      retries: 3,
      provider: "cloudflare",
    });
    const data = await res.json().catch(() => ({}));
    missing = Array.isArray(data) ? data : Array.isArray(data.result) ? data.result : [];
  } catch {
    // non-fatal — upload everything below
  }

  const toUpload = [...new Set(missing)].map((h) => filesByHash.get(h)).filter(Boolean);
  if (toUpload.length) {
    const BATCH_SIZE = 50;
    let done = 0;
    for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
      const batch = toUpload.slice(i, i + BATCH_SIZE);
      const payload = [];
      for (const f of batch) {
        const content = await fs.promises.readFile(f.path);
        payload.push({
          key: digests["/" + f.rel],
          value: content.toString("base64"),
          metadata: { contentType: contentTypeFor(f.rel) },
          base64: true,
        });
      }
      const up = await apiFetch(assetUrl("/pages/assets/upload"), {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        retries: 3,
        provider: "cloudflare",
      });
      if (!up.ok) {
        const detail = (await up.text().catch(() => "")).slice(0, 200);
        throw taggedError(`Cloudflare asset upload failed (${up.status}): ${detail || up.statusText}`, {
          status: up.status,
          provider: "cloudflare",
          hint: "Check the API token has Pages:Edit permission and the upload JWT is valid.",
        });
      }
      done += batch.length;
      progress("uploading", done, toUpload.length);
    }
  }
  try {
    await apiFetch(assetUrl("/pages/assets/upsert-hashes"), {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hashes }),
      retries: 3,
      provider: "cloudflare",
    });
  } catch {
    // non-fatal: only means the next deploy re-uploads instead of deduping
  }

  // create the deployment — multipart form-data with the manifest JSON field
  const fields = { manifest: JSON.stringify(digests) };
  if (branch) fields.branch = branch;
  const form = formFields(fields);
  const result = (
    await request(`${projBase}/${encodeURIComponent(name)}/deployments`, {
      method: "POST",
      token,
      body: form.body,
      headers: { "Content-Type": form.contentType },
      what: `project "${name}"`,
    })
  ).result;

  let deploy = result;
  if (flags.wait !== false) {
    deploy = await waitForDeploy(token, account, name, result.id, flags.timeout);
  }
  const url = deploy.url || result.url;
  const state = deploy?.latest_stage?.status || deploy?.status || "queued";
  return { id: deploy.id || result.id, url, deployUrl: url, state, account, project: name };
}

async function waitForDeploy(token, account, project, deployId, timeoutSeconds) {
  const deadline = Date.now() + (timeoutSeconds || 60) * 1000;
  for (;;) {
    const data = await request(
      `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(project)}/deployments/${deployId}`,
      { token, what: "deployment" }
    );
    const d = data.result;
    // the deployment status lives in latest_stage.status (the top-level
    // `status` field is gone from the current API)
    const status = d?.latest_stage?.status || d?.status;
    if (status === "success") return d;
    if (status === "failure" || status === "cancelled" || status === "canceled") {
      throw taggedError(`Cloudflare deploy ${deployId} ended with status "${status}"`, { provider: "cloudflare" });
    }
    if (Date.now() > deadline) {
      throw taggedError(
        `Cloudflare deploy ${deployId} not ready after ${timeoutSeconds || 60}s (last state: ${status || "unknown"})`,
        {
          provider: "cloudflare",
          hint: "Check the deployment in the Cloudflare dashboard, or pass --wait=false.",
        }
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function rollback() {
  throw new Error(
    "Cloudflare Pages has no rollback API — restore from your dashboard (Deployments → ... → Rollback) or redeploy the previous content."
  );
}

export async function list({ project, flags, config, rc }) {
  const token = tokenFor(config);
  if (!token) throw new Error("Not logged in for Cloudflare Pages. Run: deploy login --provider cloudflare");
  const account = accountFor(flags, config);
  if (!account) throw new Error("Cloudflare account id required: pass --account");
  const name = projectFor({ flags, rc, project });
  const data = await request(
    `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(name)}/deployments`,
    { token, what: "project" }
  );
  const rows = (data.result || []).map((d) => ({
    id: d.id,
    createdAt: d.created_on,
    branch: d.deployment_trigger?.branch || "main",
    url: d.url,
    production: d.production_branch === true,
  }));
  return rows;
}
