// Pre-flight checks before a deploy: count files and total bytes, warn above
// soft thresholds, and abort above hard caps unless --force is passed.

import { listFiles } from "./files.js";
import { warn } from "./format.js";

export const SOFT_FILES = 1000;
export const SOFT_BYTES = 50 * 1024 * 1024; // 50 MB
export const HARD_FILES = 25000; // Netlify zip extraction cap
export const HARD_BYTES = 250 * 1024 * 1024; // 250 MB

export async function preflight(outDir, { force = false } = {}) {
  const files = (await listFiles(outDir)).filter((f) => f.type === "file");
  const total = files.reduce((n, f) => n + (f.size || 0), 0);

  if (files.length > SOFT_FILES) {
    warn(`${files.length} files — large static sites can hit provider limits (Netlify zip: 25k files).`);
  }
  if (total > SOFT_BYTES) {
    warn(`${(total / 1024 / 1024).toFixed(1)} MB — large deploys take longer and may hit timeouts.`);
  }
  if (!force && (files.length > HARD_FILES || total > HARD_BYTES)) {
    const reason =
      files.length > HARD_FILES
        ? `${files.length} files exceeds the ${HARD_FILES} file cap`
        : `${(total / 1024 / 1024).toFixed(1)} MB exceeds the ${HARD_BYTES / 1024 / 1024} MB cap`;
    throw new Error(`${reason}. Pass --force to override.`);
  }
  return { files, count: files.length, total };
}
