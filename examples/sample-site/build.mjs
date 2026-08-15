// Trivial static build: inject a build timestamp into index.html and copy
// assets into dist/. A real project would run Vite/Webpack/Next here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, "src");
const out = path.join(root, "dist");

fs.mkdirSync(out, { recursive: true });

let html = fs.readFileSync(path.join(src, "index.html"), "utf8");
html = html.replace("__BUILD_TIME__", new Date().toISOString());
fs.writeFileSync(path.join(out, "index.html"), html);

fs.copyFileSync(path.join(src, "style.css"), path.join(out, "style.css"));
console.log("✔ built dist/ (index.html + style.css)");
