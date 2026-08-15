#!/usr/bin/env node
// deploy — one-command deploys for static sites.
//   deploy                                  build + upload + print URL (local control plane)
//   deploy up --provider netlify|vercel|cloudflare|s3   deploy to a real host
//   deploy preview                          deploy to a preview URL — never touches production
//   deploy rollback <id>                    re-point the production alias at a previous deploy
//   deploy list                             show deploy history for this project
//   deploy status                           show login state, project, last deploy
//   deploy doctor                           health report: config, login state, connectivity
//   deploy diff                             what changed vs the latest local deploy
//   deploy watch                            rebuild + redeploy on file changes
//   deploy login                            save credentials (--provider for host providers)
//   deploy server                           start the bundled local control plane
//   deploy completion <bash|zsh|fish>       shell completions
//   deploy token                            print the dev server token

import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import {
  buildCommand,
  currentBranch,
  packageManager,
  readJson,
  resolveOutDir,
  runBuild,
  slugify,
} from "./lib/build.js";
import { parseArgs } from "./lib/args.js";
import { configPath, loadConfig, normalizeServer, saveConfig } from "./lib/config.js";
import { health } from "./lib/upload.js";
import { PROVIDERS, getProvider } from "./lib/providers/index.js";
import { createServer } from "./lib/server.js";
import { listFiles } from "./lib/files.js";
import { bold, dim, fail, green, link, ok, red, section, table, warn, yellow } from "./lib/format.js";
import { banner, interactive, select, text } from "./lib/ui.js";
import { misconfigWarnings, runDoctor } from "./lib/doctor.js";

const HELP = `deploy — one-command deploys for static sites

Usage:
  deploy                    interactive menu (in a terminal); otherwise build + upload + URL
  deploy up                 build, upload, and print the live URL
  deploy preview            deploy to a preview URL — never touches production
  deploy rollback <id>      re-point the production alias at a previous deploy
  deploy list               show deploy history for this project
  deploy status             login state, project, last deploy
  deploy doctor             health report: config, login state, connectivity
  deploy diff               what changed vs the latest local deploy
  deploy watch              rebuild + redeploy on file changes (Ctrl+C to stop)
  deploy login              save credentials (--provider for host providers)
  deploy server             start the bundled local control plane (default :8787)
  deploy completion <shell> bash/zsh/fish completions
  deploy token              print the dev server token

Providers (--provider <name>, default "local"):
  local       the bundled control plane: http://localhost:8787/<project>/latest/
  netlify     Netlify API — digest uploads for production, zip for previews
  vercel      Vercel API — sha256 file uploads + files-manifest deployment
  cloudflare  Cloudflare Pages — direct upload (requires --account)
  s3          S3 static hosting — SigV4-signed PutObject (requires --bucket)

Examples:
  deploy login --provider netlify --token <PAT>
  deploy up --provider netlify --site my-site
  deploy login --provider vercel --token <token> --team <teamId>
  deploy up --provider vercel
  deploy login --provider cloudflare --token <token> --account <accountId>
  deploy login --provider s3 --access-key <AK> --secret-key <SK> --bucket <name> --region us-east-1
  deploy preview --provider netlify          # branch deploy, production untouched
  deploy rollback <id> --provider vercel

Options:
  --project <name>    override the project name
  --dir <path>        upload this folder instead of the detected output dir
  --no-build          skip the build step
  --provider <name>   local | netlify | vercel | cloudflare | s3
  --site <name>       Netlify site (auto-created if missing)
  --method <m>        Netlify upload method: digest (default) | zip
  --team <teamId>     Vercel team id
  --account <id>      Cloudflare account id
  --bucket <name>     S3 bucket
  --region <r>        S3 region (default us-east-1)
  --prefix <p>        S3 key prefix (default: project name)
  --server <url>      local control plane URL (default http://localhost:8787)
  --token <token>     local control plane token (default dev-token)
  --port <n>          local server port (default 8787)
  --storage <path>    local server storage dir (default ./.deploy-storage)
  --wait / --no-wait  wait for the host to finish processing the deploy
  --open              open the deploy URL in your browser
  --force             skip pre-flight caps (file count / total size)
  --json              machine-readable output (URLs as JSON)
  --verbose           print stack traces on errors
  -h, --help          show this help
  --version           print version

Project detection: package.json build script → dist/build/out/public → static root.
`;

let verbose = false;

function pickProvider(flags, cfg) {
  return flags.provider || cfg.defaultProvider || "local";
}

async function cmdLogin(flags) {
  const pname = pickProvider(flags, loadConfig());
  if (pname === "local" && !flags.provider && interactive()) {
    return interactiveLogin(flags);
  }
  if (pname !== "local") {
    const provider = getProvider(pname);
    const pcfg = await provider.login({ flags, config: loadConfig() });
    const cfg = loadConfig();
    cfg.providers = { ...(cfg.providers || {}), [pname]: { ...(cfg.providers?.[pname] || {}), ...pcfg } };
    saveConfig(cfg);
    ok(`${provider.name} credentials saved → ${configPath()}`);
    return;
  }
  const server = normalizeServer(flags.server || "http://localhost:8787");
  const token = flags.token || "dev-token";
  const file = saveConfig({ ...loadConfig(), server, token });
  ok(`Credentials saved for ${server}`);
  console.log(`  config: ${file}`);
  try {
    const h = await health(server);
    console.log(`  server: ${h.service} · ok`);
  } catch {
    warn(`server not reachable at ${server} — start it with: deploy server`);
  }
}

/** Run fn with human output diverted to stderr so stdout stays pure (--json). */
async function withJsonStdout(fn) {
  const oldLog = console.log;
  console.log = (...a) => process.stderr.write(a.join(" ") + "\n");
  try {
    return await fn();
  } finally {
    console.log = oldLog;
  }
}

/** Interactive menu shown when `deploy` runs bare in a terminal. */
async function interactiveMenu(flags) {
  banner();
  const choice = await select("What would you like to do?", [
    { label: "Deploy now", value: "up" },
    { label: "Preview deploy", value: "preview" },
    { label: "Login", value: "login" },
    { label: "List deploys", value: "list" },
    { label: "Rollback", value: "rollback" },
    { label: "Status", value: "status" },
    { label: "Watch", value: "watch" },
    { label: "Diff", value: "diff" },
    { label: "Quit", value: "quit" },
  ]);
  if (!choice || choice.value === "quit") return 0;
  switch (choice.value) {
    case "up":
      await cmdUp(flags);
      return 0;
    case "preview":
      await cmdUp(flags, { preview: true });
      return 0;
    case "login":
      return interactiveLogin(flags);
    case "list":
      await cmdList(flags);
      return 0;
    case "rollback":
      return interactiveRollback(flags);
    case "status":
      await cmdStatus(flags);
      return 0;
    case "watch":
      await cmdWatch(flags);
      return 0;
    case "diff":
      await cmdDiff(flags);
      return 0;
    default:
      return 0;
  }
}

/** Prompt for provider + token instead of requiring --provider/--token. */
async function interactiveLogin(flags) {
  const names = Object.keys(PROVIDERS);
  const choice = await select("Which provider?", names.map((n) => ({ label: n, value: n })));
  if (!choice) return 0;
  if (choice.value === "local") {
    await cmdLogin({ ...flags, provider: "local" });
    return 0;
  }
  const token = await text(`Enter your ${choice.value} token`, { mask: true });
  if (!token) {
    fail("no token provided — cancelling");
    return 1;
  }
  await cmdLogin({ ...flags, provider: choice.value, token });
  return 0;
}

/** Pick a previous deploy to roll back to. */
async function interactiveRollback(flags) {
  const cfg = loadConfig();
  const provider = getProvider(pickProvider(flags, cfg));
  const root = process.cwd();
  const rc = readJson(root, ".deployrc.json") || {};
  const pkg = readJson(root, "package.json") || {};
  const project = slugify(flags.project || rc.project || pkg.name || path.basename(root));
  const rows = await provider.list({ project, flags, config: cfg, rc, root });
  if (!rows.length) {
    console.log(`No deploys for "${project}" (${provider.name}) to roll back to.`);
    return 0;
  }
  const choice = await select(
    `Roll back "${project}" (${provider.name}) to which deploy?`,
    rows.map((r) => ({
      label: `${r.id}  ${(r.createdAt || "").slice(0, 19).replace("T", " ")}${r.production ? "  (current)" : ""}`,
      value: r.id,
    }))
  );
  if (!choice) return 0;
  await cmdRollback([choice.value], flags);
  return 0;
}

async function cmdUp(flags, { preview = false } = {}) {
  const run = async () => {
    const cfg = loadConfig();
    if (!flags.provider && !cfg.defaultProvider && interactive()) {
      const choice = await select(
        "Which provider?",
        Object.keys(PROVIDERS).map((n) => ({ label: n, value: n }))
      );
      if (!choice) return null;
      flags = { ...flags, provider: choice.value };
    }
    const pname = pickProvider(flags, cfg);
    const provider = getProvider(pname);
    const root = process.cwd();
    const rc = readJson(root, ".deployrc.json") || {};
    const pkg = readJson(root, "package.json") || {};

    const project = slugify(flags.project || rc.project || pkg.name || path.basename(root));
    const cmd = buildCommand(root, rc);
    if (cmd && !flags.noBuild) {
      section(`Building (${packageManager(root)} detected)`);
      console.log(`  $ ${cmd}`);
      await runBuild(cmd, root);
    } else if (cmd && flags.noBuild) {
      console.log("→ Skipping build (--no-build)");
    }

    const outDir = resolveOutDir(root, rc, Boolean(cmd), flags.dir);
    const branch = preview ? currentBranch(root) || "preview" : flags.branch || null;

    section(`Deploying to ${provider.name}`);
    const result = await provider.deploy({ project, outDir, branch, preview, flags, config: cfg, rc, root });
    ok(`Deployed ${result.id || ""}`.trimEnd());
    if (result.url) console.log(`  URL:    ${link(result.url)}`);
    if (result.deployUrl && result.deployUrl !== result.url) console.log(`  Deploy: ${link(result.deployUrl)}`);
    if (result.bytes) console.log(`  Size:   ${(result.bytes / 1024).toFixed(0)} KB payload`);
    if (result.state) console.log(`  State:  ${result.state}`);
    if (branch) console.log(`  Branch: ${branch} → preview (${provider.name}), production untouched`);
    if (flags.open && result.url) openBrowser(result.url);
    return result;
  };
  if (flags.json) {
    const result = await withJsonStdout(run);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  return run();
}

async function cmdRollback(args, flags) {
  const cfg = loadConfig();
  const id = args[0];
  if (!id) throw new Error("Usage: deploy rollback <deployId>");
  const root = process.cwd();
  const rc = readJson(root, ".deployrc.json") || {};
  const pkg = readJson(root, "package.json") || {};
  const project = slugify(flags.project || rc.project || pkg.name || path.basename(root));
  const provider = getProvider(pickProvider(flags, cfg));
  const run = async () => {
    const result = await provider.rollback({ project, deployId: id, flags, config: cfg, rc, root });
    ok(`Rolled back ${project} → ${id} (${provider.name})`);
    if (result.url) console.log(`  ${link(result.url)}`);
    return result;
  };
  if (flags.json) {
    const result = await withJsonStdout(run);
    console.log(JSON.stringify({ project, deployId: id, url: result.url || null }, null, 2));
    return result;
  }
  return run();
}

async function cmdList(flags) {
  const cfg = loadConfig();
  const root = process.cwd();
  const rc = readJson(root, ".deployrc.json") || {};
  const pkg = readJson(root, "package.json") || {};
  const project = slugify(flags.project || rc.project || pkg.name || path.basename(root));
  const provider = getProvider(pickProvider(flags, cfg));
  const run = async () => {
    const rows = await provider.list({ project, flags, config: cfg, rc, root });
    if (!rows.length) {
      console.log(`No deploys for "${project}" (${provider.name}).`);
      return rows;
    }
    console.log(`Deploys for ${project} (${provider.name}):`);
    table(
      ["id", "created", "branch", "url", "tags"],
      rows.map((d) => [
        d.id,
        (d.createdAt || "").slice(0, 19).replace("T", " "),
        d.branch || "main",
        d.url || "",
        [d.production ? "★ production" : "", (d.aliases || []).join(", ")].filter(Boolean).join(" "),
      ])
    );
    return rows;
  };
  if (flags.json) {
    const rows = await withJsonStdout(run);
    console.log(JSON.stringify(rows, null, 2));
    return rows;
  }
  return run();
}

async function cmdStatus(flags) {
  const cfg = loadConfig();
  const root = process.cwd();
  const rc = readJson(root, ".deployrc.json") || {};
  const pkg = readJson(root, "package.json") || {};
  const project = slugify(flags.project || rc.project || pkg.name || path.basename(root));

  console.log(bold(`deploy status`));
  console.log(`  project:          ${project}`);
  console.log(`  default provider: ${cfg.defaultProvider || "local"}`);
  const rcNotes = [];
  if (rc.project) rcNotes.push(`project=${rc.project}`);
  if (rc.netlify?.site) rcNotes.push(`netlify.site=${rc.netlify.site}`);
  if (rc.vercel?.project) rcNotes.push(`vercel.project=${rc.vercel.project}`);
  if (rc.cloudflare?.project) rcNotes.push(`cloudflare.project=${rc.cloudflare.project}`);
  if (rcNotes.length) console.log(`  .deployrc:        ${rcNotes.join(", ")}`);

  const loggedIn = (p, name) => {
    const s = cfg.providers?.[name] || {};
    switch (name) {
      case "local":
        return Boolean(cfg.server && cfg.token);
      case "netlify":
      case "vercel":
        return Boolean(s.token);
      case "cloudflare":
        return Boolean(s.token && (s.accountId || process.env.CLOUDFLARE_ACCOUNT_ID));
      case "s3":
        return Boolean(s.accessKeyId && s.secretAccessKey && s.bucket);
      default:
        return false;
    }
  };
  const detailsFor = (name, s) => {
    switch (name) {
      case "local":
        return s.server || "";
      case "netlify":
        return s.site ? `site=${s.site}` : "";
      case "vercel":
        return s.teamId ? `team=${s.teamId}` : "";
      case "cloudflare":
        return s.accountId ? `account=${s.accountId}` : "";
      case "s3":
        return [s.bucket, s.region].filter(Boolean).join(" ");
      default:
        return "";
    }
  };
  console.log("");
  table(
    ["provider", "logged in", "details"],
    Object.entries(PROVIDERS).map(([name]) => {
      const s = cfg.providers?.[name] || {};
      return [name, loggedIn(cfg, name) ? green("yes") : dim("no"), detailsFor(name, s)];
    })
  );

  // last deploy for the default provider
  const provider = getProvider(pickProvider(flags, cfg));
  console.log("");
  try {
    const rows = await provider.list({ project, flags, config: cfg, rc, root });
    const last = rows.find((r) => r.production) || rows[rows.length - 1];
    if (last) {
      console.log(`  last deploy (${provider.name}): ${last.id}${last.url ? " " + link(last.url) : ""}`);
      if (last.createdAt) console.log(`    created: ${last.createdAt}`);
    } else {
      console.log(`  no deploys yet (${provider.name}) — run: deploy up`);
    }
  } catch (err) {
    console.log(`  last deploy: ${yellow("n/a")} (${err.message})`);
  }
}

async function cmdDoctor(flags) {
  const run = async () => {
    const report = await runDoctor(loadConfig(), { provider: flags.provider });
    const failed = report.checks.some((c) => c.ok === false);

    console.log(bold("deploy doctor — health report"));
    console.log(`  config: ${report.config.exists ? report.config.path : "no config yet"}`);
    console.log("");
    table(
      ["provider", "logged in", "status", "details"],
      report.checks.map((c) => [
        c.provider,
        c.loggedIn ? green("yes") : dim("no"),
        c.ok === true ? green("ok") : c.ok === false ? red("fail") : dim("—"),
        c.detail,
      ])
    );
    for (const w of report.warnings) console.log(`  ${yellow("⚠")} ${w}`);
    if (failed) {
      console.log("");
      fail(`${report.checks.filter((c) => c.ok === false).length} provider(s) have problems`);
    } else {
      console.log("");
      ok("all checks passed");
    }
    return { ...report, failed };
  };
  if (flags.json) {
    const report = await withJsonStdout(run);
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  return run();
}

async function cmdDiff(flags) {
  const cfg = loadConfig();
  const pname = pickProvider(flags, cfg);
  if (pname !== "local") {
    throw new Error(`deploy diff currently works with the local provider (got "${pname}")`);
  }
  const root = process.cwd();
  const rc = readJson(root, ".deployrc.json") || {};
  const pkg = readJson(root, "package.json") || {};
  const project = slugify(flags.project || rc.project || pkg.name || path.basename(root));
  const cmd = buildCommand(root, rc);
  const outDir = resolveOutDir(root, rc, Boolean(cmd), flags.dir);

  const rows = await PROVIDERS.local.list({ project, config: cfg });
  const latest = rows.find((r) => r.production) || rows[0];
  if (!latest) throw new Error("No deploys yet — run: deploy up");

  const remote = await PROVIDERS.local.files({ project, deployId: latest.id, config: cfg });
  const localMap = new Map(
    (await listFiles(outDir)).filter((f) => f.type === "file").map((f) => [f.rel, f.size])
  );
  const remoteMap = new Map(remote.files.map((f) => [f.path, f.size]));

  const added = [...localMap.keys()].filter((k) => !remoteMap.has(k));
  const removed = [...remoteMap.keys()].filter((k) => !localMap.has(k));
  const changed = [...localMap.keys()].filter((k) => remoteMap.has(k) && localMap.get(k) !== remoteMap.get(k));

  console.log(`Diff vs ${latest.id} (local, size-based):`);
  const show = (label, items) => {
    if (!items.length) return;
    console.log(`  ${label} (${items.length}):`);
    for (const i of items.slice(0, 25)) console.log(`    ${i}`);
    if (items.length > 25) console.log(`    … and ${items.length - 25} more`);
  };
  show(green("added"), added);
  show(yellow("changed"), changed);
  show(red("removed"), removed);
  if (!added.length && !changed.length && !removed.length) console.log("  no differences");
}

async function cmdWatch(flags) {
  const cfg = loadConfig();
  const provider = getProvider(pickProvider(flags, cfg));
  const root = process.cwd();
  const rc = readJson(root, ".deployrc.json") || {};
  const pkg = readJson(root, "package.json") || {};
  const project = slugify(flags.project || rc.project || pkg.name || path.basename(root));
  const cmd = buildCommand(root, rc);

  const snapshot = async () => {
    const files = (await listFiles(root)).filter((f) => f.type === "file");
    return new Map(files.map((f) => [f.rel, f.mtimeMs]));
  };
  const same = (a, b) => a.size === b.size && [...a.keys()].every((k) => b.get(k) === a.get(k));

  let current = await snapshot();
  let deploying = false;
  const deployNow = async (why) => {
    deploying = true;
    if (why) console.log(`\n${dim(why)}`);
    try {
      if (cmd && !flags.noBuild) {
        console.log(`  $ ${cmd}`);
        await runBuild(cmd, root);
      }
      const outDir = resolveOutDir(root, rc, Boolean(cmd), flags.dir);
      const result = await provider.deploy({ project, outDir, branch: null, preview: false, flags, config: cfg, rc, root });
      ok(`live at ${link(result.url)}`);
    } catch (err) {
      if (verbose) console.error(err.stack);
      fail(err.message);
      if (err.hint) console.log(`  ${dim(err.hint)}`);
    }
    current = await snapshot();
    deploying = false;
  };

  console.log(`Watching ${root} for changes (${provider.name}) — Ctrl+C to stop`);
  await deployNow("initial deploy");
  setInterval(async () => {
    if (deploying) return; // skip while a deploy is in flight (prevents double-deploys)
    try {
      const next = await snapshot();
      if (!same(current, next)) await deployNow("change detected — redeploying");
    } catch (err) {
      fail(err.message);
    }
  }, 1000);
  process.on("SIGINT", () => {
    console.log("\nstopped");
    process.exit(0);
  });
}

function cmdCompletion(args, flags) {
  const shell = args[0] || flags.shell || "bash";
  const COMMANDS = "up preview rollback list login status doctor diff watch completion server token help";
  const FLAGS =
    "--project --dir --no-build --provider --site --team --method --account --bucket --region --prefix --server --token --port --storage --wait --open --force --json --verbose --timeout --shell --help --version";
  if (shell === "bash") {
    console.log(`_deploy_complete() { COMPREPLY=( $(compgen -W "${COMMANDS} ${FLAGS}" -- "\${COMP_WORDS[COMP_CWORD]}") ); }
complete -F _deploy_complete deploy`);
  } else if (shell === "zsh") {
    console.log(`#compdef deploy
_arguments '*: :(( ${COMMANDS.split(" ").map((c) => `${c}\\:"${c}"`).join(" ")} ${FLAGS.split(" ").map((f) => `${f}\\:"${f}"`).join(" ")} ))'
compdef _deploy deploy`);
  } else if (shell === "fish") {
    for (const c of COMMANDS.split(" ")) console.log(`complete -c deploy -f -n '__fish_use_subcommand' -a '${c}'`);
    for (const f of FLAGS.split(" ")) console.log(`complete -c deploy -l '${f.slice(2)}'`);
  } else {
    throw new Error(`Unsupported shell "${shell}" — use bash, zsh, or fish`);
  }
}

async function cmdServer(flags) {
  const port = Number(flags.port || process.env.PORT || 8787);
  const storageDir = path.resolve(flags.storage || ".deploy-storage");
  const token = flags.token || process.env.DEPLOY_SERVER_TOKEN || "dev-token";
  const server = createServer({ storageDir, token });
  server.listen(port, () => {
    console.log(`deploy server on http://localhost:${port}`);
    console.log(`  storage: ${storageDir}`);
    console.log(`  token:   ${token}`);
  });
}

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
  child.on("error", () => warn(`could not open browser for ${url}`));
  child.unref();
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, args } = parseArgs(argv);
  verbose = !!flags.verbose;
  try {
    if (flags.help) {
      console.log(HELP);
      return 0;
    }
    if (flags.version) {
      console.log(require("./package.json").version);
      return 0;
    }

    const command = args[0] || "up";
    if (!args[0] && interactive()) {
      return interactiveMenu(flags);
    }
    switch (command) {
      case "login":
        await cmdLogin(flags);
        return 0;
      case "up":
        await cmdUp(flags);
        return 0;
      case "preview":
        await cmdUp(flags, { preview: true });
        return 0;
      case "rollback":
        await cmdRollback(args.slice(1), flags);
        return 0;
      case "list":
        await cmdList(flags);
        return 0;
      case "status":
        await cmdStatus(flags);
        return 0;
      case "doctor": {
        const report = await cmdDoctor(flags);
        return report.failed ? 1 : 0;
      }
      case "diff":
        await cmdDiff(flags);
        return 0;
      case "watch":
        await cmdWatch(flags);
        return 0;
      case "completion":
        cmdCompletion(args.slice(1), flags);
        return 0;
      case "server":
        await cmdServer(flags);
        return 0;
      case "token":
        console.log(flags.token || "dev-token");
        return 0;
      case "help":
        console.log(HELP);
        return 0;
      default:
        console.error(`✖ Unknown command "${command}"\n`);
        console.log(HELP);
        return 1;
    }
  } catch (err) {
    if (verbose) console.error(err.stack);
    fail(err.message);
    if (err.hint) console.log(`  ${dim(err.hint)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
