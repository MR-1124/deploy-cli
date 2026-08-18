// Tests for the smoke-artifact cleanup script's name matching — the safety
// boundary: only auto-generated smoke-<timestamp> names may ever be deleted.
import assert from "node:assert";
import { isSmokeName } from "../scripts/cleanup-smoke.mjs";

// auto-generated names match
assert.equal(isSmokeName("smoke-1786791622246"), true);
assert.equal(isSmokeName("smoke-1786791629289"), true);

// pinned / custom / malformed names never match
assert.equal(isSmokeName("smoke-mayan-roys-projects"), false, "pinned vercel project must not match");
assert.equal(isSmokeName("smoke-sample-site"), false);
assert.equal(isSmokeName("my-site"), false);
assert.equal(isSmokeName("smoke-"), false);
assert.equal(isSmokeName("smoke-123"), false, "too few digits");
assert.equal(isSmokeName("Smoke-1786791622246"), false, "case-sensitive");
assert.equal(isSmokeName("smoke-1786791622246-extra"), false);
assert.equal(isSmokeName(""), false);
assert.equal(isSmokeName(null), false);

console.log("✔ all tests passed (cleanup smoke-name matching)");
