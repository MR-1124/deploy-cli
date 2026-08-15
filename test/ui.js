// Interactive UI tests: spawn the real CLI with DEPLOY_FORCE_TTY=1 and piped
// stdin, driving the line-based select prompts (TTY arrow keys can't be tested
// without a terminal, but the prompt layer is identical).
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.resolve("cli.js");

function run(argv, input, { configDir, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd,
      env: { ...process.env, DEPLOY_FORCE_TTY: "1", DEPLOY_CONFIG_DIR: configDir, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.write(input);
    child.stdin.end();
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
  });
}

const tmpConfig = () => fs.mkdtempSync(path.join(os.tmpdir(), "deploy-ui-cfg-"));
const tmpProject = () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-ui-proj-"));
  fs.writeFileSync(path.join(p, "index.html"), "<h1>ui</h1>");
  return p;
};

// 1. bare `deploy` in a terminal → interactive menu → Quit
{
  const r = await run([], "9\n", { configDir: tmpConfig(), cwd: tmpProject() });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /What would you like to do\?/);
  assert.match(r.out, /Deploy now/);
  assert.match(r.out, /Login/);
  assert.match(r.out, /Quit/);
}

// 2. interactive login: pick netlify (2), type a token → saved to config
{
  const cfg = tmpConfig();
  const r = await run(["login"], "2\ntok-xyz\n", { configDir: cfg, cwd: tmpProject() });
  assert.equal(r.code, 0, r.err);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg, "config.json"), "utf8"));
  assert.equal(saved.providers.netlify.token, "tok-xyz");
}

// 3. interactive up: pick local (1) with no credentials → clean not-logged-in error
{
  const r = await run(["up"], "1\n", { configDir: tmpConfig(), cwd: tmpProject() });
  assert.equal(r.code, 1);
  assert.match(r.err, /Not logged in/);
}

// 4. bare menu → Login (3) → local (1) → saves local control plane credentials
{
  const cfg = tmpConfig();
  const r = await run([], "3\n1\n", { configDir: cfg, cwd: tmpProject() });
  assert.equal(r.code, 0, r.err);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg, "config.json"), "utf8"));
  assert.equal(saved.server, "http://localhost:8787");
  assert.equal(saved.token, "dev-token");
}

console.log("✔ ui tests passed (interactive menu, login prompts, provider select)");
