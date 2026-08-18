// Real-account smoke test. The mock-API tests verify what we SEND; this verifies
// what the hosts actually RETURN — the only gap the mocks can't close.
//
// Requires real credentials (never commit them). Env vars win; otherwise the
// smoke falls back to `deploy login` credentials in ~/.deploy-cli/config.json,
// so logging in once makes every later `npm run smoke` work in any shell:
//   export NETLIFY_AUTH_TOKEN=nfp_xxx            # app.netlify.com → user settings
//   export VERCEL_TOKEN=xxx                      # vercel.com/account/tokens
//   export SMOKE_SITE=some-unique-name           # netlify site name (auto-created)
//   export SMOKE_VERCEL_PROJECT=sample-site      # pin a vercel project (default: fresh timestamped project)
//   # or once, per machine:
//   deploy login --provider netlify --token <PAT>
//   deploy login --provider vercel --token <token> [--team <teamId>]
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
import { loadConfig } from "../lib/config.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
fs.writeFileSync(path.join(tmp, "index.html"), "<h1>smoke-ok</h1>");
fs.writeFileSync(path.join(tmp, "asset.txt"), "asset-content");

const saved = loadConfig().providers || {};
const providers = {
  netlify: {
    token: process.env.NETLIFY_AUTH_TOKEN || saved.netlify?.token || null,
    site: process.env.SMOKE_SITE || saved.netlify?.site || "smoke-" + Date.now(),
  },
  vercel: {
    token: process.env.VERCEL_TOKEN || saved.vercel?.token || null,
    teamId: process.env.VERCEL_TEAM_ID || saved.vercel?.teamId || null,
  },
  cloudflare: {
    token: process.env.CLOUDFLARE_API_TOKEN || saved.cloudflare?.token || null,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || saved.cloudflare?.accountId || null,
  },
  s3: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || saved.s3?.accessKeyId || null,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || saved.s3?.secretAccessKey || null,
    bucket: process.env.SMOKE_S3_BUCKET || saved.s3?.bucket || null,
    region: process.env.AWS_REGION || saved.s3?.region || "us-east-1",
  },
};

const config = {
  server: "http://localhost:8787",
  token: "dev-token",
  providers,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a URL and assert it serves the smoke content. New sites (Netlify
 * auto-created, Cloudflare pages.dev, fresh Vercel aliases) can take 5–30s
 * after the API reports ready for DNS/SSL/edge to propagate, so retry with
 * backoff instead of failing on the first 404/522.
 *
 * Special case: Vercel serves its own login page (HTTP 200) to anonymous
 * visitors when a deployment is protected or broken. Detect that redirect and
 * name it, instead of the misleading "expected content missing".
 */
async function check(url, needle = "smoke-ok", { attempts = 16, baseMs = 1500 } = {}) {
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
    const finalUrl = res.url || "";
    // Vercel redirects protected/broken deployments to its login page.
    const redirectedToVercel = /vercel\.com\//.test(finalUrl) && !/\.vercel\.app\//.test(finalUrl);
    if (redirectedToVercel || /vercel\.com\/login|sso-api/.test(text)) {
      throw new Error(
        `URL ${url} → redirected to ${finalUrl}: deployment protection (Vercel Authentication) is ` +
          "enabled for this project, or the deployment has no files. Check the project's " +
          "Deployment Protection setting and open the deployment URL in a logged-in browser to inspect it."
      );
    }
    if (res.status === 200 && text.includes(needle)) return;
    last = new Error(`URL ${url} → HTTP ${res.status}, expected content missing`);
    // A 200 without the needle is a not-yet-flipped alias — retry. Only break
    // early on a definite failure status.
    if (res.status !== 200 && res.status < 500 && res.status !== 404 && res.status !== 522) break;
    await sleep(baseMs * (i + 1) * 0.5);
  }
  throw last || new Error(`URL ${url} never served ${needle}`);
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

/**
 * Create (or resolve) a Vercel project and disable Vercel Authentication on it.
 * New projects default to Deployment Protection, which redirects anonymous
 * visitors to vercel.com/login — the exact failure we were seeing. Disabling it
 * via the documented `PATCH /v9/projects/{id}` with `ssoProtection: null` makes
 * the anonymous content checks deterministic.
 */
async function ensureUnprotectedVercelProject(token, project) {
  const base = new URL("https://api.vercel.com/v9/projects");
  if (providers.vercel.teamId) base.searchParams.set("teamId", providers.vercel.teamId);

  const created = await fetch(base, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: project }),
  });
  const createdData = await created.json().catch(() => ({}));
  let projectId = created.ok ? createdData.project?.id || createdData.id : null;
  if (!projectId && /already exists/i.test(JSON.stringify(createdData))) {
    const get = new URL(base);
    get.searchParams.set("name", project);
    const res = await fetch(get, { headers: { Authorization: `Bearer ${token}` } });
    const list = await res.json().catch(() => ({}));
    projectId = (list.projects || []).find((p) => p.name === project)?.id;
  }
  if (!projectId) {
    throw new Error(
      `Vercel API ${created.status} creating project "${project}": ${createdData.error?.message || created.statusText}`
    );
  }
  const patch = await fetch(new URL(`${base}/${encodeURIComponent(projectId)}`), {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ssoProtection: null }),
  });
  if (!patch.ok) {
    const patchData = await patch.json().catch(() => ({}));
    throw new Error(
      `Vercel API ${patch.status} disabling protection on "${project}": ${patchData.error?.message || patch.statusText}`
    );
  }
  console.log(`  vercel project: ${project}`);
}

async function smokeVercel() {
  if (!config.providers.vercel.token) return skip("vercel");
  const token = config.providers.vercel.token;
  // Fresh project per run unless pinned: hermetic. A shared project accumulates
  // alias history and can carry Deployment Protection or other settings that
  // make the anonymous content check see Vercel's login page instead of files.
  const project = process.env.SMOKE_VERCEL_PROJECT || "smoke-" + Date.now();
  const flags = {};

  await ensureUnprotectedVercelProject(token, project);

  // Distinct content per deploy so rollback is verifiable end to end.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-v2-"));
  fs.writeFileSync(path.join(tmp2, "index.html"), "<h1>smoke-v2</h1>");
  fs.writeFileSync(path.join(tmp2, "asset.txt"), "v2-content");

  // Check the deployment URL first — it is the authoritative proof that the
  // files attached and serve, independent of alias propagation or protection.
  // The alias is only asserted after rollback, where it is the thing being tested.
  const d1 = await PROVIDERS.vercel.deploy({ project, outDir: tmp, preview: false, branch: null, flags, config, rc: {} });
  await check(d1.deployUrl || d1.url);
  // second deploy is the new production
  const d2 = await PROVIDERS.vercel.deploy({ project, outDir: tmp2, preview: false, branch: null, flags, config, rc: {} });
  await check(d2.deployUrl || d2.url, "smoke-v2");
  // roll back production to the FIRST deploy — the one not currently live
  // (Vercel 422s if you roll back to the current production deployment)
  await PROVIDERS.vercel.rollback({ project, deployId: d1.id, flags, config, rc: {} });
  await check(d1.url, "smoke-ok");
  pass("vercel", d1.url);
}

async function smokeCloudflare() {
  if (!config.providers.cloudflare.token || !config.providers.cloudflare.accountId) return skip("cloudflare");
  const { url, id } = await PROVIDERS.cloudflare.deploy({
    project: "smoke-" + Date.now(),
    outDir: tmp,
    preview: false,
    branch: null,
    flags: {},
    config,
    rc: {},
  });
  // brand-new pages.dev hostnames can take a while for DNS to propagate, so
  // print the URL before the check — if it fails, the URL is right there.
  console.log(`  cloudflare deployment: ${id} @ ${url}`);
  await check(url, "smoke-ok", { attempts: 24 });
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
  await check(url + "index.html", "smoke-ok", { attempts: 4, baseMs: 500 });
  pass("s3", url);
}

const pass = (name, url) => console.log(`✔ ${name}: ${url}`);
const skip = (name) => console.log(`- ${name}: skipped (no credentials)`);

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["netlify", "vercel", "cloudflare", "s3"];

// Missing-credential checklist so a run tells you exactly what to set
// (env var or the equivalent `deploy login` one-liner).
const missingFor = (name) => {
  switch (name) {
    case "netlify":
      return providers.netlify.token ? [] : ["NETLIFY_AUTH_TOKEN (or deploy login --provider netlify)"];
    case "vercel":
      return providers.vercel.token ? [] : ["VERCEL_TOKEN (or deploy login --provider vercel)"];
    case "cloudflare":
      return providers.cloudflare.token && providers.cloudflare.accountId
        ? []
        : ["CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (or deploy login --provider cloudflare)"];
    case "s3":
      return providers.s3.accessKeyId && providers.s3.secretAccessKey && providers.s3.bucket
        ? []
        : ["AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + SMOKE_S3_BUCKET (or deploy login --provider s3)"];
    default:
      return [];
  }
};
for (const name of targets) {
  const missing = missingFor(name);
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
