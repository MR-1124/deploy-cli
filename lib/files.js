// Shared file walker with sane exclusions, used by the tar/zip packers,
// pre-flight checks, and the Vercel/S3/Netlify-digest upload paths.

import fs from "node:fs";
import path from "node:path";

export const EXCLUDED = new Set(["node_modules", ".git", ".svn", ".hg"]);

/**
 * Recursively list files under dir.
 * Returns [{ path, rel, type, size }] with forward-slash relative paths.
 * `size` is present for files.
 */
export async function listFiles(dir, { dirs = false, root = dir } = {}) {
  const out = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".deploy") || EXCLUDED.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (dirs) out.push({ path: full, rel, type: "dir" });
      out.push(...(await listFiles(full, { dirs, root })));
    } else {
      const stat = await fs.promises.stat(full);
      out.push({ path: full, rel, type: "file", size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}
