// Clean up the artifacts each real-account smoke run leaves behind:
//   - Netlify sites named smoke-<timestamp>
//   - Vercel projects named smoke-<timestamp>
//   - Cloudflare Pages projects named smoke-<timestamp>
//   - S3 objects under smoke-<timestamp>/ prefixes (opt-in: pass "s3")
//
// Credentials work exactly like scripts/smoke-real.mjs — env vars win, then the
// `deploy login` config file (~/.deploy-cli/config.json). Only auto-generated
// names of the form smoke-<10+ digits> are ever matched, so pinned names
// (SMOKE_SITE, SMOKE_VERCEL_PROJECT, custom S3 prefixes) are never touched.
//
//   node scripts/cleanup-smoke.mjs [netlify] [vercel] [cloudflare] [s3] [--dry-run] [--yes]
//
// Prints everything it will delete and asks for confirmation unless --yes is
// passed (required when stdin is not a TTY, e.g. in CI). Exits non-zero if a
// provider call fails.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
import { loadConfig } from "../lib/config.js";
import { s3Fetch } from "../lib/providers/s3.js";

// Only auto-generated names — "smoke-" + Date.now(). Pinned names (SMOKE_SITE,
// SMOKE_VERCEL_PROJECT) never match, so a user's real projects can't be touched.
export const isSmokeName = (name) => /^smoke-\d{10,}$/.test(String(name || ""));

const saved = loadConfig().providers || {};
const creds = {
  netlify: {
    token: process.env.NETLIFY_AUTH_TOKEN || saved.netlify?.token || null,
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

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const yes = args.includes("--yes");
const targets = args.filter((a) => !a.startsWith("--"));
// s3 is opt-in: it deletes objects from a shared bucket, unlike the others.
const selected = targets.length ? targets : ["netlify", "vercel", "cloudflare"];

const skip = (name) => console.log(`- ${name}: no credentials configured (skipped)`);

async function api(url, opts = {}, provider, token) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`${provider} API ${res.status} ${url}: ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return res;
}

async function confirm(q) {
  if (!process.stdin.isTTY) {
    console.log("  (stdin is not a TTY — pass --yes to delete without prompting)");
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${q} [y/N] `, (a) => {
      rl.close();
      resolve(/^y/i.test(a.trim()));
    });
  });
}

/** Shared delete flow: list what matches, confirm (unless --yes/--dry-run), delete. */
async function deleteAll(provider, items, del) {
  if (!items.length) {
    console.log(`✔ ${provider}: nothing to clean`);
    return;
  }
  console.log(`\n${provider}: ${items.length} artifact(s) to delete:`);
  for (const it of items) console.log(`  - ${it.label}`);
  if (dryRun) {
    console.log("  (dry run — nothing deleted)");
    return;
  }
  if (!yes && !(await confirm(`Delete these ${provider} artifact(s)?`))) {
    console.log("  skipped — nothing deleted");
    return;
  }
  let n = 0;
  for (const it of items) {
    await del(it);
    console.log(`  ✓ deleted ${it.label}`);
    n++;
  }
  console.log(`✔ ${provider}: deleted ${n}`);
}

async function cleanNetlify() {
  const { token } = creds.netlify;
  if (!token) return skip("netlify");
  const base = process.env.NETLIFY_API_BASE || "https://api.netlify.com/api/v1";
  const found = [];
  for (let page = 1; page <= 10; page++) {
    const url = new URL(`${base}/sites`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const res = await api(url, {}, "netlify", token);
    const sites = await res.json();
    found.push(...sites.filter((s) => isSmokeName(s.name)).map((s) => ({ id: s.id, label: s.name })));
    if (sites.length < 100) break;
  }
  return deleteAll("netlify", found, async (s) => {
    await api(new URL(`${base}/sites/${s.id}`), { method: "DELETE" }, "netlify", token);
  });
}

async function cleanVercel() {
  const { token, teamId } = creds.vercel;
  if (!token) return skip("vercel");
  const base = process.env.VERCEL_API_BASE || "https://api.vercel.com";
  const url = new URL(`${base}/v9/projects`);
  url.searchParams.set("limit", "100");
  if (teamId) url.searchParams.set("teamId", teamId);
  const res = await api(url, {}, "vercel", token);
  const { projects } = await res.json();
  const found = (projects || [])
    .filter((p) => isSmokeName(p.name))
    .map((p) => ({ id: p.id, label: p.name }));
  return deleteAll("vercel", found, async (p) => {
    const del = new URL(`${base}/v9/projects/${encodeURIComponent(p.id)}`);
    if (teamId) del.searchParams.set("teamId", teamId);
    await api(del, { method: "DELETE" }, "vercel", token);
  });
}

async function cleanCloudflare() {
  const { token, accountId } = creds.cloudflare;
  if (!token || !accountId) return skip("cloudflare");
  const base = process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4";
  const found = [];
  // the Pages projects list API rejects per_page above 25 with a 400
  for (let page = 1; page <= 10; page++) {
    const url = new URL(`${base}/accounts/${accountId}/pages/projects`);
    url.searchParams.set("per_page", "10");
    url.searchParams.set("page", String(page));
    const res = await api(url, {}, "cloudflare", token);
    const data = await res.json();
    if (!data.success) {
      throw new Error(`cloudflare API: ${JSON.stringify(data.errors || data).slice(0, 200)}`);
    }
    found.push(...(data.result || []).filter((p) => isSmokeName(p.name)).map((p) => ({ name: p.name, label: p.name })));
    if (!data.result_info || page >= data.result_info.total_pages) break;
  }
  return deleteAll("cloudflare", found, async (p) => {
    const del = new URL(`${base}/accounts/${accountId}/pages/projects/${encodeURIComponent(p.name)}`);
    await api(del, { method: "DELETE" }, "cloudflare", token);
  });
}

async function cleanS3() {
  const c = creds.s3;
  if (!c.accessKeyId || !c.secretAccessKey || !c.bucket) return skip("s3");
  // Find smoke-<timestamp> prefixes in the bucket, then delete every object in each.
  const prefixes = [];
  let listToken = null;
  do {
    const query = { "list-type": "2", prefix: "smoke-" };
    if (listToken) query["continuation-token"] = listToken;
    const res = await s3Fetch(c, { key: "", method: "GET", query });
    const xml = await res.text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    prefixes.push(...new Set(keys.map((k) => k.split("/")[0]).filter((p) => isSmokeName(p))));
    listToken = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] || null;
  } while (listToken);
  const found = [...new Set(prefixes)].map((p) => ({ prefix: p, label: `${p}/` }));
  return deleteAll("s3", found, async (item) => {
    let tok = null;
    let n = 0;
    do {
      const query = { "list-type": "2", prefix: `${item.prefix}/` };
      if (tok) query["continuation-token"] = tok;
      const res = await s3Fetch(c, { key: "", method: "GET", query });
      const xml = await res.text();
      const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
      for (const k of keys) await s3Fetch(c, { key: k, method: "DELETE" });
      n += keys.length;
      tok = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] || null;
    } while (tok);
    console.log(`    (${n} object(s) under ${item.prefix}/)`);
  });
}

async function main() {
  console.log(dryRun ? "── dry run ──" : "── cleanup ──");
  for (const t of selected) {
    try {
      if (t === "netlify") await cleanNetlify();
      else if (t === "vercel") await cleanVercel();
      else if (t === "cloudflare") await cleanCloudflare();
      else if (t === "s3") await cleanS3();
      else console.log(`- unknown target "${t}"`);
    } catch (err) {
      console.error(`✖ ${t}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
