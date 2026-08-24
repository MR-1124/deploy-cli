// Interactive terminal UI, zero dependencies.
// - select(): arrow-key picker on a real TTY; numbered input when piped (CI-safe).
// - text() / confirm(): line prompts; masked input for tokens on a TTY.
// - withSpinner(): animated progress frame around an async task (TTY only).
// Interactivity is opt-in: only when stdout is a TTY (or DEPLOY_FORCE_TTY=1 for tests).
//
// Line input uses a small queue fed by readline 'line' events rather than
// rl.question(): sequential prompts on the same stream (and piped input that
// arrives up front) are handled correctly without reader lifecycle races.

import readline from "node:readline";

/** Whether interactive prompts should be offered at all. */
export const interactive = () => Boolean(process.stdout.isTTY) || Boolean(process.env.DEPLOY_FORCE_TTY);

const tty = () => process.stdout.isTTY && process.stdin.isTTY;

// --- line queue ---------------------------------------------------------------

let lineQueue = [];
let lineWaiters = [];
let lineReader = null;

function startLineReader() {
  if (lineReader) return;
  lineReader = readline.createInterface({ input: process.stdin, terminal: false });
  lineReader.on("line", (line) => {
    if (lineWaiters.length) lineWaiters.shift()(line);
    else lineQueue.push(line);
  });
  lineReader.on("close", () => {
    lineReader = null;
  });
}

function nextLine() {
  return new Promise((resolve) => {
    if (lineQueue.length) return resolve(lineQueue.shift());
    startLineReader();
    lineWaiters.push(resolve);
  });
}

export function banner() {
  console.log(
    [
      "  ██████╗ ███████╗██████╗ ██╗      ██████╗ ██╗   ██╗",
      "  ██╔══██╗██╔════╝██╔══██╗██║     ██╔═══██╗╚██╗ ██╔╝",
      "  ██║  ██║█████╗  ██████╔╝██║     ██║   ██║ ╚████╔╝",
      "  ██║  ██║██╔══╝  ██╔═══╝ ██║     ██║   ██║  ╚██╔╝",
      "  ██████╔╝███████╗██║     ███████╗╚██████╔╝   ██║",
      "  ╚═════╝ ╚══════╝╚═╝     ╚══════╝ ╚═════╝    ╚═╝",
    ].join("\n")
  );
  console.log("  one command to ship — local control plane, Netlify, Vercel, Cloudflare, S3\n");
}

/** Pick one option. options: [{ label, value }]. Returns the option or null on cancel. */
export function select(question, options, { defaultIndex = 0 } = {}) {
  if (tty()) return selectTTY(question, options, defaultIndex);
  return selectLines(question, options, defaultIndex);
}

/** Arrow-key picker (raw-mode readline keypresses). */
function selectTTY(question, options, defaultIndex) {
  return new Promise((resolve) => {
    let index = defaultIndex;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const redraw = () => {
      process.stdout.write(`\x1b[${options.length + 1}A\x1b[J${question}\n`);
      options.forEach((o, i) => process.stdout.write(`${i === index ? "  \u203a " : "    "}${o.label}\n`));
    };
    const done = (value) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKey);
      process.stdout.write("\n");
      resolve(value);
    };
    const onKey = (_str, key) => {
      if (key.name === "up") {
        index = (index - 1 + options.length) % options.length;
        redraw();
      } else if (key.name === "down") {
        index = (index + 1) % options.length;
        redraw();
      } else if (key.name === "return" || key.name === "enter") {
        done(options[index]);
      } else if (key.name === "escape") {
        done(null);
      } else if (key.ctrl && key.name === "c") {
        process.exit(130);
      }
    };
    process.stdin.on("keypress", onKey);
    process.stdout.write(`${question}\n`);
    options.forEach((o, i) => process.stdout.write(`    ${o.label}\n`));
  });
}

/** Numbered picker for piped/non-TTY stdin (also what tests drive). */
async function selectLines(question, options, defaultIndex) {
  console.log(question);
  options.forEach((o, i) => {
    const marker = i === defaultIndex ? ">" : " ";
    console.log(`  ${marker} ${i + 1}. ${o.label}`);
  });
  const answer = await nextLine();
  const n = parseInt(answer.trim(), 10);
  const idx = Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : defaultIndex;
  return options[idx];
}

/** Free-text prompt. Masked on a real TTY (for tokens); echoes otherwise. */
export function text(question, { defaultValue = "", mask = false } = {}) {
  if (mask && tty()) return maskedText(question);
  return textLines(question, defaultValue);
}

async function textLines(question, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  process.stdout.write(`${question}${suffix}: `);
  const answer = await nextLine();
  return answer.trim() === "" ? defaultValue : answer.trim();
}

/** Masked input (TTY only — caller checks tty()). */
function maskedText(question) {
  return new Promise((resolve) => {
    let value = "";
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(`${question}: `);
    const onKey = (str, key) => {
      if (key.name === "return" || key.name === "enter") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("keypress", onKey);
        process.stdout.write("\n");
        resolve(value);
      } else if (key.ctrl && key.name === "c") {
        process.exit(130);
      } else if (key.name === "backspace") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (key.name === "escape") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("keypress", onKey);
        process.stdout.write("\n");
        resolve(null);
      } else if (str) {
        value += str;
        process.stdout.write("*");
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

/** Yes/no prompt. */
export async function confirm(question, defaultValue = true) {
  const answer = await textLines(question, defaultValue ? "y" : "n");
  return /^y(es)?$/i.test(answer);
}

/** Run fn with an animated spinner line (TTY only; no-op otherwise). */
export async function withSpinner(message, fn) {
  if (!process.stdout.isTTY) return fn();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const id = setInterval(() => process.stdout.write(`\r${frames[i++ % frames.length]} ${message}`), 80);
  try {
    return await fn();
  } finally {
    clearInterval(id);
    process.stdout.write("\r\x1b[K");
  }
}
