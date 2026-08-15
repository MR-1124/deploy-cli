// Thin HTTP client for the local control plane API. Uses global fetch (Node >= 18).

import { apiFetch, taggedError } from "./http.js";

async function request(server, pathname, { method = "GET", token, body, headers = {} } = {}) {
  const res = await apiFetch(new URL(server + pathname), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
    retries: 2,
    provider: "local",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw taggedError(data.error || `Request failed (${res.status})`, {
      status: res.status,
      provider: "local",
      hint: res.status === 401 ? "Your local control plane token was rejected — run: deploy login" : null,
    });
  }
  return data;
}

/** Upload a tar archive as a new deploy. branch=null/'' deploys to `latest`. */
export function uploadDeploy({ server, token, project, branch, tar, idempotencyKey }) {
  const qs = new URLSearchParams({ project });
  if (branch) qs.set("branch", branch);
  return request(server, `/api/deploy?${qs}`, {
    method: "POST",
    token,
    body: tar,
    headers: {
      "Content-Type": "application/x-tar",
      ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
    },
  });
}

/** Re-point the `latest` alias at a previous deploy id. */
export function rollbackDeploy({ server, token, project, deployId }) {
  return request(server, "/api/rollback", {
    method: "POST",
    token,
    body: JSON.stringify({ project, deployId }),
    headers: { "Content-Type": "application/json" },
  });
}

export function listProjects(server) {
  return request(server, "/api/projects");
}

/** List the files of one deploy (path + size) — used by `deploy diff`. */
export function deployFiles(server, project, deployId, token) {
  return request(
    server,
    `/api/projects/${encodeURIComponent(project)}/deploys/${encodeURIComponent(deployId)}/files`,
    { token }
  );
}

export function health(server) {
  return request(server, "/api/health");
}
