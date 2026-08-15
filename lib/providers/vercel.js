// Vercel provider. Uses the REST API (contract verified 2026-08 against
// vercel.com/docs/rest-api/deployments/upload-deployment-files):
//   POST /v2/files                   upload each file (x-vercel-digest: sha1)
//   POST /v13/deployments            create deployment referencing uploaded shas
//   GET  /v9/projects?name=          resolve a project id by name
//   POST /v9/projects/{id}/rollback/{deploymentId}   instant rollback (as the Vercel CLI uses)
//   GET  /v6/deployments             history
// Tokens: from vercel.com/account/tokens.

import crypto from "node:crypto";
import fs from "node:fs";
import { apiFetch, hintForStatus, taggedError } from "../http.js";
import { progress } from "../format.js";
import { preflight } from "../preflight.js";

const BASE = () => process.env.VERCEL_API_BASE || "https://api.vercel.com";

export const name = "vercel";

function tokenFor(config) {
  return config.providers?.vercel?.token || process.env.VERCEL_TOKEN || null;
}

function teamFor(flags, config) {
  return flags.team || config.providers?.vercel?.teamId || process.env.VERCEL_TEAM_ID || null;
}

function projectFor({ flags, rc, project }) {
  return flags.project || rc.vercel?.project || project;
}

async function request(pathname, { method = "GET", token, body, headers = {}, query = {}, retries = 3, what = "project" } = {}) {
  const url = new URL(BASE() + pathname);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await apiFetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
    retries,
    provider: "vercel",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error?.message || data.error?.code || res.statusText;
    throw taggedError(`Vercel API ${res.status}: ${detail}`, {
      status: res.status,
      provider: "vercel",
      hint: hintForStatus(res.status, "vercel", what),
    });
  }
  return data;
}

async function getProject(name, token, flags, config) {
  const data = await request("/v9/projects", {
    token,
    query: { name, teamId: teamFor(flags, config) },
    what: `project "${name}"`,
  });
  const project = (data.projects || []).find((p) => p.name === name);
  if (!project) throw new Error(`Vercel project "${name}" not found — deploy once first`);
  return project;
}

export async function login({ flags }) {
  const token = flags.token || process.env.VERCEL_TOKEN;
  if (!token) {
    throw new Error("Pass a token with --token (create one at vercel.com/account/tokens)");
  }
  return { token, teamId: flags.team || null };
}

/** Poll GET /v13/deployments/{id} until readyState is READY (or error). The
 * creation response can return before the build finishes; the alias only
 * serves the new content once the deployment is READY. */
async function waitForReady(token, deployId, timeoutSeconds) {
  const deadline = Date.now() + (timeoutSeconds || 90) * 1000;
  let last = null;
  for (;;) {
    const d = await request(`/v13/deployments/${deployId}`, { token, what: "deployment" });
    last = d.readyState;
    if (d.readyState === "READY") return d;
    if (d.readyState === "ERROR" || d.readyState === "CANCELED" || d.readyState === "BLOCKED") {
      throw taggedError(`Vercel deploy ${deployId} ended with state "${d.readyState}"${d.errorMessage ? ": " + d.errorMessage : ""}`, {
        provider: "vercel",
      });
    }
    if (Date.now() > deadline) {
      throw taggedError(`Vercel deploy ${deployId} not ready after ${timeoutSeconds || 90}s (last state: ${last})`, {
        provider: "vercel",
        hint: "Check the deployment in your Vercel dashboard, or pass --no-wait to skip polling.",
      });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Upload every file once via POST /v2/files, keyed by SHA1 (the documented
 * digest for the upload API and for deployment file references), and return
 * the manifest entries Vercel expects ({ file, sha, size }). A 409 (already
 * exists) is treated as success, as is the 200 "file already uploaded" reply.
 */
async function uploadFiles(token, files) {
  const manifest = [];
  let done = 0;
  for (const f of files) {
    const content = await fs.promises.readFile(f.path);
    const sha = crypto.createHash("sha1").update(content).digest("hex");
    const st = await fs.promises.stat(f.path);
    const url = new URL(BASE() + "/v2/files");
    const res = await apiFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(content.length),
        // exact header set the Vercel CLI sends today (x-now-*), with the SHA1 digest
        "x-now-digest": sha,
        "x-now-size": String(content.length),
      },
      body: content,
      retries: 3,
      provider: "vercel",
    });
    if (res.status !== 200 && res.status !== 409) {
      const data = await res.json().catch(() => ({}));
      throw taggedError(`Vercel API ${res.status} uploading ${f.rel}: ${data.error?.message || res.statusText}`, {
        status: res.status,
        provider: "vercel",
        hint: hintForStatus(res.status, "vercel", "file upload"),
      });
    }
    // `mode` (stat bits) is required so Vercel can classify the file
    // (regular vs executable vs symlink) — the CLI always sends it.
    manifest.push({ file: f.rel, sha, size: content.length, mode: st.mode });
    done++;
    progress("uploading", done, files.length);
  }
  return manifest;
}

export async function deploy({ project, outDir, branch, preview, flags, config, rc }) {
  const token = tokenFor(config);
  if (!token) {
    throw new Error("Not logged in for Vercel. Run: deploy login --provider vercel --token <token>");
  }
  const name = projectFor({ flags, rc, project });
  const pre = await preflight(outDir, { force: !!flags.force });
  console.log(`→ ${pre.count} files, ${(pre.total / 1024).toFixed(0)} KB (vercel)`);

  const files = await uploadFiles(token, pre.files);
  const body = {
    name,
    files,
    // We ship already-built output; tell Vercel not to run its own build.
    projectSettings: {
      framework: null,
      buildCommand: null,
      installCommand: null,
      devCommand: null,
      outputDirectory: null,
    },
    ...(preview || branch ? {} : { target: "production" }),
  };
  let data = await request("/v13/deployments", {
    method: "POST",
    token,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    query: {
      forceNew: "1",
      skipAutoDetectionConfirmation: "1",
      teamId: teamFor(flags, config),
    },
    what: "deployment creation",
  });
  // Wait for READY before claiming the URL: the alias only serves the new
  // content once the build finishes (mirrors the Vercel CLI's flow).
  if (flags.wait !== false) {
    data = await waitForReady(token, data.id, flags.timeout);
  }

  const deployUrl = data.url ? `https://${data.url}` : null;
  const alias = Array.isArray(data.alias) && data.alias[0];
  const url = alias ? (alias.startsWith("http") ? alias : `https://${alias}`) : deployUrl;
  return { id: data.id, url, deployUrl, state: data.readyState };
}

export async function rollback({ project, deployId, flags, config, rc }) {
  const token = tokenFor(config);
  if (!token) throw new Error("Not logged in for Vercel. Run: deploy login --provider vercel");
  const name = projectFor({ flags, rc, project });
  const proj = await getProject(name, token, flags, config);
  await request(`/v9/projects/${encodeURIComponent(proj.id)}/rollback/${deployId}`, {
    method: "POST",
    token,
    body: "{}",
    headers: { "Content-Type": "application/json" },
    query: { teamId: teamFor(flags, config) },
    what: "deployment",
  });
  return { url: `https://${name}.vercel.app` };
}

export async function list({ project, flags, config, rc }) {
  const token = tokenFor(config);
  if (!token) throw new Error("Not logged in for Vercel. Run: deploy login --provider vercel");
  const name = projectFor({ flags, rc, project });
  const proj = await getProject(name, token, flags, config);
  const data = await request("/v6/deployments", {
    token,
    query: { projectId: proj.id, limit: "25", teamId: teamFor(flags, config) },
    what: "deployments",
  });
  return (data.deployments || []).map((d) => ({
    id: d.uid,
    createdAt: new Date(d.createdAt).toISOString(),
    branch: d.meta?.githubCommitRef || "main",
    url: d.url ? `https://${d.url}` : null,
    production: d.target === "production" && d.readyState === "READY",
  }));
}
