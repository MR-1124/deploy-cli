// Project detection: find the build command and the folder that should ship.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const OUTPUT_DIRS = ["dist", "build", "out", "public"];

export function readJson(root, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  } catch {
    return null;
  }
}

/** Resolve the package manager from lockfiles, defaulting to npm. */
export function packageManager(root) {
  for (const [file, pm] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ]) {
    if (fs.existsSync(path.join(root, file))) return pm;
  }
  return "npm";
}

/** Full build command for this project, or null if there is none. */
export function buildCommand(root, rc = {}) {
  if (rc.buildCommand) return rc.buildCommand;
  const pkg = readJson(root, "package.json");
  if (pkg && pkg.scripts && pkg.scripts.build) {
    return `${packageManager(root)} run build`;
  }
  return null;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine the folder to upload. Priority:
 *   1. --dir flag
 *   2. .deployrc.json outDir
 *   3. known output dirs, if a build script exists
 *   4. public/ or a static site at the project root
 */
export function resolveOutDir(root, rc = {}, hasBuild, dir) {
  if (dir) return path.resolve(root, dir);
  if (rc.outDir) return path.resolve(root, rc.outDir);
  if (hasBuild) {
    for (const d of OUTPUT_DIRS) {
      if (isDir(path.join(root, d))) return path.join(root, d);
    }
    throw new Error(
      `Build script found but no output directory (${OUTPUT_DIRS.join("/")}). ` +
        `Set "outDir" in .deployrc.json or pass --dir.`
    );
  }
  if (isDir(path.join(root, "public"))) return path.join(root, "public");
  if (exists(path.join(root, "index.html"))) return root;
  throw new Error(
    "No deployable site found. Add a build script, a public/ folder, an index.html, " +
      "or set outDir in .deployrc.json."
  );
}

/** Run the build, inheriting stdio, and fail the CLI if it exits non-zero. */
export function runBuild(cmd, root) {
  return new Promise((resolve, reject) => {
    // shell:true takes the whole command string — keeps Windows/Git Bash parity
    const child = spawn(cmd, { cwd: root, shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Build failed (exit ${code})`))));
  });
}

/** Current git branch name, or null when not in a git repo. */
export function currentBranch(root) {
  const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  const branch = res.status === 0 ? res.stdout.trim() : "";
  return branch && branch !== "HEAD" ? branch : null;
}

/** Slugify a project/branch name into something URL-safe. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "site";
}
