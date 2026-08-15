// deploy-cli landing page: install copy button + animated terminal demo.

// --- copy button --------------------------------------------------------------
const copyBtn = document.getElementById("copy-btn");
const installCmd = document.getElementById("install-cmd");

copyBtn.addEventListener("click", async () => {
  const text = installCmd.textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback for older browsers / non-secure contexts
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  copyBtn.textContent = "Copied ✓";
  copyBtn.classList.add("copied");
  setTimeout(() => {
    copyBtn.textContent = "Copy";
    copyBtn.classList.remove("copied");
  }, 1800);
});

// --- animated terminal ----------------------------------------------------------
// Lines: [text, kind] where kind ∈ { cmd, out, ok, dim, url }
const SCRIPT = [
  ["$ deploy", "cmd"],
  ["→ Building (npm detected)", "dim"],
  ["  $ npm run build", "cmd"],
  ["✔ built dist/ (2 files, 214 KB)", "ok"],
  ["→ 2 files, 214 KB (local)", "dim"],
  ["✔ Deployed 20260815-091200-ab12", "ok"],
  ["  URL:    http://localhost:8787/my-app/latest/", "url"],
  ["  Deploy: http://localhost:8787/my-app/20260815-091200-ab12/", "url"],
  ["", ""],
  ["$ deploy up --provider netlify --site my-app", "cmd"],
  ["✔ Deployed a1b2c3d4", "ok"],
  ["  URL:    https://my-app.netlify.app", "url"],
  ["  State:  ready", "dim"],
  ["", ""],
  ["$ deploy rollback 20260815-091200-ab12", "cmd"],
  ["✔ Rolled back my-app → 20260815-091200-ab12 (local)", "ok"],
  ["  http://localhost:8787/my-app/latest/", "url"],
];

const body = document.getElementById("terminal-body");

function cls(kind) {
  return {
    ok: "c-green",
    url: "c-cyan",
    dim: "c-dim",
  }[kind] || "";
}

async function runDemo() {
  body.textContent = "";
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  body.appendChild(cursor);

  for (const [text, kind] of SCRIPT) {
    const line = document.createElement("div");
    line.className = cls(kind);
    body.insertBefore(line, cursor);
    // type the line
    for (const ch of text) {
      line.textContent += ch;
      await sleep(kind === "cmd" ? 22 : 4);
    }
    await sleep(kind === "cmd" ? 380 : 120);
  }
  // idle blinking cursor for a while, then restart
  await sleep(2600);
  runDemo();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- reveal on scroll -----------------------------------------------------------
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("visible");
        io.unobserve(e.target);
      }
    }
  },
  { threshold: 0.12 }
);
document.querySelectorAll(".card, .provider, .steps li").forEach((el) => {
  el.classList.add("reveal");
  io.observe(el);
});

runDemo();
