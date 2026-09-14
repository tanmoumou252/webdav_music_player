import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { scenarios, runOne } from "./helper/scenarios.mjs";
import { comparable } from "./helper/harness.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function importWorker(spec) {
  const url = new URL(spec, import.meta.url).href;
  return (await import(url)).default;
}

test("Tier-4 byte parity: src parts concat == git HEAD worker.js", () => {
  const partFiles = readdirSync(join(ROOT, "src"))
    .filter((f) => f.endsWith(".part.js"))
    .sort();
  assert.equal(partFiles.length, 7, "expected 7 parts");
  const stitched = Buffer.concat(partFiles.map((f) => readFileSync(join(ROOT, "src", f))));
  const head = execFileSync("git", ["show", "HEAD:worker.js"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(stitched.length, head.length, "byte length drift");
  assert.ok(Buffer.compare(stitched, head) === 0, "stitched src bytes diverge from HEAD:worker.js");
});

test("Tier-4 byte parity: src parts concat == golden/worker.head.mjs", () => {
  const partFiles = readdirSync(join(ROOT, "src"))
    .filter((f) => f.endsWith(".part.js"))
    .sort();
  const stitched = Buffer.concat(partFiles.map((f) => readFileSync(join(ROOT, "src", f))));
  const golden = readFileSync(join(ROOT, "golden", "worker.head.mjs"));
  assert.ok(Buffer.compare(stitched, golden) === 0, "stitched src bytes diverge from golden");
});

test("Tier-4 byte parity: build artifact == golden (build/out present)", () => {
  const out = join(ROOT, "build", "out", "worker.check.mjs");
  assert.ok(existsSync(out), "run `node build.mjs` before the parity tier");
  const built = readFileSync(out);
  const golden = readFileSync(join(ROOT, "golden", "worker.head.mjs"));
  assert.ok(Buffer.compare(built, golden) === 0, "build artifact diverges from golden");
});

test("Tier-4 byte parity: deployed worker.js == golden", () => {
  const worker = readFileSync(join(ROOT, "worker.js"));
  const golden = readFileSync(join(ROOT, "golden", "worker.head.mjs"));
  assert.ok(Buffer.compare(worker, golden) === 0, "worker.js on disk diverges from golden (rebuild or revert)");
});

test("Tier-4 semantic parity: baseline vs stitched, all scenarios", async () => {
  const base = await importWorker("../golden/worker.head.mjs");
  const built = await importWorker("../build/out/worker.check.mjs");
  for (const s of scenarios()) {
    const a = await comparable(await runOne(s, base));
    const b = await comparable(await runOne(s, built));
    assert.deepEqual(b, a, "semantic drift on scenario: " + s.name);
  }
});
