// CLI tests: argument parsing and command-level error paths, run in-process
// against main(). This is the layer that would have caught the --no-build bug.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Sandbox the config dir and disable color before anything imports the CLI.
const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-config-"));
process.env.DEPLOY_CONFIG_DIR = tmpConfig;
process.env.NO_COLOR = "1";

const { parseArgs } = await import("../lib/args.js");
const { main } = await import("../cli.js");

// --- normalizeServer ---------------------------------------------------------
{
  const { normalizeServer } = await import("../lib/config.js");
  assert.equal(normalizeServer("http://localhost:8787/"), "http://localhost:8787");
  assert.equal(normalizeServer("https://my-domain.app///"), "https://my-domain.app");
  assert.equal(normalizeServer("localhost:8787"), "http://localhost:8787");
  assert.equal(normalizeServer(""), "");
}

// --- parseArgs ---------------------------------------------------------------

{
  const { flags, args } = parseArgs([
    "up",
    "--project",
    "my-site",
    "--no-build",
    "--dir=dist",
    "--provider",
    "netlify",
    "extra",
  ]);
  assert.equal(flags.project, "my-site"); // --flag value consumes the next arg
  assert.equal(flags.noBuild, true); // kebab-case → camelCase
  assert.equal(flags.dir, "dist"); // --flag=value form
  assert.equal(flags.provider, "netlify");
  assert.deepEqual(args, ["up", "extra"]);
}

{
  const { flags } = parseArgs(["--preview", "--force", "--open"]);
  assert.equal(flags.preview, true);
  assert.equal(flags.force, true);
  assert.equal(flags.open, true);
}

{
  const { flags } = parseArgs(["--provider"]);
  assert.equal(flags.provider, undefined); // dangling value flag is safe
}

// --- resolveOutDir honors --dir (regression: flag was parsed but never applied)

{
  const { resolveOutDir } = await import("../lib/build.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-dirflag-"));
  fs.mkdirSync(path.join(root, "custom"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>root</h1>");
  fs.writeFileSync(path.join(root, "custom", "index.html"), "<h1>custom</h1>");
  // explicit --dir wins over the static-site root
  assert.equal(resolveOutDir(root, {}, false, "custom"), path.join(root, "custom"));
  // --dir also wins over rc.outDir
  assert.equal(resolveOutDir(root, { outDir: "custom" }, false, "custom"), path.join(root, "custom"));
  // and over a detected build output dir
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.html"), "<h1>dist</h1>");
  assert.equal(resolveOutDir(root, {}, true, "custom"), path.join(root, "custom"));
  // without the flag, normal priority applies
  assert.equal(resolveOutDir(root, {}, false), root);
  assert.equal(resolveOutDir(root, {}, true), path.join(root, "dist"));
}

// --- main() command tests -----------------------------------------------------

async function run(argv) {
  const out = [];
  const err = [];
  const oldLog = console.log;
  const oldErr = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  let code;
  try {
    code = await main(argv);
  } finally {
    console.log = oldLog;
    console.error = oldErr;
  }
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// static site (no build script) so outDir resolves to the project root
// and the not-logged-in error surfaces before any upload
const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-proj-"));
fs.writeFileSync(path.join(tmpProject, "package.json"), JSON.stringify({ name: "cli-test-proj" }));
fs.writeFileSync(path.join(tmpProject, "index.html"), "<h1>hi</h1>");
const oldCwd = process.cwd();

try {
  process.chdir(tmpProject);

  // help / version / completion
  assert.equal((await run(["--help"])).code, 0);
  assert.equal((await run(["--version"])).code, 0);
  const comp = await run(["completion", "bash"]);
  assert.equal(comp.code, 0);
  assert.match(comp.out, /complete -F/);
  const compFish = await run(["completion", "fish"]);
  assert.equal(compFish.code, 0);
  assert.match(compFish.out, /complete -c deploy/);

  // unknown command
  const u = await run(["frobnicate"]);
  assert.equal(u.code, 1);
  assert.match(u.err, /Unknown command "frobnicate"/);

  // rollback without an id
  const r = await run(["rollback"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Usage: deploy rollback/);

  // not logged in (fresh config dir → local provider)
  const n = await run(["up", "--no-build"]);
  assert.equal(n.code, 1);
  assert.match(n.err, /Not logged in/);

  // unknown provider
  const p = await run(["up", "--provider", "bogus"]);
  assert.equal(p.code, 1);
  assert.match(p.err, /Unknown provider "bogus"/);

  // netlify login without a token
  const l = await run(["login", "--provider", "netlify"]);
  assert.equal(l.code, 1);
  assert.match(l.err, /Pass a token/);

  // s3 login without credentials
  const s = await run(["login", "--provider", "s3"]);
  assert.equal(s.code, 1);
  assert.match(s.err, /access-key/);

  // diff only works with the local provider
  const d = await run(["diff", "--provider", "vercel"]);
  assert.equal(d.code, 1);
  assert.match(d.err, /local provider/);

  // no deployable site
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-empty-"));
  process.chdir(empty);
  const e = await run(["up", "--no-build"]);
  assert.equal(e.code, 1);
  assert.match(e.err, /No deployable site/);
  process.chdir(tmpProject);
} finally {
  process.chdir(oldCwd);
}

// --- doctor -------------------------------------------------------------------
// Hermetic: mock local control planes on random ports; remote providers have no
// tokens in the sandbox config, so their checks are skipped (no network).

const { saveConfig } = await import("../lib/config.js");
import http from "node:http";

function mockControlPlane(status) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/api/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, service: "deploy" }));
      }
      if (req.url.startsWith("/api/deploy")) {
        res.writeHead(status, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(status === 400 ? { error: "empty upload" } : { error: "unauthorized" }));
      }
      res.writeHead(404);
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

{
  // good token → all local checks pass, exit 0
  const server = await mockControlPlane(400);
  const port = server.address().port;
  saveConfig({ server: `http://127.0.0.1:${port}`, token: "good-token" });
  const d = await run(["doctor"]);
  assert.equal(d.code, 0, "doctor exits 0 when healthy");
  assert.match(d.out, /all checks passed/);

  // bad token → the local check fails, exit 1
  server.close();
  const server2 = await mockControlPlane(401);
  const port2 = server2.address().port;
  saveConfig({ server: `http://127.0.0.1:${port2}`, token: "bad-token" });
  const d2 = await run(["doctor"]);
  assert.equal(d2.code, 1, "doctor exits 1 on a failed check");
  assert.match(d2.out, /rejected the token/); // detail row in the table (stdout)
  assert.match(d2.err, /1 provider\(s\) have problems/); // fail() writes to stderr
  server2.close();

  // --json keeps stdout machine-pure and reports the same verdict
  const server3 = await mockControlPlane(401);
  const port3 = server3.address().port;
  saveConfig({ server: `http://127.0.0.1:${port3}`, token: "bad-token" });
  const d3 = await run(["doctor", "--json"]);
  assert.equal(d3.code, 1);
  const parsed = JSON.parse(d3.out); // throws if human output leaked to stdout
  const local = parsed.checks.find((c) => c.provider === "local");
  assert.equal(local.ok, false);
  assert.equal(parsed.failed, true);
  // remote providers: not logged in → ok:null, never a hard failure
  assert.ok(parsed.checks.every((c) => c.provider === "local" || c.ok === null));
  server3.close();
}

{
  // misconfiguration warnings: defaultProvider not logged in, rc outDir missing
  // (no local creds → local skipped, so the only signal is the warning)
  saveConfig({ defaultProvider: "netlify" });
  const d = await run(["doctor"]);
  assert.equal(d.code, 0, "warnings don't fail doctor");
  assert.match(d.out, /defaultProvider "netlify" is not logged in/);

  const warnCwd = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-rcwarn-"));
  fs.writeFileSync(path.join(warnCwd, ".deployrc.json"), JSON.stringify({ outDir: "missing-out" }));
  const prevCwd = process.cwd();
  process.chdir(warnCwd);
  const d2 = await run(["doctor"]);
  process.chdir(prevCwd);
  assert.equal(d2.code, 0);
  assert.match(d2.out, /outDir "missing-out" does not exist/);

  // warnings ride along in --json
  const d3 = await run(["doctor", "--json"]);
  assert.equal(d3.code, 0);
  const parsed = JSON.parse(d3.out);
  assert.ok(parsed.warnings.some((w) => w.includes("defaultProvider")));
}

// --- npm's Linux bin shim is a symlink: the CLI must still run when argv[1]
// differs from the module's real path. Regression: the entry guard compared
// import.meta.url to argv[1] verbatim, so a symlinked invocation silently
// skipped main() and exited 0 with no output (broke `deploy --version` on
// Linux installs; Windows .cmd shims pass the real path and never hit it).
{
  const repoRoot = path.resolve("..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-symlink-"));
  const pkgDir = path.join(dir, "node_modules", "@mayan1124", "deploy-cli");
  fs.mkdirSync(pkgDir, { recursive: true });
  try {
    fs.symlinkSync(path.join(repoRoot, "cli.js"), path.join(pkgDir, "cli.js"));
    fs.symlinkSync(path.join(repoRoot, "lib"), path.join(pkgDir, "lib"));
    fs.symlinkSync(path.join(repoRoot, "package.json"), path.join(pkgDir, "package.json"));
  } catch {
    console.log("  (skipped symlink-run test — symlinks unavailable here)");
  }
  if (fs.existsSync(path.join(pkgDir, "cli.js"))) {
    const binDir = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.join("..", "@mayan1124", "deploy-cli", "cli.js"), path.join(binDir, "deploy"));
    const V = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
    const out = spawnSync(process.execPath, [path.join(binDir, "deploy"), "--version"], { encoding: "utf8" });
    assert.equal(out.status, 0, `symlinked deploy --version exit (stderr: ${out.stderr})`);
    assert.equal(out.stdout.trim(), V, `symlinked deploy --version printed ${JSON.stringify(out.stdout)}`);
    // library import must NOT run main()
    const lib = spawnSync(process.execPath, ["-e", "import('@mayan1124/deploy-cli')"], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(lib.status, 0);
    assert.ok(!lib.stdout.includes(V), "importing the package must not execute the CLI");
  }
}

console.log("✔ cli tests passed (arg parsing, commands, error paths, doctor)");
