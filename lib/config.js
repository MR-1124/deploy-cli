// CLI credential storage. Mirrors a production CLI that keeps tokens in the
// OS keychain: here it's a JSON file in ~/.deploy-cli (0600), overridable via
// DEPLOY_CONFIG_DIR so the whole flow can run sandboxed inside a repo.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = process.env.DEPLOY_CONFIG_DIR || path.join(os.homedir(), ".deploy-cli");
const file = path.join(dir, "config.json");

export function configPath() {
  return file;
}

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return file;
}

export function normalizeServer(url) {
  return String(url || "").replace(/\/+$/, "");
}
