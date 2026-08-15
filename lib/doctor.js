// deploy doctor — health report for config, login state, and provider connectivity.
// For each provider it reports whether you're logged in and, when you are, probes
// the host with a cheap authenticated request to verify the credentials actually
// work. A check that isn't run (not logged in) is reported as ok:null, not a failure.

import fs from "node:fs";
import path from "node:path";
import { apiFetch, taggedError } from "./http.js";
import { configPath, loadConfig, normalizeServer } from "./config.js";
import { s3Fetch } from "./providers/s3.js";

const NETLIFY_BASE = () => process.env.NETLIFY_API_BASE || "https://api.netlify.com/api/v1";
const VERCEL_BASE = () => process.env.VERCEL_API_BASE || "https://api.vercel.com";
const CLOUDFLARE_BASE = () => process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4";

/** Mirror of the login-state logic the rest of the CLI uses. */
export function loggedIn(cfg, name) {
  const s = cfg.providers?.[name] || {};
  switch (name) {
    case "local":
      return Boolean(cfg.server && cfg.token);
    case "netlify":
      return Boolean(s.token || process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN);
    case "vercel":
      return Boolean(s.token || process.env.VERCEL_TOKEN);
    case "cloudflare":
      return Boolean((s.token || process.env.CLOUDFLARE_API_TOKEN) && (s.accountId || process.env.CLOUDFLARE_ACCOUNT_ID));
    case "s3":
      return Boolean(
        (s.accessKeyId || process.env.AWS_ACCESS_KEY_ID) &&
          (s.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY) &&
          s.bucket
      );
    default:
      return false;
  }
}

async function probe(url, { token, provider, timeoutMs = 10000 }) {
  try {
    const res = await apiFetch(url, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      retries: 1,
      timeoutMs,
      provider,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { res, data };
    return { err: taggedError(`HTTP ${res.status}`, { status: res.status, provider }) };
  } catch (err) {
    return { err };
  }
}

/**
 * Probe the bundled control plane. POST /api/deploy with an EMPTY body is a safe
 * round-trip: auth runs before the body is read, so a valid token gets 400
 * (empty upload rejected, nothing stored) and an invalid one gets 401.
 */
async function checkLocal(cfg) {
  const server = normalizeServer(cfg.server || "");
  const token = cfg.token;
  if (!server || !token) return { provider: "local", loggedIn: false, ok: null, detail: "run: deploy login" };
  try {
    const res = await apiFetch(new URL(server + "/api/deploy?project=__doctor"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-tar" },
      body: Buffer.alloc(0),
      retries: 1,
      timeoutMs: 10000,
      provider: "local",
    });
    if (res.status === 400) return { provider: "local", loggedIn: true, ok: true, detail: `server ${server} · token OK` };
    if (res.status === 401) return { provider: "local", loggedIn: true, ok: false, detail: `${server} rejected the token — run: deploy login` };
    return { provider: "local", loggedIn: true, ok: false, detail: `unexpected HTTP ${res.status} from ${server}` };
  } catch (err) {
    return { provider: "local", loggedIn: true, ok: false, detail: `unreachable: ${err.message}` };
  }
}

async function checkNetlify(cfg) {
  const token = cfg.providers?.netlify?.token || process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_TOKEN;
  if (!token) return { provider: "netlify", loggedIn: false, ok: null, detail: "run: deploy login --provider netlify" };
  const { err, data } = await probe(new URL(NETLIFY_BASE() + "/user"), { token, provider: "netlify" });
  if (err) return { provider: "netlify", loggedIn: true, ok: false, detail: `${err.status ? "HTTP " + err.status : "network error"} — token rejected` };
  return { provider: "netlify", loggedIn: true, ok: true, detail: `user ${data.email || "?"}` };
}

async function checkVercel(cfg) {
  const token = cfg.providers?.vercel?.token || process.env.VERCEL_TOKEN;
  if (!token) return { provider: "vercel", loggedIn: false, ok: null, detail: "run: deploy login --provider vercel" };
  const { err, data } = await probe(new URL(VERCEL_BASE() + "/v2/user"), { token, provider: "vercel" });
  if (err) return { provider: "vercel", loggedIn: true, ok: false, detail: `${err.status ? "HTTP " + err.status : "network error"} — token rejected` };
  return { provider: "vercel", loggedIn: true, ok: true, detail: `user ${data.user?.username || "?"}` };
}

async function checkCloudflare(cfg) {
  const s = cfg.providers?.cloudflare || {};
  const token = s.token || process.env.CLOUDFLARE_API_TOKEN;
  const account = s.accountId || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    return { provider: "cloudflare", loggedIn: false, ok: null, detail: "run: deploy login --provider cloudflare --account <id>" };
  }
  const { err, data } = await probe(new URL(CLOUDFLARE_BASE() + "/user/tokens/verify"), { token, provider: "cloudflare" });
  if (err || data.success !== true) {
    return { provider: "cloudflare", loggedIn: true, ok: false, detail: `${err?.status ? "HTTP " + err.status : "token rejected"} — check the token and Pages:Edit permission` };
  }
  return { provider: "cloudflare", loggedIn: true, ok: true, detail: `token ${data.result?.status || "active"} · account ${account}` };
}

async function checkS3(cfg) {
  const s = cfg.providers?.s3 || {};
  const accessKeyId = s.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = s.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
  const region = s.region || process.env.AWS_REGION || "us-east-1";
  const bucket = s.bucket;
  if (!accessKeyId || !secretAccessKey || !bucket) {
    return { provider: "s3", loggedIn: false, ok: null, detail: "run: deploy login --provider s3 --access-key <AK> --secret-key <SK> --bucket <name>" };
  }
  try {
    await s3Fetch({ accessKeyId, secretAccessKey, region, bucket }, { key: "", method: "GET", query: { "list-type": "2", "max-keys": "1" } });
    return { provider: "s3", loggedIn: true, ok: true, detail: `bucket ${bucket} reachable (${region})` };
  } catch (err) {
    return {
      provider: "s3",
      loggedIn: true,
      ok: false,
      detail: err.status === 404 ? `bucket ${bucket} not found in ${region}` : `HTTP ${err.status || "?"} — ${err.message.slice(0, 120)}`,
    };
  }
}

const CHECKERS = {
  local: checkLocal,
  netlify: checkNetlify,
  vercel: checkVercel,
  cloudflare: checkCloudflare,
  s3: checkS3,
};

/**
 * Configuration smells that don't fail a check but will bite the next deploy.
 * Reported as warnings (no exit-code impact), checked against the cwd so the
 * local .deployrc.json is taken into account.
 */
export function misconfigWarnings(cfg) {
  const warnings = [];
  if (cfg.defaultProvider && !loggedIn(cfg, cfg.defaultProvider)) {
    warnings.push(
      `defaultProvider "${cfg.defaultProvider}" is not logged in — deploy up will fail. Run: deploy login --provider ${cfg.defaultProvider}`
    );
  }
  try {
    const rcPath = path.join(process.cwd(), ".deployrc.json");
    if (fs.existsSync(rcPath)) {
      const rc = JSON.parse(fs.readFileSync(rcPath, "utf8"));
      if (rc.outDir && !fs.existsSync(path.resolve(process.cwd(), rc.outDir))) {
        warnings.push(`.deployrc.json outDir "${rc.outDir}" does not exist — the deploy would find no output folder`);
      }
    }
  } catch {
    // unreadable/invalid .deployrc.json is surfaced by the deploy command itself
  }
  return warnings;
}

/**
 * Run the full health report. `provider` (optional) limits to one provider.
 * Returns { config, checks, warnings } where each check is
 * { provider, loggedIn, ok, detail } (ok:null = not run, not a failure).
 */
export async function runDoctor(cfg = loadConfig(), { provider = null } = {}) {
  const names = provider ? [provider] : Object.keys(CHECKERS);
  const checks = [];
  for (const name of names) {
    const checker = CHECKERS[name];
    if (!checker) continue;
    checks.push(await checker(cfg));
  }
  return {
    config: { path: configPath(), exists: Boolean(cfg.server || cfg.token || Object.keys(cfg.providers || {}).length) },
    checks,
    warnings: misconfigWarnings(cfg),
  };
}
