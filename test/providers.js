// Provider tests: run the real provider client code against mock HTTP servers
// that emulate each host API, asserting method/path/auth/payload correctness.
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { zipDirectory } from "../lib/zip.js";
import { PROVIDERS } from "../lib/providers/index.js";

// --- helpers ----------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const baseOf = (server) => `http://127.0.0.1:${server.address().port}`;

// Minimal ZIP reader (store method only): returns { name: content }.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd !== -1, "EOCD found");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const files = {};
  let off = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, "central dir signature");
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const compSize = buf.readUInt32LE(off + 20);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, "local header signature");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    files[name] = buf.subarray(dataOff, dataOff + compSize).toString("utf8");
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// --- fixtures ----------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "provider-site-"));
fs.mkdirSync(path.join(tmp, "assets"));
fs.writeFileSync(path.join(tmp, "index.html"), "<h1>hello providers</h1>");
fs.writeFileSync(path.join(tmp, "assets", "app.css"), "body { color: rebeccapurple; }");

const INDEX = fs.readFileSync(path.join(tmp, "index.html"));
const CSS = fs.readFileSync(path.join(tmp, "assets", "app.css"));

// =============================================================================
// Netlify
// =============================================================================

const netlifyServer = await startServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.headers.authorization !== "Bearer nfp_test") return json(res, 401, { message: "unauthorized" });
  const body = await readBody(req);
  const ct = req.headers["content-type"] || "";

  // create site (JSON)
  if (url.pathname === "/api/v1/sites" && req.method === "POST") {
    assert.ok(ct.startsWith("application/json"));
    return json(res, 200, { id: "site-new", name: "brand-new", url: "https://brand-new.netlify.app" });
  }
  // production digest deploy
  if (url.pathname === "/api/v1/sites/mock.netlify.app/deploys" && req.method === "POST" && ct.startsWith("application/json")) {
    const digests = JSON.parse(body.toString("utf8")).files;
    assert.equal(digests["/index.html"], sha1(INDEX));
    assert.equal(digests["/assets/app.css"], sha1(CSS));
    // the API returns the files to upload keyed by SHA1, not by path
    return json(res, 200, { id: "dig1", required: [sha1(INDEX), sha1(CSS)], required_functions: [] });
  }
  // preview zip deploy (branch query)
  if (url.pathname === "/api/v1/sites/mock.netlify.app/deploys" && req.method === "POST" && ct === "application/zip") {
    assert.equal(url.searchParams.get("branch"), "feat/demo");
    assert.equal(body.readUInt32LE(0), 0x04034b50, "zip magic");
    const files = readZip(body);
    assert.equal(files["index.html"], "<h1>hello providers</h1>");
    assert.equal(files["assets/app.css"], "body { color: rebeccapurple; }");
    return json(res, 200, { id: "zip1", url: "https://def--mock.netlify.app", deploy_ssl_url: "https://def--mock.netlify.app", site_url: "https://mock.netlify.app", state: "ready" });
  }
  // unknown site → 404 (triggers auto-create)
  if (url.pathname === "/api/v1/sites/brand-new/deploys" && req.method === "POST") {
    return json(res, 404, { message: "site not found" });
  }
  if (url.pathname === "/api/v1/sites/site-new/deploys" && req.method === "POST") {
    return json(res, 200, { id: "dig-new", required: [sha1(INDEX), sha1(CSS)], required_functions: [] });
  }
  // file uploads for digest deploys
  const putMatch = url.pathname.match(/^\/api\/v1\/deploys\/([^/]+)\/files\/(.+)$/);
  if (putMatch && req.method === "PUT") {
    assert.equal(req.headers["content-type"], "application/octet-stream");
    const rel = decodeURIComponent(putMatch[2]);
    assert.equal(body.toString("utf8"), rel === "index.html" ? INDEX.toString("utf8") : CSS.toString("utf8"));
    return json(res, 200, {});
  }
  // deploy status (polling)
  const deployGet = url.pathname.match(/^\/api\/v1\/deploys\/([^/]+)$/);
  if (deployGet && req.method === "GET") {
    const id = deployGet[1];
    const site = id === "dig-new" ? "brand-new" : "mock";
    const hash = id === "dig1" ? "abc" : "def";
    return json(res, 200, {
      id,
      state: "ready",
      url: `https://${hash}--${site}.netlify.app`,
      deploy_ssl_url: `https://${hash}--${site}.netlify.app`,
      site_url: `https://${site}.netlify.app`,
      ssl_url: `https://${site}.netlify.app`,
    });
  }
  // rollback
  if (url.pathname === "/api/v1/sites/mock.netlify.app/deploys/d1/restore" && req.method === "POST") {
    return json(res, 200, { id: "d1", ssl_url: "https://mock.netlify.app", url: "https://abc--mock.netlify.app" });
  }
  // site info (for production marking)
  if (url.pathname === "/api/v1/sites/mock.netlify.app" && req.method === "GET") {
    return json(res, 200, { id: "site1", published_deploy: { id: "d1" } });
  }
  if (url.pathname === "/api/v1/sites/mock.netlify.app/deploys" && req.method === "GET") {
    return json(res, 200, [
      { id: "d1", created_at: "2026-08-15T00:00:00Z", branch: "main", url: "https://abc--mock.netlify.app", deploy_ssl_url: "https://abc--mock.netlify.app" },
      { id: "d0", created_at: "2026-08-14T00:00:00Z", branch: "main", url: "https://old--mock.netlify.app" },
    ]);
  }
  json(res, 404, { message: "no route" });
});

const netlifyConfig = { providers: { netlify: { token: "nfp_test" } } };
process.env.NETLIFY_API_BASE = baseOf(netlifyServer) + "/api/v1";
const netlify = PROVIDERS.netlify;

// production digest deploy
const n1 = await netlify.deploy({
  project: "mock-site",
  outDir: tmp,
  preview: false,
  branch: null,
  flags: { site: "mock.netlify.app" },
  config: netlifyConfig,
  rc: {},
});
assert.equal(n1.id, "dig1");
assert.equal(n1.url, "https://mock.netlify.app");
assert.equal(n1.deployUrl, "https://abc--mock.netlify.app");
assert.equal(n1.method, "digest");

// preview → zip method with branch query, deploy URL reported
const n2 = await netlify.deploy({
  project: "mock-site",
  outDir: tmp,
  preview: true,
  branch: "feat/demo",
  flags: { site: "mock.netlify.app" },
  config: netlifyConfig,
  rc: {},
});
assert.equal(n2.id, "zip1");
assert.equal(n2.url, "https://def--mock.netlify.app");
assert.equal(n2.method, "zip");

// auto-create site on 404
const n3 = await netlify.deploy({
  project: "brand-new",
  outDir: tmp,
  preview: false,
  branch: null,
  flags: {},
  config: netlifyConfig,
  rc: {},
});
assert.equal(n3.id, "dig-new");
assert.equal(n3.url, "https://brand-new.netlify.app");

// rollback + list with production marking
const n4 = await netlify.rollback({ project: "mock-site", deployId: "d1", flags: { site: "mock.netlify.app" }, config: netlifyConfig, rc: {} });
assert.equal(n4.url, "https://mock.netlify.app");
const n5 = await netlify.list({ project: "mock-site", flags: { site: "mock.netlify.app" }, config: netlifyConfig, rc: {} });
assert.equal(n5[0].id, "d1");
assert.equal(n5[0].production, true, "published deploy marked production");
assert.equal(n5[1].production, false);

// 401 → actionable hint
await assert.rejects(
  () =>
    netlify.deploy({
      project: "mock-site",
      outDir: tmp,
      preview: false,
      branch: null,
      flags: { site: "mock.netlify.app" },
      config: { providers: { netlify: { token: "wrong" } } },
      rc: {},
    }),
  (err) => err.status === 401 && /deploy login/.test(err.hint)
);

// =============================================================================
// Vercel
// =============================================================================

let vercelPolls = 0;
const vercelServer = await startServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.headers.authorization !== "Bearer vc_test") return json(res, 401, { error: { code: "unauthorized" } });
  const body = await readBody(req);

  // current documented contract: POST /v2/files with a SHA1 x-now-digest
  if (url.pathname === "/v2/files" && req.method === "POST") {
    assert.equal(req.headers["x-now-digest"], sha1(body));
    assert.equal(req.headers["x-now-size"], String(body.length), "x-now-size sent");
    assert.equal(req.headers["content-length"], String(body.length), "Content-Length sent");
    // simulate an already-uploaded file for one of them (409 is fine)
    return json(res, body.toString("utf8").includes("rebeccapurple") ? 409 : 200, {});
  }
  if (url.pathname === "/v13/deployments" && req.method === "POST") {
    const payload = JSON.parse(body.toString("utf8"));
    assert.equal(payload.name, "sample-site");
    const idx = payload.files.find((f) => f.file === "index.html");
    assert.equal(idx.sha, sha1(INDEX));
    assert.equal(idx.size, INDEX.length);
    assert.equal(idx.mode & 0o170000, 0o100000, "regular file mode bits present");
    assert.ok(!("data" in idx), "manifest references sha, not inline data");
    assert.ok(payload.files.some((f) => f.file === "assets/app.css"));
    const isProd = payload.target === "production";
    return json(res, 200, {
      id: isProd ? "dep1" : "dep-preview",
      url: isProd ? "sample-site-abc.vercel.app" : "sample-site-prev.vercel.app",
      alias: isProd ? ["https://sample-site.vercel.app"] : [],
      readyState: "QUEUED", // must poll before the URL is usable
      target: payload.target || null,
    });
  }
  // poll: production deploy is still INITIALIZING on the first poll (proves
  // deploy() waits for READY), then READY with the alias assigned.
  if (url.pathname === "/v13/deployments/dep1" && req.method === "GET") {
    vercelPolls++;
    if (vercelPolls === 1) return json(res, 200, { id: "dep1", readyState: "INITIALIZING" });
    return json(res, 200, {
      id: "dep1",
      readyState: "READY",
      url: "sample-site-abc.vercel.app",
      alias: ["https://sample-site.vercel.app"],
      target: "production",
    });
  }
  // preview deployments have no production alias — URL is the unique deploy URL
  if (url.pathname === "/v13/deployments/dep-preview" && req.method === "GET") {
    return json(res, 200, { id: "dep-preview", readyState: "READY", url: "sample-site-prev.vercel.app", alias: [], target: null });
  }
  if (url.pathname === "/v9/projects" && req.method === "GET") {
    assert.equal(url.searchParams.get("name"), "sample-site");
    return json(res, 200, { projects: [{ id: "prj1", name: "sample-site" }] });
  }
  if (url.pathname === "/v9/projects/prj1/rollback/dep1" && req.method === "POST") {
    return json(res, 200, {});
  }
  if (url.pathname === "/v6/deployments" && req.method === "GET") {
    assert.equal(url.searchParams.get("projectId"), "prj1");
    return json(res, 200, {
      deployments: [
        { uid: "dep2", createdAt: 1755200100000, url: "sample-site-def.vercel.app", target: "preview", readyState: "READY" },
        { uid: "dep1", createdAt: 1755200000000, url: "sample-site-abc.vercel.app", target: "production", readyState: "READY" },
      ],
    });
  }
  json(res, 404, { error: { code: "not_found" } });
});

const vercelConfig = { providers: { vercel: { token: "vc_test" } } };
process.env.VERCEL_API_BASE = baseOf(vercelServer);
const vercel = PROVIDERS.vercel;

// production deploy → sha uploads + manifest, target=production
const v1 = await vercel.deploy({
  project: "sample-site",
  outDir: tmp,
  preview: false,
  branch: null,
  flags: {},
  config: vercelConfig,
  rc: {},
});
assert.equal(v1.id, "dep1");
assert.equal(v1.url, "https://sample-site.vercel.app");
assert.equal(v1.deployUrl, "https://sample-site-abc.vercel.app");
assert.ok(vercelPolls >= 2, "deploy() polled until READY (saw INITIALIZING then READY)");

// preview deploy → no target key
const v2 = await vercel.deploy({
  project: "sample-site",
  outDir: tmp,
  preview: true,
  branch: "feat/x",
  flags: {},
  config: vercelConfig,
  rc: {},
});
assert.equal(v2.url, "https://sample-site-prev.vercel.app");

// rollback + list with production marking
const v3 = await vercel.rollback({ project: "sample-site", deployId: "dep1", flags: {}, config: vercelConfig, rc: {} });
assert.equal(v3.url, "https://sample-site.vercel.app");
const v4 = await vercel.list({ project: "sample-site", flags: {}, config: vercelConfig, rc: {} });
assert.equal(v4[0].id, "dep2");
assert.equal(v4[0].production, false);
assert.equal(v4[1].production, true, "current production deployment marked");

// =============================================================================
// Cloudflare Pages
// =============================================================================

let cfNewprojAttempts = 0;
const cfServer = await startServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const body = await readBody(req);

  // pre-signed upload URLs carry no bearer token
  if (url.pathname === "/upload" && req.method === "POST") {
    const text = body.toString("utf8");
    assert.match(req.headers["content-type"], /multipart\/form-data; boundary=/);
    assert.ok(text.includes('name="key"'), "pre-signed form field included");
    assert.ok(text.includes('name="file"; filename="index.html"'), "file part named correctly");
    assert.ok(text.includes("<h1>hello providers</h1>"), "file bytes present");
    return json(res, 200, { success: true, result: { code: 8000001 } });
  }

  if (req.headers.authorization !== "Bearer cf_test") return json(res, 401, { errors: [{ message: "unauthorized" }] });

  if (url.pathname === "/accounts/acct1/pages/projects/newproj/deployments" && req.method === "POST") {
    if (cfNewprojAttempts++ === 0) return json(res, 404, { errors: [{ message: "project not found" }] });
    // second attempt (after project creation) succeeds
    const digests = JSON.parse(body.toString("utf8")).files;
    assert.equal(digests["/index.html"], sha256(INDEX));
    return json(res, 200, {
      result: { id: "dep-cf2", url: "https://def.newproj.pages.dev", required: {}, upload_url: `${baseOf(cfServer)}/upload`, form_fields: {} },
    });
  }
  if (url.pathname === "/accounts/acct1/pages/projects" && req.method === "POST") {
    const p = JSON.parse(body.toString("utf8"));
    assert.equal(p.name, "newproj");
    assert.equal(p.production_branch, "main");
    return json(res, 200, { result: { id: "proj-new", name: "newproj" } });
  }
  const deployMatch = url.pathname.match(/^\/accounts\/acct1\/pages\/projects\/([^/]+)\/deployments$/);
  if (deployMatch && req.method === "POST") {
    const digests = JSON.parse(body.toString("utf8")).files;
    assert.equal(digests["/index.html"], sha256(INDEX));
    return json(res, 200, {
      result: {
        id: "dep-cf",
        url: "https://abc.myproj.pages.dev",
        required: { "/index.html": sha256(INDEX) },
        upload_url: `${baseOf(cfServer)}/upload`,
        form_fields: { key: "abc123" },
      },
    });
  }
  const oneDeploy = url.pathname.match(/^\/accounts\/acct1\/pages\/projects\/([^/]+)\/deployments\/([^/]+)$/);
  if (oneDeploy && req.method === "GET") {
    const url2 = oneDeploy[2] === "dep-cf2" ? "https://def.newproj.pages.dev" : "https://abc.myproj.pages.dev";
    return json(res, 200, { result: { id: oneDeploy[2], status: "success", url: url2 } });
  }
  if (url.pathname === "/accounts/acct1/pages/projects/myproj/deployments" && req.method === "GET") {
    return json(res, 200, {
      result: [
        { id: "dep-cf", created_on: "2026-08-15T00:00:00Z", url: "https://abc.myproj.pages.dev", production_branch: true },
      ],
    });
  }
  json(res, 404, { errors: [{ message: "no route" }] });
});

const cfConfig = { providers: { cloudflare: { token: "cf_test", accountId: "acct1" } } };
process.env.CLOUDFLARE_API_BASE = baseOf(cfServer);
const cloudflare = PROVIDERS.cloudflare;

const cf1 = await cloudflare.deploy({
  project: "myproj",
  outDir: tmp,
  preview: false,
  branch: null,
  flags: {},
  config: cfConfig,
  rc: {},
});
assert.equal(cf1.id, "dep-cf");
assert.equal(cf1.url, "https://abc.myproj.pages.dev");

// auto-create project on 404
const cf2 = await cloudflare.deploy({
  project: "newproj",
  outDir: tmp,
  preview: false,
  branch: null,
  flags: {},
  config: cfConfig,
  rc: {},
});
assert.equal(cf2.id, "dep-cf2");

// rollback is unsupported and says so
await assert.rejects(() => cloudflare.rollback({}), /no rollback API/);

const cf3 = await cloudflare.list({ project: "myproj", flags: {}, config: cfConfig, rc: {} });
assert.equal(cf3[0].id, "dep-cf");
assert.equal(cf3[0].production, true);

// =============================================================================
// S3 (with real SigV4 recomputation in the mock)
// =============================================================================

const AK = "AKIDEXAMPLE";
const SK = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const s3Config = { providers: { s3: { accessKeyId: AK, secretAccessKey: SK, bucket: "mybucket", region: "us-east-1" } } };

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");

function verifySigV4(req, body, { region }) {
  const auth = req.headers.authorization;
  assert.ok(auth.startsWith("AWS4-HMAC-SHA256 Credential="), "auth header format");
  const sig = auth.match(/Signature=([0-9a-f]+)$/)[1];
  // Credential = <accessKeyId>/<date>/<region>/s3/aws4_request — scope excludes the key id
  const credential = auth.match(/Credential=([^,]+),/)[1];
  const [, dateStamp, credRegion] = credential.split("/");
  const scope = credential.split("/").slice(1).join("/");
  assert.equal(credRegion, region);
  const amzDate = req.headers["x-amz-date"];
  assert.equal(req.headers["x-amz-content-sha256"], sha256hex(body), "payload hash header");
  const canonicalHeaders = `host:${req.headers.host}\nx-amz-content-sha256:${req.headers["x-amz-content-sha256"]}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${req.method}\n${req.url.split("?")[0]}\n${(req.url.split("?")[1] || "")}\n${canonicalHeaders}\n${signedHeaders}\n${req.headers["x-amz-content-sha256"]}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const kDate = hmac("AWS4" + SK, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  assert.equal(hmac(kSigning, stringToSign).toString("hex"), sig, "SigV4 signature recomputes correctly");
}

const s3Server = await startServer(async (req, res) => {
  const body = await readBody(req);
  if (req.method === "PUT") {
    verifySigV4(req, body, { region: "us-east-1" });
    const content = body.toString("utf8");
    assert.ok(content === INDEX.toString("utf8") || content === CSS.toString("utf8"), "file content uploaded");
    res.writeHead(200, { "Content-Type": "application/xml" });
    return res.end("<PutObjectResult/>");
  }
  if (req.method === "GET") {
    assert.match(req.url, /list-type=2/);
    res.writeHead(200, { "Content-Type": "application/xml" });
    return res.end(
      `<ListBucketResult><Contents><Key>myproj/index.html</Key><LastModified>2026-08-15T00:00:00Z</LastModified></Contents><Contents><Key>myproj/assets/app.css</Key><LastModified>2026-08-15T00:00:01Z</LastModified></Contents></ListBucketResult>`
    );
  }
  json(res, 405, {});
});

process.env.AWS_S3_ENDPOINT = baseOf(s3Server);
const s3 = PROVIDERS.s3;

const s1 = await s3.deploy({ project: "myproj", outDir: tmp, preview: false, branch: null, flags: {}, config: s3Config, rc: {} });
assert.match(s1.url, /myproj\/$/);
assert.equal(s1.state, "uploaded");

await assert.rejects(() => s3.rollback({}), /no built-in rollback/);

const s3rows = await s3.list({ project: "myproj", flags: {}, config: s3Config, rc: {} });
assert.equal(s3rows.length, 2);
assert.equal(s3rows[0].id, "myproj/index.html");
assert.equal(s3rows[0].production, true);

// =============================================================================
// teardown
// =============================================================================

netlifyServer.close();
vercelServer.close();
cfServer.close();
s3Server.close();
delete process.env.NETLIFY_API_BASE;
delete process.env.VERCEL_API_BASE;
delete process.env.CLOUDFLARE_API_BASE;
delete process.env.AWS_S3_ENDPOINT;

console.log(
  "✔ provider tests passed (netlify digest+zip+create+rollback+list, vercel sha-upload+manifest+rollback+list, cloudflare direct-upload, s3 sigv4)"
);
