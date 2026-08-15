// Cloudflare Pages provider. Uses the direct-upload API:
//   POST /accounts/{a}/pages/projects/{p}/deployments   create deployment (files: {path: sha256})
//   POST <upload_url> (multipart)                        upload missing files (pre-signed fields + file)
//   GET  .../deployments/{id}                            poll until success
//   GET  .../deployments                                 history
// Tokens: Cloudflare API token with "Cloudflare Pages: Edit" permission.
// Note: Pages has no rollback API — that command reports it clearly.

import crypto from "node:crypto";
import fs from "node:fs";
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

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/** Build a multipart/form-data body: pre-signed fields plus the file part. */
function multipart(fields, filename, content) {
  const boundary = "----deploycli" + crypto.randomBytes(8).toString("hex");
  const safeName = filename.replace(/["\r\n]/g, "_");
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    )
  );
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

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

  const digests = {};
  for (const f of pre.files) digests["/" + f.rel] = await sha256File(f.path);

  let result;
  try {
    result = (
      await request(`/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(name)}/deployments`, {
        method: "POST",
        token,
        body: JSON.stringify({ files: digests }),
        headers: { "Content-Type": "application/json" },
        what: `project "${name}"`,
      })
    ).result;
  } catch (err) {
    if (err.status !== 404) throw err;
    await request(`/accounts/${encodeURIComponent(account)}/pages/projects`, {
      method: "POST",
      token,
      body: JSON.stringify({ name, production_branch: "main" }),
      headers: { "Content-Type": "application/json" },
      what: "project creation",
    });
    result = (
      await request(`/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(name)}/deployments`, {
        method: "POST",
        token,
        body: JSON.stringify({ files: digests }),
        headers: { "Content-Type": "application/json" },
        what: `project "${name}"`,
      })
    ).result;
  }

  const required = result.required || {};
  const paths = Object.keys(required);
  const filesByRel = new Map(pre.files.map((f) => [f.rel, f]));
  let done = 0;
  for (const p of paths) {
    const rel = p.replace(/^\//, "");
    const f = filesByRel.get(rel);
    if (!f) continue;
    const content = await fs.promises.readFile(f.path);
    const form = multipart(result.form_fields || {}, f.rel, content);
    const res = await apiFetch(result.upload_url, {
      method: "POST",
      headers: { "Content-Type": form.contentType },
      body: form.body,
      retries: 3,
      provider: "cloudflare",
    });
    if (!res.ok) {
      throw taggedError(`Cloudflare upload failed (${res.status}) for ${f.rel}`, {
        status: res.status,
        provider: "cloudflare",
        hint: hintForStatus(res.status, "cloudflare", "file upload"),
      });
    }
    done++;
    progress("uploading", done, paths.length);
  }

  let deploy = result;
  if (flags.wait !== false) {
    deploy = await waitForDeploy(token, account, name, result.id, flags.timeout);
  }
  const url = deploy.url || result.url;
  return { id: deploy.id || result.id, url, deployUrl: url, state: deploy.status || "queued", account, project: name };
}

async function waitForDeploy(token, account, project, deployId, timeoutSeconds) {
  const deadline = Date.now() + (timeoutSeconds || 60) * 1000;
  for (;;) {
    const data = await request(
      `/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(project)}/deployments/${deployId}`,
      { token, what: "deployment" }
    );
    const d = data.result;
    if (d.status === "success") return d;
    if (d.status === "failure" || d.status === "cancelled") {
      throw taggedError(`Cloudflare deploy ${deployId} ended with status "${d.status}"`, { provider: "cloudflare" });
    }
    if (Date.now() > deadline) {
      throw taggedError(`Cloudflare deploy ${deployId} not ready after ${timeoutSeconds || 60}s`, {
        provider: "cloudflare",
        hint: "Check the deployment in the Cloudflare dashboard, or pass --wait=false.",
      });
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
