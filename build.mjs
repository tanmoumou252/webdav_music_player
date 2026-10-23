import { LOCKED_NODE_VERSION, LOCKED_MAJOR } from "./runtime-lock.mjs";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const RECORD = process.argv.includes("--record");
const VERIFY_STAGED = process.argv.includes("--verify-staged");

if (RECORD && VERIFY_STAGED) {
  console.error("build: --record and --verify-staged are mutually exclusive — record rewrites the artifacts, verify-staged only audits a src-consistent state already on disk.");
  process.exit(2);
}

const partFiles = readdirSync(join(ROOT, "src"))
  .filter((f) => f.endsWith(".part.js"))
  .sort();

if (partFiles.length === 0) {
  console.error("build: no src/*.part.js found");
  process.exit(1);
}

const parts = partFiles.map((f) => readFileSync(join(ROOT, "src", f)));
const assembled = Buffer.concat(parts);

function firstDiffOffset(a, b) {
  const n = Math.min(a.length, b.length);
  let off = 0;
  while (off < n && a[off] === b[off]) off++;
  return off;
}

function reportDiff(assembledBuf, baselineBuf) {
  const off = firstDiffOffset(assembledBuf, baselineBuf);
  const lo = Math.max(0, off - 20);
  const hi = Math.min(assembledBuf.length, off + 20);
  const blo = Math.max(0, off - 20);
  const bhi = Math.min(baselineBuf.length, off + 20);
  return (
    `  first differing byte offset: ${off} (assembled ${assembledBuf.length} vs baseline ${baselineBuf.length})\n` +
    `  assembled[${lo}..${hi}] = ${assembledBuf.subarray(lo, hi).toString("hex")}\n` +
    `  baseline [${blo}..${bhi}] = ${baselineBuf.subarray(blo, bhi).toString("hex")}\n` +
    `  assembled around offset: ${JSON.stringify(assembledBuf.subarray(lo, hi).toString("utf8"))}\n` +
    `  baseline  around offset: ${JSON.stringify(baselineBuf.subarray(blo, bhi).toString("utf8"))}\n`
  );
}

let baseline = null;
try {
  baseline = execFileSync("git", ["show", "HEAD:worker.js"], {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
} catch (e) {
  if (!RECORD) {
    console.error(
      "build: cannot read the ratchet baseline — `git show HEAD:worker.js` failed.\n" +
        "  The byte-equality ratchet needs a git repository with worker.js committed.\n" +
        "  " + String((e && e.message) || e)
    );
    process.exit(1);
  }
  console.error("build: --record mode without a git baseline; the drift report will be unavailable.");
}

const cmp = baseline ? Buffer.compare(assembled, baseline) : -1;

if (baseline && cmp !== 0 && !RECORD && !VERIFY_STAGED) {
  console.error(
    "build: BYTE-EQUAL RATCHET RED — stitched output diverges from git show HEAD:worker.js\n" +
      reportDiff(assembled, baseline) +
      "  If the src/ change is intentional: run `node build.mjs --record` to advance the ratchet baseline,\n" +
      "  then commit worker.js + golden/worker.head.mjs + re-recorded test goldens together.\n" +
      "  Until that commit exists the Tier-4 HEAD comparison self-skips (see test/00); audit the staged state with `node build.mjs --verify-staged` before committing."
  );
  process.exit(1);
}

if (VERIFY_STAGED) {
  const workerPath = join(ROOT, "worker.js");
  const goldenAuditPath = join(ROOT, "golden", "worker.head.mjs");
  const builtAuditPath = join(ROOT, "build", "out", "worker.check.mjs");
  const auditIssues = [];
  try {
    const stagedSrc = execFileSync("git", ["ls-files", "--cached", "-z", "--", "src"], { cwd: ROOT })
      .toString("utf8").split("\u0000").filter((n) => n.endsWith(".part.js")).sort();
    const diskSrc = partFiles.map((n) => "src/" + n).sort();
    if (stagedSrc.join("\u0001") !== diskSrc.join("\u0001")) {
      auditIssues.push("the staged src/*.part.js set differs from the parts concatenated for this audit — git add the new/renamed parts");
    } else {
      for (const name of stagedSrc.concat(["worker.js", "golden/worker.head.mjs"])) {
        const expected = name.startsWith("src/") ? readFileSync(join(ROOT, name)) : assembled;
        const staged = execFileSync("git", ["show", ":" + name], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
        if (Buffer.compare(staged, expected) !== 0) auditIssues.push(name + " in the git index differs from the audited bytes — git add it before committing");
      }
    }
  } catch (e) {
    auditIssues.push("cannot audit the git index: " + String((e && e.message) || e));
  }
  const diskWorker = existsSync(workerPath) ? readFileSync(workerPath) : null;
  if (!diskWorker) auditIssues.push("worker.js is missing on disk");
  else if (Buffer.compare(diskWorker, assembled) !== 0) auditIssues.push("worker.js on disk diverges from the current src concat — stale: run `node build.mjs --record` first");
  const diskGolden = existsSync(goldenAuditPath) ? readFileSync(goldenAuditPath) : null;
  if (!diskGolden) auditIssues.push("golden/worker.head.mjs is missing");
  else if (Buffer.compare(diskGolden, assembled) !== 0) auditIssues.push("golden/worker.head.mjs diverges from the current src concat — stale: run `node build.mjs --record` first");
  const diskBuilt = existsSync(builtAuditPath) ? readFileSync(builtAuditPath) : null;
  if (!diskBuilt) auditIssues.push("build/out/worker.check.mjs is missing");
  else if (Buffer.compare(diskBuilt, assembled) !== 0) auditIssues.push("build/out/worker.check.mjs diverges from the current src concat — stale: run `node build.mjs --record` first");
  if (auditIssues.length > 0) {
    console.error("build: VERIFY-STAGED RED — the staged artifacts are NOT in sync with src/; this mode audits without writing, so repair the scene first:\n  - " + auditIssues.join("\n  - ") + "\n  Run `node build.mjs --record`, then the golden re-records, then `node build.mjs --verify-staged` again.");
    process.exit(1);
  }
  try {
    execFileSync(process.execPath, ["--check", builtAuditPath], { cwd: ROOT, stdio: "pipe" });
  } catch (e) {
    const auditSyntaxOut = String((e && e.stdout) || "") + String((e && e.stderr) || "");
    console.error("build: VERIFY-STAGED RED — build/out/worker.check.mjs fails `node --check`:\n" + auditSyntaxOut);
    process.exit(1);
  }
  console.log(`build: node ${process.versions.node} (major-locked ${LOCKED_MAJOR}, baseline ${LOCKED_NODE_VERSION})`);
  console.log(`build: VERIFY-STAGED — audited read-only: worker.js / golden/worker.head.mjs / build/out/worker.check.mjs are each byte-identical to the ${assembled.length}-byte src concat; syntax gate green; nothing was written.`);
  if (baseline && cmp === 0) {
    console.log("build: HEAD baseline is byte-equal as well — the staged state is commit-consistent.");
  } else {
    console.log("build:   node --test \"test/*.test.mjs\"   (Tier-4 HEAD comparison self-skips while src/worker.js/golden/worker.head.mjs drift pending commit; run `node build.mjs --verify-staged` before committing — that is the intended handoff)");
  }
  process.exit(0);
}

mkdirSync(join(ROOT, "build", "out"), { recursive: true });
writeFileSync(join(ROOT, "build", "out", "worker.check.mjs"), assembled);

try {
  execFileSync(process.execPath, ["--check", join(ROOT, "build", "out", "worker.check.mjs")], {
    cwd: ROOT,
    stdio: "pipe",
  });
} catch (e) {
  const out = String((e && e.stdout) || "") + String((e && e.stderr) || "");
  try {
    unlinkSync(join(ROOT, "build", "out", "worker.check.mjs"));
  } catch (cleanupErr) {}
  console.error("build: SYNTAX CHECK FAILED — nothing written through to worker.js / golden, and the broken build/out artifact was removed.\n" + out);
  process.exit(1);
}

const goldenPath = join(ROOT, "golden", "worker.head.mjs");
const goldenCurrent = existsSync(goldenPath) ? readFileSync(goldenPath) : null;
const goldenDesynced = !goldenCurrent || Buffer.compare(goldenCurrent, assembled) !== 0;

let wroteGolden = false;
if (RECORD && goldenDesynced) {
  mkdirSync(join(ROOT, "golden"), { recursive: true });
  writeFileSync(goldenPath, assembled);
  wroteGolden = true;
}

writeFileSync(join(ROOT, "worker.js"), assembled);

console.log(`build: node ${process.versions.node} (major-locked ${LOCKED_MAJOR}, baseline ${LOCKED_NODE_VERSION})`);
if (baseline && cmp === 0) {
  console.log(
    `build: ${partFiles.length} parts, ${assembled.length} bytes, byte-equal HEAD — worker.js rewritten (no-op), build/out/worker.check.mjs emitted`
  );
  if (goldenDesynced && !RECORD) {
    console.error("build: WARNING — golden/worker.head.mjs does not match the stitched output; run `node build.mjs --record` to repair it (Tier-4 tests 2/4 stay red until then).");
  }
} else if (baseline) {
  console.log(
    `build: RECORD MODE — artifacts rewritten from src/ (worker.js${wroteGolden ? ", golden/worker.head.mjs" : ""}, build/out/worker.check.mjs)`
  );
  console.log(`build: ${partFiles.length} parts, ${assembled.length} bytes, drift vs git show HEAD:worker.js`);
  console.log(reportDiff(assembled, baseline));
  console.log("build: strict mode reports drift until --record + commit; the test suite self-skips the HEAD comparison meanwhile, and --verify-staged audits the staged state before you commit.");
} else {
  console.log(
    `build: RECORD MODE (no git baseline) — ${partFiles.length} parts, ${assembled.length} bytes, artifacts rewritten from src/`
  );
}
