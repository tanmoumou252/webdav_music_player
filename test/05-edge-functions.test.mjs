import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const EO_PRELUDE = join(ROOT, "edgeone", "eo-prelude.js");
const EO_ENTRY = join(ROOT, "edgeone", "eo-entry.js");
const CF_ENTRY = join(ROOT, "edgeone", "cf-pages-entry.js");
const EDGE_ARTIFACTS = [
  ["edge-functions/index.js", "eo"],
  ["edge-functions/[[default]].js", "eo"],
  ["functions/[[path]].js", "cf"],
  ["functions/index.js", "cf"],
];

function assembleCoreParts() {
  const partNames = readdirSync(join(ROOT, "src"))
    .filter((f) => f.endsWith(".part.js") && f !== "08-entry.part.js")
    .sort();
  return partNames.map((f) => readFileSync(join(ROOT, "src", f)));
}

function assembleEdgeOne() {
  return Buffer.concat([readFileSync(EO_PRELUDE), ...assembleCoreParts(), readFileSync(EO_ENTRY)]);
}

function assembleCfPages() {
  return Buffer.concat([...assembleCoreParts(), readFileSync(CF_ENTRY)]);
}

test("edge artifact byte parity: the four tracked artifacts exist and are byte-identical to the src/edgeone concat", () => {
  for (const p of [EO_PRELUDE, EO_ENTRY, CF_ENTRY, ...EDGE_ARTIFACTS.map(([n]) => join(ROOT, n))]) {
    assert.ok(existsSync(p), "missing build input or artifact — run `node build.mjs --record` first: " + p);
  }
  const bytes = { eo: assembleEdgeOne(), cf: assembleCfPages() };
  for (const [name, kind] of EDGE_ARTIFACTS) {
    assert.ok(Buffer.compare(readFileSync(join(ROOT, name)), bytes[kind]) === 0, name + " diverges from the " + kind + " concat — stale: run `node build.mjs --record` first");
  }
});

test("edge artifact shape: eo entry is a function-form default export over handleRequest, cf-pages is a named onRequest", () => {
  const eo = assembleEdgeOne().toString("utf8");
  const cf = assembleCfPages().toString("utf8");
  assert.ok(eo.includes("async function handleRequest"), "eo artifact must carry the named handleRequest core");
  assert.ok(eo.includes("export default async function onRequest"), "eo artifact must use the documented function-form handler export");
  assert.ok(eo.includes("eoMangleKey") && eo.includes("eoWrapKV") && eo.includes("buildEnv"), "eo artifact must embed the adapter anchors");
  assert.ok(cf.includes("handleRequest") && cf.includes("export function onRequest"), "cf-pages artifact must export the named onRequest handler");
  assert.ok(!cf.includes("eoWrapKV"), "cf-pages artifact must not embed the edgeone kv adapter");
});

test("edge artifact syntax gate: node --check passes on the build probes", () => {
  for (const probe of ["eo.check.mjs", "cf-pages.check.mjs"]) {
    const p = join(ROOT, "build", "out", probe);
    assert.ok(existsSync(p), "missing build probe " + probe + " — run `node build.mjs` first");
    execFileSync(process.execPath, ["--check", p], { cwd: ROOT, stdio: "pipe" });
  }
});

function loadAdapterHandles() {
  const src = readFileSync(EO_PRELUDE, "utf8");
  const start = src.indexOf("function eoMangleKey");
  const end = src.indexOf("if (!(globalThis.fetch");
  assert.ok(start >= 0 && end > start, "adapter source region not found in edgeone/eo-prelude.js");
  const region = src.slice(start, end);
  return new Function(region + "\n;return { eoMangleKey: eoMangleKey, eoDemangleKey: eoDemangleKey, eoWrapKV: eoWrapKV };")();
}

function eoRawKvStub() {
  const store = new Map();
  const calls = { listArgs: [] };
  return {
    store,
    calls,
    async put(k, v) { store.set(k, v); },
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async delete(k) { store.delete(k); },
    async list(o) {
      calls.listArgs.push(o);
      const keys = [];
      for (const k of store.keys()) if (k.startsWith((o && o.prefix) || "")) keys.push({ key: k });
      return { keys, complete: true, cursor: null };
    },
  };
}

test("eo adapter key mangling: bijective round-trip incl. the literal _x2e_ counterexample, prefix homomorphism, 512B guard", () => {
  const A = loadAdapterHandles();
  const samples = ["rl_login_203.0.113.7", "cache_v3_list_%E6%AD%8C.mp3", "lock_sync_a%2Fb-c_d", "session_" + "f".repeat(64), "dav_sources", "_x2e_", "_x5f_", "a_b", "_%", "9.9.9.9", "2001:db8::1"];
  for (const k of samples) {
    const m = A.eoMangleKey(k);
    assert.ok(/^[A-Za-z0-9_]*$/.test(m), "mangled key must stay in the EO charset: " + m);
    assert.equal(A.eoDemangleKey(m), k, "round-trip must restore the original key: " + k);
  }
  assert.equal(A.eoMangleKey("_x2e_"), "_x5f_x2e_x5f_", "the literal counterexample must escape its own underscores");
  const prefix = "cache_v3_list_";
  assert.ok(A.eoMangleKey(prefix + "x").startsWith(A.eoMangleKey(prefix)), "prefix homomorphism keeps list({prefix}) semantics intact");
  assert.throws(() => A.eoMangleKey("a".repeat(513)), /EO KV key too long/, "over-length mangled keys must throw, never truncate");
});

test("eo adapter ttl envelope: put wraps {w,k,e,v}, expired reads null, e=0 never expires, plain values pass through verbatim", async () => {
  const A = loadAdapterHandles();
  const raw = eoRawKvStub();
  const kv = A.eoWrapKV(raw);
  const before = Date.now();
  await kv.put("rl_login_9.9.9.9", "3", { expirationTtl: 600 });
  assert.equal(raw.store.size, 1, "one raw entry after the first put");
  const [[storedKey, storedVal]] = [...raw.store.entries()];
  assert.equal(storedKey, A.eoMangleKey("rl_login_9.9.9.9"), "the raw key must be the mangled form");
  const envelope = JSON.parse(storedVal);
  assert.equal(envelope.w, 1, "envelope marker");
  assert.equal(envelope.k, storedKey, "envelope carries its own mangled key for self-check");
  assert.equal(envelope.v, "3", "envelope carries the string value");
  assert.ok(Math.abs(envelope.e - (before + 600000)) < 5000, "envelope expiry is now+ttl*1000");
  assert.equal(await kv.get("rl_login_9.9.9.9"), "3", "unexpired text read returns the value");
  raw.store.set(storedKey, JSON.stringify({ w: 1, k: storedKey, e: Date.now() - 1, v: "9" }));
  assert.equal(await kv.get("rl_login_9.9.9.9"), null, "expired envelope reads as missing");
  assert.equal(raw.store.has(storedKey), false, "an expired envelope entry is best-effort deleted from the raw KV, not left to leak quota");
  const failingRaw = eoRawKvStub();
  const failingKv = A.eoWrapKV(failingRaw);
  const failKey = A.eoMangleKey("rl_login_5.6.7.8");
  failingRaw.store.set(failKey, JSON.stringify({ w: 1, k: failKey, e: Date.now() - 1, v: "9" }));
  failingRaw.delete = async () => { throw new Error("delete down"); };
  assert.equal(await failingKv.get("rl_login_5.6.7.8"), null, "a failing expiry delete must not change the read: still null");
  raw.store.set(storedKey, JSON.stringify({ w: 1, k: storedKey, e: 0, v: "5" }));
  assert.equal(await kv.get("rl_login_9.9.9.9"), "5", "e=0 never expires");
});

test("eo adapter plain-value fallback: console-written values are returned verbatim, self-check mismatch degrades to plain, broken json reads null", async () => {
  const A = loadAdapterHandles();
  const raw = eoRawKvStub();
  const kv = A.eoWrapKV(raw);
  raw.store.set(A.eoMangleKey("dav_sources"), JSON.stringify([{ id: "a", name: "A" }]));
  assert.deepEqual(await kv.get("dav_sources", { type: "json" }), [{ id: "a", name: "A" }], "console-written json value parses via the plain path");
  assert.equal(await kv.get("dav_sources"), JSON.stringify([{ id: "a", name: "A" }]), "plain text read returns the raw stored string");
  raw.store.set(A.eoMangleKey("site_title"), JSON.stringify({ w: 1, k: "mismatch", e: 0, v: "x" }));
  assert.equal(await kv.get("site_title"), JSON.stringify({ w: 1, k: "mismatch", e: 0, v: "x" }), "a key-mismatched envelope degrades to a plain value, never null");
  raw.store.set(A.eoMangleKey("admin_pass"), "not-json{");
  assert.equal(await kv.get("admin_pass", "json"), null, "broken json on the plain path reads null (kv stub parity), never throws");
  raw.store.set(A.eoMangleKey("cache_v3_list_all"), JSON.stringify({ w: 1, k: A.eoMangleKey("cache_v3_list_all"), e: 0, v: "not-json{" }));
  assert.equal(await kv.get("cache_v3_list_all", "json"), null, "broken json inside an envelope reads null, never throws");
  assert.equal(await kv.get("missing_key"), null, "absent key reads null");
  assert.equal(await kv.get("missing_key", "json"), null, "absent key reads null in json form too");
});

test("eo adapter get argument forms and delete/list mapping", async () => {
  const A = loadAdapterHandles();
  const raw = eoRawKvStub();
  const kv = A.eoWrapKV(raw);
  raw.store.set(A.eoMangleKey("dav_sources"), JSON.stringify([1, 2]));
  assert.deepEqual(await kv.get("dav_sources"), "[1,2]", "no-option read is text");
  assert.deepEqual(await kv.get("dav_sources", "json"), [1, 2], "string shorthand json read");
  assert.deepEqual(await kv.get("dav_sources", { type: "json" }), [1, 2], "object form json read");
  raw.store.set(A.eoMangleKey("session_a"), "1");
  raw.store.set(A.eoMangleKey("session_b"), "2");
  raw.store.set(A.eoMangleKey("rl_login_x"), "3");
  const listed = await kv.list({ prefix: "session_" });
  assert.deepEqual(listed.keys.map((k) => k.name).sort(), ["session_a", "session_b"], "list maps EO ListKey.key to CF name and demangles");
  assert.equal(listed.list_complete, true, "complete maps to list_complete");
  assert.equal(listed.cursor, undefined, "null cursor maps to undefined");
  assert.equal(raw.calls.listArgs[0].prefix, A.eoMangleKey("session_"), "the prefix handed to the raw KV must be the mangled form");
  await kv.delete("session_a");
  assert.equal(raw.store.has(A.eoMangleKey("session_a")), false, "delete removes the mangled raw entry exactly once (no double mangle)");
});

function evalFetchGuard() {
  const src = readFileSync(EO_PRELUDE, "utf8");
  const start = src.indexOf("if (!(globalThis.fetch");
  const end = src.indexOf("function buildEnv");
  assert.ok(start >= 0 && end > start, "fetch guard region not found in edgeone/eo-prelude.js");
  new Function(src.slice(start, end))();
}

test("eo adapter list: a string cursor is forwarded verbatim and the raw cursor is surfaced for the next page", async () => {
  const A = loadAdapterHandles();
  const seen = [];
  const raw = {
    async put() {},
    async get() { return null; },
    async delete() {},
    async list(o) { seen.push(o); return { keys: [{ key: "session_xbb" }], complete: false, cursor: "opaque-next" }; },
  };
  const kv = A.eoWrapKV(raw);
  const out = await kv.list({ prefix: "session_", cursor: "opaque-prev" });
  assert.equal(seen[0].cursor, "opaque-prev", "the consumer cursor is forwarded to the raw KV verbatim (never mangled)");
  assert.equal(seen[0].prefix, A.eoMangleKey("session_"), "prefix mangling unchanged on the cursor path");
  assert.equal(out.cursor, "opaque-next", "the raw cursor is surfaced so callers can page until list_complete");
  assert.equal(out.list_complete, false, "complete maps through unchanged");
});

test("eo fetch wrapper: an aborting signal rejects the race with name AbortError even when the native fetch never settles", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    evalFetchGuard();
    const ac = new AbortController();
    const p = globalThis.fetch("https://upstream.example.com/x", { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await assert.rejects(p, (e) => e && e.name === "AbortError", "the wrapper must surface AbortError, not a hang");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("eo fetch wrapper: a late native rejection after the abort won the race raises no unhandledRejection", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((_, rej) => setTimeout(() => rej(new Error("late native failure")), 30));
  const recorded = [];
  const onUnhandled = (r) => recorded.push(r);
  process.on("unhandledRejection", onUnhandled);
  try {
    evalFetchGuard();
    const ac = new AbortController();
    const p = globalThis.fetch("https://upstream.example.com/x", { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await assert.rejects(p, (e) => e && e.name === "AbortError");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(recorded.length, 0, "the swallowed late rejection must never surface as unhandledRejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    globalThis.fetch = prevFetch;
  }
});

test("eo fetch wrapper: the guard is idempotent — a second evaluation never nests wrappers", () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    evalFetchGuard();
    const once = globalThis.fetch;
    assert.ok(once.__eoWrapped === true, "the first evaluation marks the wrapper");
    evalFetchGuard();
    assert.equal(globalThis.fetch, once, "the second evaluation must skip re-wrapping");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("eo fetch wrapper: a settled wrapped call detaches its abort listener and a later abort is a silent no-op", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => setTimeout(() => resolve(new Response("ok")), 10));
  const recorded = [];
  const onUnhandled = (r) => recorded.push(r);
  process.on("unhandledRejection", onUnhandled);
  try {
    evalFetchGuard();
    const ac = new AbortController();
    const res = await globalThis.fetch("https://upstream.example.com/x", { signal: ac.signal });
    assert.equal(await res.text(), "ok", "the wrapped call settles with the native response");
    ac.abort();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(recorded.length, 0, "a post-settlement abort must stay a silent no-op");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    globalThis.fetch = prevFetch;
  }
});

test("edge artifact smoke: the eo entry serves the html page end-to-end through buildEnv + the kv adapter, zero network", async () => {
  const prevFetch = globalThis.fetch;
  const prevKv = globalThis.MUSIC_KV;
  let fetchCalled = false;
  globalThis.fetch = () => { fetchCalled = true; throw new Error("network must never be touched by the root-page path"); };
  globalThis.MUSIC_KV = eoRawKvStub();
  try {
    const mod = await import(new URL("../build/out/eo.check.mjs", import.meta.url).href);
    assert.equal(typeof mod.default, "function", "the function-form default export is the handler itself");
    const res = await mod.default({ request: new Request("https://app.example.com/"), env: {} });
    assert.equal(fetchCalled, false, "the root html path must not issue any upstream fetch");
    assert.equal(res.status, 200);
    assert.ok(String(res.headers.get("content-type") || "").includes("text/html"));
    const body = await res.text();
    assert.ok(body.includes("<html"), "the root page must be the html template");
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.MUSIC_KV = prevKv;
  }
});
