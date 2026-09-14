import { readFileSync } from "node:fs";

const LOCKED = readFileSync(new URL("./.node-version", import.meta.url), "utf8").trim();
const CURRENT = process.versions.node;

const MAJOR = /^(\d+)/;
export const LOCKED_NODE_VERSION = LOCKED;
export const LOCKED_MAJOR = (LOCKED.match(MAJOR) || [])[1];
const currentMajor = (CURRENT.match(MAJOR) || [])[1];

if (!LOCKED_MAJOR || currentMajor !== LOCKED_MAJOR) {
  throw new Error(
    "runtime-lock: Node.js major version mismatch\n" +
      `  current:  ${CURRENT}\n` +
      `  baseline: ${LOCKED}\n` +
      `  locked major: ${LOCKED_MAJOR || "?"}\n` +
      "  Only the MAJOR version is enforced; any release within the same major line runs the same gates.\n" +
      "  To move to a new major line:\n" +
      "    1. Install the target runtime, then update .node-version and .nvmrc to it.\n" +
      "    2. Run: node build.mjs, then node --test \"test/*.test.mjs\" on the target runtime.\n" +
      "    3. If Tier-2/Tier-3 goldens fail, this is real runtime-semantics drift: re-record golden/worker.head.mjs records and sha256, verify diffs are expected, and commit them together with the lock files."
  );
}
