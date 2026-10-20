import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { scenarios, runOne } from "../helper/scenarios.mjs";
import { comparable } from "../helper/harness.mjs";
import { loadParts } from "../helper/load-parts.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUILT = join(ROOT, "build", "out", "worker.check.mjs");
const GOLDEN_JSON = join(ROOT, "test", "golden", "handler-scenarios.json");
const SNAPSHOT = join(ROOT, "test", "03-render-snapshot.test.mjs");

// Parse a golden baseline from raw text. A baseline must be a JSON object
// mapping scenario names to records; a top-level array / scalar / null is a
// corrupted or wrong-shaped file and must be rejected rather than silently
// treated as "no previous records" (which would let a re-record overwrite the
// baseline with every scenario flagged as added). A key named "__proto__" is
// rejected as a defensive measure: JSON.parse installs it as an OWN data
// property (Object.getPrototypeOf still returns Object.prototype, so a
// prototype-identity check would NOT catch it), and letting a baseline define
// that key invites prototype-shadowing confusion. Throws on any invalid shape.
export function parseGoldenRecord(raw) {
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const shape = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    throw new Error("top-level value is " + shape + ", expected an object mapping of scenario records");
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
    throw new Error('golden baseline defines an own "__proto__" key — refusing a prototype-shadowing baseline');
  }
  for (const [name, rec] of Object.entries(parsed)) {
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
      const shape = rec === null ? "null" : Array.isArray(rec) ? "an array" : typeof rec;
      throw new Error("scenario record \"" + name + "\" is " + shape + ", expected an object record — refusing a partially corrupted baseline");
    }
  }
  return parsed;
}

function readGolden() {
  if (!existsSync(GOLDEN_JSON)) return {};
  let raw;
  try {
    raw = readFileSync(GOLDEN_JSON, "utf8");
  } catch (e) {
    console.error("record: cannot read " + GOLDEN_JSON + " — " + String((e && e.message) || e));
    process.exit(1);
  }
  try {
    return parseGoldenRecord(raw);
  } catch (e) {
    console.error("record: " + GOLDEN_JSON + " is not a usable golden baseline (" + String((e && e.message) || e) + ") — refusing to record over a corrupted baseline; inspect or restore the file first.");
    process.exit(1);
  }
}

function assertFreshBuild() {
  if (!existsSync(BUILT)) {
    console.error("record: build/out/worker.check.mjs is missing — run `node build.mjs --record` first");
    process.exit(1);
  }
  try {
    execFileSync(process.execPath, ["--check", BUILT], { cwd: ROOT, stdio: "pipe" });
  } catch (e) {
    const out = String((e && e.stdout) || "") + String((e && e.stderr) || "");
    console.error("record: build/out/worker.check.mjs fails `node --check` — refusing to record from a broken artifact.\n" + out);
    process.exit(1);
  }
  const partFiles = readdirSync(join(ROOT, "src"))
    .filter((f) => f.endsWith(".part.js"))
    .sort();
  const stitched = Buffer.concat(partFiles.map((f) => readFileSync(join(ROOT, "src", f))));
  const built = readFileSync(BUILT);
  if (Buffer.compare(stitched, built) !== 0) {
    console.error("record: build/out/worker.check.mjs is not byte-identical to the concatenation of the current src/*.part.js — run `node build.mjs --record` again");
    process.exit(1);
  }
}

function shape(rec) {
  return {
    status: rec.status,
    statusText: rec.statusText,
    headers: rec.headers,
    body: rec.body,
    stubCalls: rec.stubCalls,
    post: rec.post,
  };
}

async function loadBuiltWorker() {
  return (await import(new URL("../../build/out/worker.check.mjs", import.meta.url).href)).default;
}

function replaceOnce(text, re, replacement, label) {
  if (!re.test(text)) {
    console.error("record: cannot locate " + label + " in test/03-render-snapshot.test.mjs");
    process.exit(1);
  }
  return text.replace(re, replacement);
}

async function recordHandler() {
  assertFreshBuild();
  const worker = await loadBuiltWorker();
  const previous = readGolden();
  const out = {};
  const changes = [];
  for (const s of scenarios()) {
    const rec = shape(await comparable(await runOne(s, worker)));
    out[s.name] = rec;
    const before = previous[s.name];
    if (!before) changes.push("added: " + s.name);
    else if (JSON.stringify(before) !== JSON.stringify(rec)) changes.push("changed: " + s.name);
  }
  for (const name of Object.keys(previous)) {
    if (!Object.prototype.hasOwnProperty.call(out, name)) changes.push("removed: " + name);
  }
  mkdirSync(dirname(GOLDEN_JSON), { recursive: true });
  writeFileSync(GOLDEN_JSON, JSON.stringify(out, null, 2) + "\n");
  console.log("record: wrote test/golden/handler-scenarios.json (" + Object.keys(out).length + " scenarios)");
  if (changes.length === 0) {
    console.log("record: no record changed (byte-identical re-record)");
  } else {
    for (const c of changes) console.log("record: " + c);
  }
  console.log("record: review `git diff test/golden/handler-scenarios.json` now — every changed record must be an intended behavior change.");
}

function recordRender() {
  assertFreshBuild();
  const { renderHTML } = loadParts();
  const html = renderHTML();
  const sha = createHash("sha256").update(html, "utf8").digest("hex");
  const len = html.length;
  const src = readFileSync(SNAPSHOT, "utf8");
  const prevSha = (/const GOLDEN_SHA256 = "([0-9a-f]{64})";/.exec(src) || [])[1];
  const prevLen = (/const GOLDEN_LENGTH = (\d+);/.exec(src) || [])[1];
  let next = replaceOnce(src, /const GOLDEN_SHA256 = "[0-9a-f]{64}";/, 'const GOLDEN_SHA256 = "' + sha + '";', "GOLDEN_SHA256");
  next = replaceOnce(next, /const GOLDEN_LENGTH = \d+;/, "const GOLDEN_LENGTH = " + len + ";", "GOLDEN_LENGTH");
  writeFileSync(SNAPSHOT, next);
  console.log("record: test/03-render-snapshot.test.mjs");
  console.log("  GOLDEN_LENGTH " + prevLen + " -> " + len);
  console.log("  GOLDEN_SHA256 " + prevSha + " -> " + sha);
  console.log("record: review `git diff test/03-render-snapshot.test.mjs` now — the byte diff must be a re-record, not a hand edit.");
}

// Run the CLI only when this file is the process entry point. Compare the
// realpath of the entry file with this module's realpath so symlink, drive-letter
// case and path-normalization differences resolve to the same on-disk file.
// If either realpath fails to resolve, stay non-entry (never run the CLI) so a
// differently-named copy importing this module cannot trigger a record overwrite.
function invokedAsEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedAsEntryPoint()) {
  const mode = process.argv[2];
  if (mode !== "handler" && mode !== "render") {
    console.error("usage: node test/tools/record.mjs <handler|render>");
    console.error("  handler — rerun the scenario matrix against build/out/worker.check.mjs and rewrite test/golden/handler-scenarios.json");
    console.error("  render  — rewrite the renderHTML snapshot sha256/length constants in test/03-render-snapshot.test.mjs");
    console.error("No default mode on purpose: recording a golden is always an explicit, reviewable act.");
    process.exit(1);
  }
  if (mode === "handler") {
    await recordHandler();
  } else {
    recordRender();
  }
}
