// CLI argument parsing, extracted so it can be unit-tested directly.

const VALUE_FLAGS = new Set([
  "project",
  "dir",
  "server",
  "token",
  "port",
  "storage",
  "branch",
  "provider",
  "site",
  "team",
  "method",
  "account",
  "bucket",
  "region",
  "accessKey",
  "secretKey",
  "prefix",
  "timeout",
  "shell",
]);

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * Parse argv into { flags, args }.
 *   --flag          → flags.flag = true
 *   --flag=value    → flags.flag = "value"
 *   --flag value    → flags.flag = "value" (only for known value flags)
 *   positional args → args[]
 * Kebab-case flags are normalized to camelCase (--no-build → noBuild).
 */
export function parseArgs(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const rawKey = eq !== -1 ? a.slice(2, eq) : a.slice(2);
      const key = camel(rawKey);
      if (eq !== -1) flags[key] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      args.push(a);
    }
  }
  return { flags, args };
}
