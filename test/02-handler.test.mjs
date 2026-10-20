import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { scenarios, runOne, scenarioNamed, contains, bodyJson } from "./helper/scenarios.mjs";
import { comparable, makeRequest, FROZEN_NOW } from "./helper/harness.mjs";
import { createKV } from "./helper/kv.mjs";
import worker from "../build/out/worker.check.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as F from "./helper/fixtures.mjs";

// Tier-2 全路由特征化测试：golden 外置到 test/golden/handler-scenarios.json。
// import 目标为构建产物 build/out/worker.check.mjs，仍绿即证明切片与拼接零行为回归。
export const GOLDEN = JSON.parse(
  readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "golden", "handler-scenarios.json"), "utf8")
);

for (const s of scenarios()) {
  test("handler:" + s.name, async () => {
    const rec = await comparable(await runOne(s, worker));
    assert.deepEqual(rec, GOLDEN[s.name], "scenario " + s.name);
  });
}

test("share head: a throwing MUSIC_KV is swallowed fail-closed AND logged", async () => {
  const req = makeRequest({ method: "GET", url: PAGE_URL + "/?play=a1b2c3d4" });
  const boomEnv = { MUSIC_KV: { get: async () => { throw new Error("kv-down"); } } };
  let logged = null;
  const orig = console.error;
  console.error = (...a) => { logged = a; };
  let res;
  let err;
  try {
    res = await worker.fetch(req, boomEnv);
  } catch (e) {
    err = e;
  } finally {
    console.error = orig;
  }
  assert.equal(err, undefined, "a KV fault must not escape the page render");
  assert.equal(res.status, 200, "a KV fault falls back to the generic card, never a 500");
  assert.ok(logged !== null, "the swallowed fault must be logged (silent under an empty catch)");
});

test("coverage: golden records and scenarios are in exact 1:1 correspondence", () => {
  const names = scenarios().map((s) => s.name);
  for (const name of names) {
    assert.ok(Object.prototype.hasOwnProperty.call(GOLDEN, name), "missing golden for " + name);
  }
  for (const name of Object.keys(GOLDEN)) {
    assert.ok(names.includes(name), "stale golden record with no scenario: " + name);
  }
  assert.equal(Object.keys(GOLDEN).length, names.length, "record/scenario count drift");
});

const PAGE_URL = "https://app.example.com";

test("share head: song variant injects raster og:image, restores description and swaps <title>", async () => {
  const rec = await runOne(scenarioNamed("play-hit"), worker);
  assert.ok(rec.body.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'));
  assert.ok(rec.body.includes('<meta name="twitter:image" content="https://app.example.com/og-icon.png">'));
  assert.ok(rec.body.includes('<meta name="twitter:card" content="summary">'));
  assert.ok(rec.body.includes('<meta property="og:title" content="Artist - Title | 分享站">'));
  assert.ok(rec.body.includes('<meta property="og:description" content="Artist - Title · 分享站">'), "song card restores description");
  assert.ok(rec.body.includes('<meta property="og:url" content="https://app.example.com/?play=a1b2c3d4">'));
  assert.ok(rec.body.includes("<title>Artist - Title | 分享站</title>"));
  assert.ok(!rec.body.includes("<!--SHARE_HEAD-->"), "injection anchor must be consumed");
  assert.ok(!rec.body.includes("<title>Cloud Music Hub</title>"), "default title must be replaced for a resolved song");
});

test("share head: durable index resolves the song after the list cache is gone", async () => {
  const rec = await runOne(scenarioNamed("play-hit-index-fallback"), worker);
  assert.ok(rec.body.includes("<title>Artist - Title | 分享站</title>"));
  assert.ok(rec.body.includes('<meta property="og:type" content="music.song">'));
});

test("share head: unresolved id degrades to the generic website card", async () => {
  const rec = await runOne(scenarioNamed("play-miss-no-index"), worker);
  assert.ok(rec.body.includes('<meta property="og:type" content="website">'));
  assert.ok(rec.body.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'));
  assert.ok(rec.body.includes('<meta property="og:url" content="https://app.example.com/">'));
  assert.ok(rec.body.includes("<title>Cloud Music Hub</title>"), "generic card must keep the default title");
});

test("share head: hostile stored name is entity-escaped, never raw markup", async () => {
  const rec = await runOne(scenarioNamed("play-hit-xss"), worker);
  assert.ok(rec.body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(rec.body.includes("&quot;Quote&quot;"));
  assert.ok(!rec.body.includes("<script>alert(1)</script>"));
});

test("share head: every html page carries an absolute og image", async () => {
  const rec = await runOne(scenarioNamed("html-root"), worker);
  assert.ok(rec.body.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'));
  assert.ok(!rec.body.includes("<!--SHARE_HEAD-->"));
});

test("share head: a rejecting site_title read degrades to the generic card, never 500", async () => {
  const env = {
    MUSIC_KV: {
      get: async (key) => {
        if (key === "site_title") throw new Error("kv unavailable");
        return null;
      },
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [] }),
    },
  };
  const res = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/" }), env);
  assert.equal(res.status, 200, "a metadata read failure must never take the page down");
  const body = await res.text();
  assert.ok(body.includes('<meta property="og:type" content="website">'));
  assert.ok(body.includes('<meta property="og:title" content="Cloud Music Hub">'));
  assert.ok(body.includes("<title>Cloud Music Hub</title>"));
  assert.ok(!body.includes("<!--SHARE_HEAD-->"));
});

test("og icon routes: png bytes are byte-identical on /og-icon.png and /favicon.ico", async () => {
  const env = { MUSIC_KV: createKV({}) };
  const png = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/og-icon.png" }), env);
  const ico = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/favicon.ico" }), env);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.equal(png.headers.get("cache-control"), "public, max-age=604800");
  const pngBytes = Buffer.from(await png.arrayBuffer());
  const icoBytes = Buffer.from(await ico.arrayBuffer());
  assert.equal(pngBytes.length, 3413);
  assert.ok(pngBytes.equals(icoBytes));
  assert.equal(
    createHash("sha256").update(pngBytes).digest("hex"),
    "3cdfb30483b96f7e9d9bdf59aee66a1723f2a446a8014de12b95f64564ae426d"
  );
});

test("share head: the v and id query entries drive the same resolved song card as play", async () => {
  const byV = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/?v=a1b2c3d4" }), { MUSIC_KV: createKV({ site_title: "分享站", cache_v3_list_all: JSON.stringify({ items: [{ id: "a1b2c3d4", name: "Artist - Title.mp3" }] }) }) });
  const bodyV = await byV.text();
  assert.ok(bodyV.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'), "?v= must resolve the song and advertise the raster image");
  assert.ok(bodyV.includes('<meta name="twitter:card" content="summary">'));
  const byId = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/?id=a1b2c3d4" }), { MUSIC_KV: createKV({ site_title: "分享站", cache_v3_list_all: JSON.stringify({ items: [{ id: "a1b2c3d4", name: "Artist - Title.mp3" }] }) }) });
  const bodyId = await byId.text();
  assert.ok(bodyId.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'), "?id= must resolve the song and advertise the raster image");
});

test("share head: song page with play id serves the raster social image and restored description", async () => {
  const rec = await runOne(scenarioNamed("play-hit"), worker);
  assert.ok(rec.body.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'));
  assert.ok(rec.body.includes('<meta name="twitter:card" content="summary">'));
  assert.ok(rec.body.includes('<meta property="og:description" content="Artist - Title · 分享站">'), "song page restores description");
  assert.ok(rec.body.includes('<meta property="og:site_name" content="分享站">'), "song page restores site name");
  assert.ok(rec.body.includes('<meta name="description" content="Artist'), "song page restores the non-og description tag");
  assert.ok(rec.body.includes('<meta property="og:title" content="Artist - Title | 分享站">'), "song og:title keeps the brand suffix");
  assert.ok(rec.body.includes("<title>Artist - Title | 分享站</title>"), "document title contract unchanged");
});

test("og icon route: /icon.svg serves the vector twin", async () => {
  const env = { MUSIC_KV: createKV({}) };
  const res = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/icon.svg" }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  const text = await res.text();
  assert.ok(text.includes("#1ed760"));
  assert.ok(text.includes("M12 3v10.55c"));
});

test("share index: per-source snapshot never clobbers another source's key", async () => {
  const rec = await runOne(scenarioNamed("list-source-index-isolation"), worker);
  assert.ok(Array.isArray(rec.post.indexA) && rec.post.indexA.length > 0, "source a's own key must be written");
  assert.deepEqual(rec.post.indexB, [["beefbeef", "Untouched - ByB.mp3"]], "source b's key must be untouched byte-for-byte");
});

test("stream: an honest upstream 416 is passed through, never replaced by a JSON body", async () => {
  const rec = await runOne(scenarioNamed("stream-upstream-416-passthrough"), worker);
  assert.equal(rec.status, 416);
  assert.equal(rec.headers["content-range"], "bytes */500");
  assert.equal(rec.headers["content-type"], undefined, "no JSON diagnostic body may be attached");
  assert.equal(rec.headers["content-length"], undefined);
  assert.equal(rec.headers["accept-ranges"], undefined);
  assert.equal(rec.body, "");
});

test("scenario text helpers reject summarized body objects with actionable errors", () => {
  const binary = { name: "og-icon-png", body: { binLen: 5753, sha256: "abc" } };
  const html = { name: "html-root", body: { htmlLen: 100, sha256: "def" } };
  assert.throws(() => contains(binary, "PNG"), /contains\(\): expected a string body.*binary digest/);
  assert.throws(() => bodyJson(binary), /bodyJson\(\): expected a string body.*binary digest/);
  assert.throws(() => contains(html, "<html>"), /contains\(\): expected a string body.*html digest/);
  assert.throws(() => bodyJson(html), /bodyJson\(\): expected a string body.*html digest/);
  assert.equal(contains({ name: "plain", body: "hello world" }, "world"), true);
  assert.deepEqual(bodyJson({ name: "json", body: "{\"ok\":true}" }), { ok: true });
});

test("stream: bytes=-N suffix is converted with the upstream length into a tail 206", async () => {
  const rec = await runOne(scenarioNamed("stream-suffix-upstream-ignores-tail"), worker);
  assert.equal(rec.status, 206);
  assert.equal(rec.headers["content-range"], "bytes 200-499/500");
  assert.equal(rec.headers["content-length"], "300");
  assert.equal(rec.headers["accept-ranges"], "bytes");
  const expectedTail = F.RANGE_BODY_500.slice(200);
  assert.equal(rec.body.binLen, Buffer.byteLength(expectedTail, "utf8"));
  assert.equal(rec.body.sha256, createHash("sha256").update(Buffer.from(expectedTail, "utf8")).digest("hex"));
});

test("stream: a suffix larger than the file returns the whole file as 206, never 416", async () => {
  const rec = await runOne(scenarioNamed("stream-suffix-oversize-full"), worker);
  assert.equal(rec.status, 206);
  assert.equal(rec.headers["content-range"], "bytes 0-499/500");
  assert.equal(rec.body.binLen, Buffer.byteLength(F.RANGE_BODY_500, "utf8"));
  assert.equal(rec.body.sha256, createHash("sha256").update(Buffer.from(F.RANGE_BODY_500, "utf8")).digest("hex"));
});

test("share head: an orphaned index of a removed source is never consulted", async () => {
  const rec = await runOne(scenarioNamed("play-hit-orphan-index"), worker);
  assert.ok(rec.body.includes('<meta property="og:type" content="website">'), "must degrade to the generic card");
  assert.ok(!rec.body.includes("Ghost - Song.mp3"), "the removed source's index must not resolve");
});

test("sources POST: removing a source deletes exactly that source's share index", async () => {
  const rec = await runOne(scenarioNamed("sources-post-removes-index"), worker);
  assert.equal(rec.status, 200);
  assert.equal(rec.post.indexA, true);
  assert.equal(rec.post.indexB, false);
  assert.equal(rec.post.sourcesLen, 1);
});

test("share head: the source-targeted read side never performs a KV.list scan", async () => {
  const env = {
    MUSIC_KV: createKV({
      site_title: "分享站",
      dav_sources: JSON.stringify([F.SOURCE_A]),
      share_meta_index_v1_a: JSON.stringify([["a1b2c3d4", "Artist - Title.mp3"]]),
    }),
  };
  let listCalls = 0;
  const originalList = env.MUSIC_KV.list.bind(env.MUSIC_KV);
  env.MUSIC_KV.list = async (opts) => {
    listCalls += 1;
    return originalList(opts);
  };
  const res = await worker.fetch(makeRequest({ method: "GET", url: "https://app.example.com/?play=a1b2c3d4" }), env);
  const body = await res.text();
  assert.ok(body.includes("<title>Artist - Title | 分享站</title>"), "song name must resolve via the source-targeted read");
  assert.equal(listCalls, 0, "the read side must not scan the whole index prefix");
});

test("sources POST: a removed source whose normalized key collides with a kept source gets its orphan index deleted", async () => {
  const rec = await runOne(scenarioNamed("sources-post-key-collision"), worker);
  assert.equal(rec.status, 200);
  assert.equal(rec.post.oldIndexPresent, false, "the key was written by the removed source a.b; identity-based cleanup must delete it even though the normalized key collides with kept source ab (ab's own index is rewritten on next list scan)");
  assert.equal(rec.post.sourcesLen, 1);
});

test("sources POST: a failing orphan-index delete cannot prevent the list-cache invalidation", async () => {
  const env = {
    MUSIC_KV: createKV({
      admin_pass: F.ADMIN_HASH,
      [`session_${"f".repeat(64)}`]: JSON.stringify({ created: FROZEN_NOW }),
      dav_sources: JSON.stringify([F.SOURCE_A, F.SOURCE_B]),
      share_meta_index_v1_b: JSON.stringify([["bbbbbbbb", "Drop - Me.mp3"]]),
      cache_v3_list_all: "{}",
      cache_v3_list_a: "{}",
    }),
  };
  const originalDelete = env.MUSIC_KV.delete.bind(env.MUSIC_KV);
  env.MUSIC_KV.delete = async (key) => {
    if (typeof key === "string" && key.startsWith("share_meta_index_v1_")) throw new Error("kv delete boom");
    return originalDelete(key);
  };
  let status = 0;
  await worker.fetch(makeRequest({
    method: "POST",
    url: "https://app.example.com/api/admin/sources",
    headers: { "content-type": "application/json", cookie: "admin_token=" + "f".repeat(64) },
    body: JSON.stringify({ sources: [F.SOURCE_A] }),
  }), env).then((r) => { status = r.status; }, () => { status = -1; });
  const cacheKeys = (await env.MUSIC_KV.list({ prefix: "cache_v3_list_" })).keys.length;
  assert.equal(status, 200, "a failing orphan-index delete must not abort the already-committed save");
  assert.equal(cacheKeys, 0, "list-cache invalidation must already have run before the orphan delete");
});

test("stream Range: forwards identity encoding and never locally slices a content-encoded 200", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }) };
  const prevFetch = globalThis.fetch;
  let sawHeaders = null;
  globalThis.fetch = async (_input, init) => {
    sawHeaders = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    return new Response("COMPRESSEDBODY", { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "14", "content-encoding": "gzip" } });
  };
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: "https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3", headers: { range: "bytes=0-4" } }), env);
    assert.equal(sawHeaders["accept-encoding"], "identity", "a forwarded Range request must pin identity encoding (Contract A trigger domain)");
    assert.equal(res.status, 200, "a content-encoded 200 must pass through whole, never a fabricated 206 slice (Contract A non-trigger)");
    assert.equal(res.headers.get("content-range"), null, "no Content-Range may ride on an unsliced full body");
  } finally { globalThis.fetch = prevFetch; }
});

test("stream Range degraded passthrough: a content-encoded whole body carries no stale Accept-Ranges", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }) };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("COMPRESSEDBODY", { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "14", "content-encoding": "gzip", "accept-ranges": "bytes" } });
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: "https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3", headers: { range: "bytes=0-4" } }), env);
    assert.equal(res.status, 200, "the encoded 200 still passes through whole (Contract A non-trigger)");
    assert.equal(res.headers.get("content-range"), null, "no fabricated Content-Range on the degraded response");
    assert.equal(res.headers.get("accept-ranges"), null, "E2: a degraded whole-body response must not advertise Range support the very response refused to slice");
  } finally { globalThis.fetch = prevFetch; }
});
