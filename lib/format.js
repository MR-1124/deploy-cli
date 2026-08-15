// Terminal output helpers. Colors are disabled when stdout is not a TTY or
// NO_COLOR is set; OSC 8 links only render in supporting terminals.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const isTTY = process.stdout.isTTY;

export function paint(code, s) {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}
export const green = (s) => paint("32", s);
export const red = (s) => paint("31", s);
export const yellow = (s) => paint("33", s);
export const dim = (s) => paint("2", s);
export const bold = (s) => paint("1", s);

/** Render a clickable terminal link (falls back to the label). */
export function link(url, label = url) {
  return isTTY ? `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\` : label;
}

export function ok(msg) {
  console.log(`${green("✔")} ${msg}`);
}

export function warn(msg) {
  console.log(`${yellow("⚠")} ${msg}`);
}

export function fail(msg) {
  console.error(`${red("✖")} ${msg}`);
}

/** Inline progress line (TTY only; no-op otherwise). */
export function progress(prefix, done, total) {
  if (!isTTY) return;
  process.stdout.write(`\r${dim(prefix)} ${done}/${total}`);
  if (done >= total) process.stdout.write("\n");
}

/** Aligned column table from an array of rows + header. */
export function table(header, rows) {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  const fmt = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  console.log(dim(fmt(header)));
  for (const row of rows) console.log(fmt(row));
}

export function section(title) {
  console.log(`\n${bold(title)}`);
}
