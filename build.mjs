import { LOCKED_NODE_VERSION, LOCKED_MAJOR } from "./runtime-lock.mjs";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

const partFiles = readdirSync(join(ROOT, "src"))
  .filter((f) => f.endsWith(".part.js"))
  .sort();

if (partFiles.length === 0) {
  console.error("build: no src/*.part.js found");
  process.exit(1);
}

const parts = partFiles.map((f) => readFileSync(join(ROOT, "src", f)));
const assembled = Buffer.concat(parts);

const baseline = execFileSync("git", ["show", "HEAD:worker.js"], {
  cwd: ROOT,
  maxBuffer: 16 * 1024 * 1024,
});

const cmp = Buffer.compare(assembled, baseline);
if (cmp !== 0) {
  let off = 0;
  const n = Math.min(assembled.length, baseline.length);
  while (off < n && assembled[off] === baseline[off]) off++;
  const lo = Math.max(0, off - 20);
  const hi = Math.min(assembled.length, off + 20);
  const blo = Math.max(0, off - 20);
  const bhi = Math.min(baseline.length, off + 20);
  console.error(
    "build: BYTE-EQUAL RATCHET RED — stitched output diverges from git show HEAD:worker.js\n" +
      `  first differing byte offset: ${off} (assembled ${assembled.length} vs baseline ${baseline.length})\n` +
      `  assembled[${lo}..${hi}] = ${assembled.subarray(lo, hi).toString("hex")}\n` +
      `  baseline [${blo}..${bhi}] = ${baseline.subarray(blo, bhi).toString("hex")}\n` +
      `  assembled around offset: ${JSON.stringify(assembled.subarray(lo, hi).toString("utf8"))}\n` +
      `  baseline  around offset: ${JSON.stringify(baseline.subarray(blo, bhi).toString("utf8"))}\n` +
      "  If the src/ change is intentional: update golden/worker.head.mjs (and re-record goldens) in the same commit."
  );
  process.exit(1);
}

writeFileSync(join(ROOT, "worker.js"), assembled);
mkdirSync(join(ROOT, "build", "out"), { recursive: true });
writeFileSync(join(ROOT, "build", "out", "worker.check.mjs"), assembled);

console.log(`build: node ${process.versions.node} (major-locked ${LOCKED_MAJOR}, baseline ${LOCKED_NODE_VERSION})`);
console.log(`build: ${partFiles.length} parts, ${assembled.length} bytes, byte-equal HEAD — worker.js rewritten (no-op), build/out/worker.check.mjs emitted`);