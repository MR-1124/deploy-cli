// The bundled local "control plane": receives uploads, stores them under
// storage/<project>/<deployId>/, keeps an alias registry, and serves files.
// In production this is split into an API + blob storage + CDN (see ARCHITECTURE.md).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { extractTar } from "./tar.js";
import { listFiles } from "./files.js";

const REGISTRY_FILE = "registry.json";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

function contentType(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function deployId() {
  const d = new Date();
  const ts =
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(d.getUTCDate()).padStart(2, "0")}-` +
    `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}` +
    `${String(d.getUTCSeconds()).padStart(2, "0")}`;
  return `${ts}-${crypto.randomBytes(2).toString("hex")}`;
}

function loadRegistry(storageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(storageDir, REGISTRY_FILE), "utf8"));
  } catch {
    return { projects: {} };
  }
}

function saveRegistry(storageDir, registry) {
  const file = path.join(storageDir, REGISTRY_FILE);
  const tmp = file + ".tmp";
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, file);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function authOk(req, token) {
  const header = req.headers["authorization"] || "";
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeJoin(base, ...parts) {
  const root = path.resolve(base);
  const p = path.resolve(root, ...parts);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error("path escapes storage");
  return p;
}

function resolveDeployDir(storageDir, project, ref) {
  const projectDir = safeJoin(storageDir, project);
  if (!fs.existsSync(projectDir)) return null;
  const registry = loadRegistry(storageDir);
  const entry = registry.projects[project];
  if (!entry) return null;
  // ref can be an alias (latest, preview-...) or a raw deploy id
  const id = (entry.aliases && entry.aliases[ref]) || ref;
  if (!id) return null;
  const dir = safeJoin(projectDir, id);
  return fs.existsSync(dir) ? dir : null;
}

function serveStatic(res, filePath) {
  let target = filePath;
  try {
    if (fs.statSync(target).isDirectory()) {
      const idx = path.join(target, "index.html");
      if (!fs.existsSync(idx)) return sendText(res, 404, "Not found");
      target = idx;
    }
    const data = fs.readFileSync(target);
    res.writeHead(200, {
      "Content-Type": contentType(target),
      "Content-Length": data.length,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function indexPage(registry, base) {
  const projects = Object.entries(registry.projects)
    .map(([name, p]) => {
      const latest = p.aliases && p.aliases.latest ? p.aliases.latest : null;
      const deploys = p.deploys.length;
      return `<li><a href="${base}/${name}/latest/">${name}</a>
        <span class="muted">— ${deploys} deploy${deploys === 1 ? "" : "s"}${latest ? `, latest ${latest}` : ""}</span></li>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>deploy</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;line-height:1.6}
h1{font-size:1.4rem}.muted{color:#777}li{margin:.4rem 0}</style>
<h1>deploy · local control plane</h1>
<ul>${projects || "<li class='muted'>No deploys yet — run <code>deploy up</code> in a project.</li>"}</ul>`;
}

export function createServer({ storageDir, token = "dev-token" }) {
  fs.mkdirSync(storageDir, { recursive: true });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const base = `http://${req.headers.host || "localhost"}`;

    try {
      // --- health & index -------------------------------------------------
      if (url.pathname === "/healthz" || (parts[0] === "api" && parts[1] === "health")) {
        return json(res, 200, { ok: true, service: "deploy", storage: storageDir });
      }
      if (url.pathname === "/" && req.method === "GET") {
        const html = indexPage(loadRegistry(storageDir), base);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      // --- API: writes require auth --------------------------------------
      if (parts[0] === "api" && parts[1] === "deploy" && req.method === "POST") {
        if (!authOk(req, token)) return json(res, 401, { error: "unauthorized" });
        const project = (url.searchParams.get("project") || "").replace(/[^a-z0-9-]/gi, "").toLowerCase();
        const branch = url.searchParams.get("branch") || null;
        if (!project) return json(res, 400, { error: "missing project" });

        // Idempotency: a retried upload with the same key returns the original
        // result instead of creating a duplicate deploy.
        const idemKey = req.headers["x-idempotency-key"] || null;
        const registry = loadRegistry(storageDir);
        registry.idempotency = registry.idempotency || {};
        if (idemKey && registry.idempotency[idemKey]) {
          const prev = registry.idempotency[idemKey];
          return json(res, 200, {
            ...prev,
            url: `${base}/${prev.project}/${prev.alias}/`,
            deployUrl: `${base}/${prev.project}/${prev.deployId}/`,
            duplicate: true,
          });
        }

        const tar = await readBody(req);
        if (tar.length === 0) return json(res, 400, { error: "empty upload" });

        const id = deployId();
        const deployDir = safeJoin(storageDir, project, id);
        extractTar(tar, deployDir);

        const entry = (registry.projects[project] ||= { deploys: [], aliases: {} });
        const alias = branch ? `preview-${branch.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}` : "latest";
        entry.deploys.push({ id, createdAt: new Date().toISOString(), branch: branch || "main", alias });
        entry.aliases[alias] = id;
        const response = {
          deployId: id,
          project,
          branch: branch || "main",
          alias,
          url: `${base}/${project}/${alias}/`,
          deployUrl: `${base}/${project}/${id}/`,
        };
        if (idemKey) registry.idempotency[idemKey] = response;
        saveRegistry(storageDir, registry);

        return json(res, 200, response);
      }

      if (parts[0] === "api" && parts[1] === "rollback" && req.method === "POST") {
        if (!authOk(req, token)) return json(res, 401, { error: "unauthorized" });
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const project = String(body.project || "").toLowerCase();
        const deployIdTo = String(body.deployId || "");
        if (!project || !deployIdTo) return json(res, 400, { error: "missing project or deployId" });
        const registry = loadRegistry(storageDir);
        const entry = registry.projects[project];
        if (!entry || !entry.deploys.some((d) => d.id === deployIdTo)) {
          return json(res, 404, { error: "deploy not found" });
        }
        entry.aliases.latest = deployIdTo;
        saveRegistry(storageDir, registry);
        return json(res, 200, {
          project,
          deployId: deployIdTo,
          url: `${base}/${project}/latest/`,
        });
      }

      if (parts[0] === "api" && parts[1] === "projects" && parts.length === 2 && req.method === "GET") {
        return json(res, 200, loadRegistry(storageDir));
      }

      // list the files of one deploy (used by `deploy diff`)
      if (
        parts[0] === "api" && parts[1] === "projects" && parts[3] === "deploys" &&
        parts[5] === "files" && req.method === "GET"
      ) {
        const [, , project, , deployId] = parts;
        const deployDir = resolveDeployDir(storageDir, project, deployId);
        if (!deployDir) return json(res, 404, { error: "deploy not found" });
        const files = (await listFiles(deployDir)).filter((f) => f.type === "file");
        return json(res, 200, {
          deployId,
          files: files.map((f) => ({ path: f.rel, size: f.size })),
        });
      }

      // --- static files ---------------------------------------------------
      if (req.method === "GET" || req.method === "HEAD") {
        const [project, ref, ...rest] = parts;
        if (!project || !ref) return sendText(res, 404, "Not found");
        const deployDir = resolveDeployDir(storageDir, project, ref);
        if (!deployDir) return sendText(res, 404, "Not found");
        const rel = rest.length ? rest.join("/") : "";
        const filePath = safeJoin(deployDir, rel);
        if (req.method === "HEAD") {
          try {
            const stat = fs.statSync(filePath);
            res.writeHead(200, { "Content-Length": stat.size });
            return res.end();
          } catch {
            return sendText(res, 404, "Not found");
          }
        }
        return serveStatic(res, filePath);
      }

      sendText(res, 405, "Method not allowed");
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
}
