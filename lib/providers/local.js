// The bundled local control plane provider (the original deploy flow).

import crypto from "node:crypto";
import { normalizeServer } from "../config.js";
import { deployFiles, listProjects, rollbackDeploy, uploadDeploy } from "../upload.js";
import { preflight } from "../preflight.js";
import { tarDirectory } from "../tar.js";

export const name = "local";

function endpoint(config) {
  if (!config.server || !config.token) {
    throw new Error("Not logged in for the local control plane. Run: deploy login");
  }
  return { server: normalizeServer(config.server), token: config.token };
}

export async function deploy({ project, outDir, branch, config, flags }) {
  const { server, token } = endpoint(config);
  const pre = await preflight(outDir, { force: !!flags?.force });
  console.log(`→ ${pre.count} files, ${(pre.total / 1024).toFixed(0)} KB (local)`);
  const tar = await tarDirectory(outDir);
  const idempotencyKey = crypto.randomUUID();
  const data = await uploadDeploy({ server, token, project, branch, tar, idempotencyKey });
  return { id: data.deployId, url: data.url, deployUrl: data.deployUrl, bytes: tar.length };
}

export async function rollback({ project, deployId, config }) {
  const { server, token } = endpoint(config);
  const data = await rollbackDeploy({ server, token, project, deployId });
  return { url: data.url };
}

export async function list({ project, config }) {
  const { server } = endpoint(config);
  const data = await listProjects(server);
  const entry = data.projects && data.projects[project];
  const aliases = entry?.aliases || {};
  return (entry?.deploys || []).map((d) => ({
    id: d.id,
    createdAt: d.createdAt,
    branch: d.branch,
    url: null,
    production: aliases.latest === d.id,
    aliases: Object.entries(aliases)
      .filter(([, id]) => id === d.id)
      .map(([n]) => n),
  }));
}

/** List files of a specific deploy (used by `deploy diff`). */
export async function files({ project, deployId, config }) {
  const { server, token } = endpoint(config);
  return deployFiles(server, project, deployId, token);
}
