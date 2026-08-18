// Tests: tar round-trip + server integration (upload, serve, auth, rollback).
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tarDirectory, extractTar } from "../lib/tar.js";
import { createServer } from "../lib/server.js";

// --- 1. tar round-trip ------------------------------------------------------
const src = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-src-"));
fs.mkdirSync(path.join(src, "nested/deeper"), { recursive: true });
fs.writeFileSync(path.join(src, "index.html"), "<h1>hi</h1>");
fs.writeFileSync(path.join(src, "nested", "app.js"), 'console.log("x")');
fs.writeFileSync(path.join(src, "nested/deeper", "empty.txt"), "");
fs.writeFileSync(path.join(src, ".deploy-secret.txt"), "should not be tarred");
fs.mkdirSync(path.join(src, "node_modules"));

const tar = await tarDirectory(src);
assert.ok(tar.length % 512 === 0, "tar is block-aligned");
assert.ok(!tar.toString("utf8").includes("secret"), "exclusions honored");

const dst = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-out-"));
extractTar(tar, dst);
assert.equal(fs.readFileSync(path.join(dst, "index.html"), "utf8"), "<h1>hi</h1>");
assert.equal(fs.readFileSync(path.join(dst, "nested", "app.js"), "utf8"), 'console.log("x")');
assert.equal(fs.readFileSync(path.join(dst, "nested/deeper/empty.txt"), "utf8"), "");

// --- 2. server integration ---------------------------------------------------
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-store-"));
const server = createServer({ storageDir: storage, token: "test-token" });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// health
const health = await (await fetch(`${base}/api/health`)).json();
assert.equal(health.ok, true);

// upload (branchless → latest)
let res = await fetch(`${base}/api/deploy?project=demo`, {
  method: "POST",
  headers: { Authorization: "Bearer test-token", "Content-Type": "application/x-tar" },
  body: tar,
});
assert.equal(res.status, 200);
const up = await res.json();
assert.match(up.url, /\/demo\/latest\/$/);
assert.equal(up.alias, "latest");
assert.ok(up.deployId);

// serve a file back through the alias
res = await fetch(`${up.url}nested/app.js`);
assert.equal(res.status, 200);
assert.equal(await res.text(), 'console.log("x")');

// serve through the immutable deploy id
res = await fetch(`${base}/demo/${up.deployId}/index.html`);
assert.equal(await res.text(), "<h1>hi</h1>");

// auth is enforced on writes
res = await fetch(`${base}/api/deploy?project=demo`, {
  method: "POST",
  headers: { Authorization: "Bearer wrong", "Content-Type": "application/x-tar" },
  body: tar,
});
assert.equal(res.status, 401);

// preview deploys get their own alias and don't touch latest
res = await fetch(`${base}/api/deploy?project=demo&branch=feat/landing`, {
  method: "POST",
  headers: { Authorization: "Bearer test-token", "Content-Type": "application/x-tar" },
  body: tar,
});
assert.equal(res.status, 200);
const prev = await res.json();
assert.match(prev.url, /\/demo\/preview-feat-landing\/$/);

// latest still points at the first deploy
res = await fetch(`${base}/api/projects`);
const registry = await res.json();
assert.equal(registry.projects.demo.aliases.latest, up.deployId);
assert.equal(registry.projects.demo.aliases["preview-feat-landing"], prev.deployId);

// rollback flips latest to a previous deploy (here: the preview's deploy id)
res = await fetch(`${base}/api/rollback`, {
  method: "POST",
  headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
  body: JSON.stringify({ project: "demo", deployId: prev.deployId }),
});
assert.equal(res.status, 200);
const rb = await res.json();
assert.match(rb.url, /\/demo\/latest\/$/);
const registry2 = await (await fetch(`${base}/api/projects`)).json();
assert.equal(registry2.projects.demo.aliases.latest, prev.deployId);

// 404 for unknown deploy
res = await fetch(`${base}/demo/does-not-exist/`);
assert.equal(res.status, 404);

// --- 2b. SPA fallback: deep links serve index.html, missing assets stay 404 --------
// route without extension → app shell
res = await fetch(`${base}/demo/latest/about`);
assert.equal(res.status, 200);
assert.equal(await res.text(), "<h1>hi</h1>");

// nested route
res = await fetch(`${base}/demo/latest/team/contact`);
assert.equal(res.status, 200);
assert.equal(await res.text(), "<h1>hi</h1>");

// trailing-slash route
res = await fetch(`${base}/demo/latest/team/`);
assert.equal(res.status, 200);
assert.equal(await res.text(), "<h1>hi</h1>");

// real asset still serves
res = await fetch(`${base}/demo/latest/nested/app.js`);
assert.equal(res.status, 200);
assert.equal(await res.text(), 'console.log("x")');

// missing asset must NOT fall back to HTML
res = await fetch(`${base}/demo/latest/nested/missing.js`);
assert.equal(res.status, 404);
res = await fetch(`${base}/demo/latest/favicon.ico`);
assert.equal(res.status, 404);

// unknown deploy still 404s on a deep link
res = await fetch(`${base}/demo/does-not-exist/about`);
assert.equal(res.status, 404);

// --- 3. idempotency: the same key must not create a duplicate deploy -------------
const idemKey = "idem-key-1";
const idemHeaders = {
  Authorization: "Bearer test-token",
  "Content-Type": "application/x-tar",
  "x-idempotency-key": idemKey,
};
const dupA = await (await fetch(`${base}/api/deploy?project=demo`, { method: "POST", headers: idemHeaders, body: tar })).json();
const dupB = await (await fetch(`${base}/api/deploy?project=demo`, { method: "POST", headers: idemHeaders, body: tar })).json();
assert.equal(dupA.deployId, dupB.deployId, "same key → same deploy");
assert.equal(dupB.duplicate, true);

// --- 4. files listing endpoint (used by deploy diff) ------------------------------
const filesRes = await fetch(`${base}/api/projects/demo/deploys/${dupA.deployId}/files`);
assert.equal(filesRes.status, 200);
const filesData = await filesRes.json();
assert.ok(filesData.files.some((f) => f.path === "index.html" && typeof f.size === "number"));
assert.ok(filesData.files.some((f) => f.path === "nested/app.js"));

server.close();
console.log("✔ all tests passed (tar round-trip, upload, serve, auth, preview, rollback, idempotency, files)");
