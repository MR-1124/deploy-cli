// Real-account smoke test. The mock-API tests verify what we SEND; this verifies
// what the hosts actually RETURN — the only gap the mocks can't close.
//
// Requires real credentials (never commit them):
//   export NETLIFY_AUTH_TOKEN=nfp_xxx            # app.netlify.com → user settings
//   export VERCEL_TOKEN=xxx                      # vercel.com/account/tokens
//   export SMOKE_SITE=some-unique-name           # netlify site name (auto-created)
//   export SMOKE_VERCEL_PROJECT=sample-site      # vercel project name (auto-created)
//
//   node scripts/smoke-real.mjs [netlify] [vercel] [s3] [cloudflare]
//
// For each provider it: deploys a tiny static site, fetches the returned URL and
// asserts it serves the expected content, then (where supported) rolls back.
// Exits non-zero on the first failure.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDERS } from "../lib/providers/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
fs.writeFileSync(path.join(tmp, "index.html"), "<h1>smoke-ok</h1>");
fs.writeFileSync(path.join(tmp, "asset.txt"), "asset-content");

const config = {
  server: "http://localhost:8787",
  token: "dev-token",
  providers: {
    netlify: { token: process.env.NETLIFY_AUTH_TOKEN || null, site: process.env.SMOKE_SITE || "smoke-" + Date.now() },
    vercel: { token: process.env.VERCEL_TOKEN || null },
    cloudflare: {
      token: process.env.CLOUDFLARE_API_TOKEN || null,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID || null,
    },
    s3: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || null,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || null,
      bucket: process.env.SMOKE_S3_BUCKET || null,
      region: process.env.AWS_REGION || "us-east-1",
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a URL and assert it serves the smoke content. New sites (Netlify
 * auto-created, Cloudflare pages.dev, fresh Vercel aliases) can take 5–30s
 * after the API reports ready for DNS/SSL/edge to propagate, so retry with
 * backoff instead of failing on the first 404/522.
 */
async function check(url, { attempts = 16, baseMs = 1500 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    let res, text;
    try {
      res = await fetch(url, { redirect: "follow" });
      text = await res.text();
    } catch (err) {
      last = err;
      await sleep(baseMs * (i + 1) * 0.5);
      continue;
    }
    if (res.status === 200 && text.includes("smoke-ok")) return;
    last = new Error(`URL ${url} → HTTP ${res.status}, expected content missing`);
    if (res.status < 500 && res.status !== 404 && res.status !== 522) break; // hard failure
    await sleep(baseMs * (i + 1) * 0.5);
  }
  throw last || new Error(`URL ${url} never served the smoke content`);
}

async function smokeNetlify() {
  if (!config.providers.netlify.token) return skip("netlify");
  const { url, id } = await PROVIDERS.netlify.deploy({
    project: "smoke",
    outDir: tmp,
    preview: false,
    branch: null,
    flags: { site: config.providers.netlify.site },
    config,
    rc: {},
  });
  await check(url);
  await PROVIDERS.netlify.rollback({ project: "smoke", deployId: id, flags: { site: config.providers.netlify.site }, config, rc: {} });
  pass("netlify", url);
}

async function smokeVercel() {
  if (!config.providers.vercel.token) return skip("vercel");
  const { url, id } = await PROVIDERS.vercel.deploy({
    project: process.env.SMOKE_VERCEL_PROJECT || "smoke",
    outDir: tmp,
    preview: false,
    branch: null,
    flags: {},
    config,
    rc: {},
  });
  await check(url);
  await PROVIDERS.vercel.rollback({ project: process.env.SMOKE_VERCEL_PROJECT || "smoke", deployId: id, flags: {}, config, rc: {} });
  pass("vercel", url);
}

async function smokeCloudflare() {
  if (!config.providers.cloudflare.token || !config.providers.cloudflare.accountId) return skip("cloudflare");
  const { url } = await PROVIDERS.cloudflare.deploy({
    project: "smoke-" + Date.now(),
    outDir: tmp,
    preview: false,
    branch: null,
    flags: {},
    config,
    rc: {},
  });
  await check(url);
  pass("cloudflare", url);
}

async function smokeS3() {
  if (!config.providers.s3.accessKeyId || !config.providers.s3.bucket) return skip("s3");
  const { url } = await PROVIDERS.s3.deploy({
    project: "smoke-" + Date.now(),
    outDir: tmp,
    preview: false,
    branch: null,
    flags: {},
    config,
    rc: {},
  });
  // Path-style object URLs serve immediately (no edge propagation) — verify
  // the actual object content, not just the upload.
  await check(url + "index.html", { attempts: 4, baseMs: 500 });
  pass("s3", url);
}

const pass = (name, url) => console.log(`✔ ${name}: ${url}`);
const skip = (name) => console.log(`- ${name}: skipped (no credentials)`);

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["netlify", "vercel", "cloudflare", "s3"];

// Missing-credential checklist so a run tells you exactly what to set.
const REQUIREMENTS = {
  netlify: ["NETLIFY_AUTH_TOKEN"],
  vercel: ["VERCEL_TOKEN"],
  cloudflare: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  s3: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SMOKE_S3_BUCKET"],
};
for (const name of targets) {
  const missing = REQUIREMENTS[name]?.filter((v) => !process.env[v]) || [];
  if (missing.length) console.log(`  ${name}: set ${missing.join(", ")}`);
}
for (const t of targets) {
  try {
    if (t === "netlify") await smokeNetlify();
    else if (t === "vercel") await smokeVercel();
    else if (t === "cloudflare") await smokeCloudflare();
    else if (t === "s3") await smokeS3();
    else console.log(`- unknown target "${t}"`);
  } catch (err) {
    console.error(`✖ ${t}: ${err.message}`);
    process.exitCode = 1;
  }
}
