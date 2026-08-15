// Netlify provider. Uses the official REST API:
//   digest (default, production): POST /sites/{site}/deploys with { files: {path: sha1} },
//     then PUT missing files to /api/v1/deploys/{id}/files/{path}, then poll until ready.
//     Recommended by Netlify; avoids the 25k-file zip cap and 30s request timeout.
//   zip (previews/branch deploys): POST /sites/{site}/deploys?branch=… with the zip body —
//     the documented way to create branch deploys.
//   restore: POST /sites/{site}/deploys/{id}/restore
// Tokens: PATs from app.netlify.com (user settings).

import crypto from "node:crypto";
import fs from "node:fs";
import { apiFetch, hintForStatus, taggedError } from "../http.js";
import { progress } from "../format.js";
import { preflight } from "../preflight.js";
import { zipDirectory } from "../zip.js";

const BASE = () => process.env.NETLIFY_API_BASE || "https://api.netlify.com/api/v1";

export const name = "netlify";

function tokenFor(config) {
  return config.providers?.netlify?.token || process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN || null;
}

function siteFor({ flags, rc, config, project }) {
  return flags.site || rc.netlify?.site || config.providers?.netlify?.site || project;
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function request(pathname, { method = "GET", token, body, headers = {}, query = {}, retries = 3, what = "site" } = {}) {
  const url = new URL(BASE() + pathname);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await apiFetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
    retries,
    provider: "netlify",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw taggedError(`Netlify API ${res.status}: ${data.message || res.statusText}`, {
      status: res.status,
      provider: "netlify",
      hint: hintForStatus(res.status, "netlify", what),
    });
  }
  return data;
}

/** Poll GET /api/v1/deploys/{id} until state is ready (or error/timeout). */
async function waitForDeploy(token, deployId, timeoutSeconds) {
  // 120s default: brand-new auto-created sites can sit in uploading/processing
  // while Netlify provisions them, well past the old 60s window.
  const deadline = Date.now() + (timeoutSeconds || 120) * 1000;
  let lastState = "?";
  for (;;) {
    const d = await request(`/deploys/${deployId}`, { token, what: "deploy" });
    lastState = d.state;
    if (d.state === "ready") return d;
    if (d.state === "error") throw taggedError(`Netlify deploy ${deployId} failed (state=error)`, { provider: "netlify" });
    if (Date.now() > deadline) {
      throw taggedError(`Netlify deploy ${deployId} not ready after ${timeoutSeconds || 120}s (last state: ${lastState})`, {
        provider: "netlify",
        hint: "Check the deploy in your Netlify dashboard, or pass --wait=false to skip polling.",
      });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export async function login({ flags }) {
  const token = flags.token || process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    throw new Error(
      "Pass a token with --token (create one at app.netlify.com → User settings → Applications → Personal access tokens)"
    );
  }
  return { token, site: flags.site || null };
}

export async function deploy({ project, outDir, branch, preview, flags, config, rc }) {
  const token = tokenFor(config);
  if (!token) {
    throw new Error("Not logged in for Netlify. Run: deploy login --provider netlify --token <PAT>");
  }
  const site = siteFor({ flags, rc, config, project });
  let method = flags.method || "digest";
  if (branch && flags.method === "digest") {
    throw new Error("The Netlify digest method doesn't support branch (preview) deploys — use --method zip.");
  }
  if (branch && !flags.method) method = "zip"; // branch deploys are only supported via zip

  const pre = await preflight(outDir, { force: !!flags.force });
  console.log(`→ ${pre.count} files, ${(pre.total / 1024).toFixed(0)} KB (netlify ${method})`);

  let deploy = null;
  if (method === "zip") {
    const zip = await zipDirectory(outDir);
    const branchQuery = branch ? { branch } : {};
    try {
      deploy = await request(`/sites/${encodeURIComponent(site)}/deploys`, {
        method: "POST",
        token,
        body: zip,
        headers: { "Content-Type": "application/zip" },
        query: branchQuery,
        what: `site "${site}"`,
      });
    } catch (err) {
      if (err.status !== 404) throw err;
      deploy = await createSiteAndDeploy(token, site, { body: zip, headers: { "Content-Type": "application/zip" }, query: branchQuery });
    }
    if (flags.wait !== false) deploy = await waitForDeploy(token, deploy.id, flags.timeout);
  } else {
    // digest method: advertise sha1 of every file; Netlify tells us what to upload.
    const digests = {};
    for (const f of pre.files) digests["/" + f.rel] = await sha1File(f.path);
    let created;
    try {
      created = await request(`/sites/${encodeURIComponent(site)}/deploys`, {
        method: "POST",
        token,
        body: JSON.stringify({ files: digests }),
        headers: { "Content-Type": "application/json" },
        what: `site "${site}"`,
      });
    } catch (err) {
      if (err.status !== 404) throw err;
      created = await createSiteAndDeploy(token, site, { body: JSON.stringify({ files: digests }), headers: { "Content-Type": "application/json" } });
    }
    // The docs: `required` lists the files Netlify doesn't have yet, keyed by
    // SHA1 (the deploy response returns digests, NOT paths). Resolve each
    // digest back to a local file, then PUT the file content by its PATH
    // (/deploys/{id}/files/{path}).
    const required = created.required || [];
    const filesByRel = new Map(pre.files.map((f) => [f.rel, f]));
    const filesBySha = new Map();
    for (const [p, sha] of Object.entries(digests)) {
      filesBySha.set(sha, filesByRel.get(p.replace(/^\//, "")));
    }
    let done = 0;
    for (const sha of required) {
      const f = filesBySha.get(sha);
      if (!f) continue;
      const content = await fs.promises.readFile(f.path);
      const encoded = f.rel.split("/").map(encodeURIComponent).join("/");
      // BASE already ends in /api/v1, so the docs' /api/v1/deploys/… path is /deploys/…
      await request(`/deploys/${created.id}/files/${encoded}`, {
        method: "PUT",
        token,
        body: content,
        headers: { "Content-Type": "application/octet-stream" },
        what: "file upload",
      });
      done++;
      progress("uploading", done, required.length);
    }
    if (flags.wait !== false) {
      deploy = await waitForDeploy(token, created.id, flags.timeout);
    } else {
      deploy = await request(`/deploys/${created.id}`, { token, what: "deploy" });
    }
  }

  const deployUrl = deploy.deploy_ssl_url || deploy.url;
  const url = branch ? deployUrl : deploy.site_url || deploy.ssl_url || deployUrl;
  return { id: deploy.id, url, deployUrl, state: deploy.state, site, method };
}

async function createSiteAndDeploy(token, site, { body, headers, query }) {
  const siteObj = await request("/sites", {
    method: "POST",
    token,
    body: JSON.stringify({ name: site, created_via: "deploy-cli" }),
    headers: { "Content-Type": "application/json" },
    what: "site creation",
  });
  return request(`/sites/${encodeURIComponent(siteObj.id)}/deploys`, {
    method: "POST",
    token,
    body,
    headers,
    query,
    what: `site "${site}"`,
  });
}

export async function rollback({ project, deployId, flags, config, rc }) {
  const token = tokenFor(config);
  if (!token) throw new Error("Not logged in for Netlify. Run: deploy login --provider netlify");
  const site = siteFor({ flags, rc, config, project });
  const data = await request(`/sites/${encodeURIComponent(site)}/deploys/${deployId}/restore`, {
    method: "POST",
    token,
    body: "{}",
    headers: { "Content-Type": "application/json" },
    what: "deploy",
  });
  return { url: data.ssl_url || data.url || `https://${site}.netlify.app` };
}

export async function list({ project, flags, config, rc }) {
  const token = tokenFor(config);
  if (!token) throw new Error("Not logged in for Netlify. Run: deploy login --provider netlify");
  const site = siteFor({ flags, rc, config, project });
  const siteInfo = await request(`/sites/${encodeURIComponent(site)}`, { token, what: "site" });
  const published = siteInfo.published_deploy?.id || null;
  const deploys = await request(`/sites/${encodeURIComponent(site)}/deploys`, { token, what: "site" });
  return deploys.map((d) => ({
    id: d.id,
    createdAt: d.created_at,
    branch: d.branch || "main",
    url: d.deploy_ssl_url || d.url,
    production: d.id === published,
  }));
}
