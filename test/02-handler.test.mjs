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

test("stream HEAD: an origin that refuses HEAD but serves GET must yield a 2xx size probe so jsmediatags can read tags", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }) };
  const prevFetch = globalThis.fetch;
  const forwarded = [];
  const probeHeaders = [];
  globalThis.fetch = async (_input, init) => {
    const m = (init && init.method) || "GET";
    forwarded.push(m);
    probeHeaders.push(Object.fromEntries(new Headers(init && init.headers ? init.headers : {}).entries()));
    if (m === "HEAD") return new Response(null, { status: 403, statusText: "Forbidden", headers: { "content-type": "text/plain" } });
    return new Response("x", { status: 206, statusText: "Partial Content", headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-0/9245049", "content-length": "1", "content-encoding": "gzip" } });
  };
  try {
    const res = await worker.fetch(makeRequest({ method: "HEAD", url: "https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3" }), env);
    assert.equal(res.status, 200, "HEAD must be answered 200, never the origin's 403 (jsmediatags size-probe contract)");
    const body = await res.text();
    assert.equal(body, "", "a HEAD response must carry no body");
    assert.equal(res.headers.get("content-length"), "9245049", "the probe must advertise the total from Content-Range, not the 1-byte slice length");
    assert.equal(res.headers.get("accept-ranges"), "bytes", "range support must be advertised so the library may issue ID3 tail reads");
    assert.deepEqual(forwarded, ["GET"], "the worker must re-probe with a GET range, never forward the refused HEAD");
    assert.equal(probeHeaders[0]["accept-encoding"], "identity", "the size probe must pin identity so a compressed length can never masquerade as the byte total (ATK-4)");
    assert.equal(probeHeaders[0]["range"], "bytes=0-0", "the size probe must request a single byte, never the whole file");
    assert.equal(res.headers.get("content-encoding"), null, "the synthesized HEAD answer must carry no upstream Content-Encoding (fresh headers)");
  } finally { globalThis.fetch = prevFetch; }
});

test("stream HEAD: a genuine upstream 404 on the GET probe is surfaced, never masked as 200", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }) };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Not Found", { status: 404, statusText: "Not Found", headers: { "content-type": "text/plain" } });
  try {
    const res = await worker.fetch(makeRequest({ method: "HEAD", url: "https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3" }), env);
    assert.equal(res.status, 404, "a real 404 on the probe must not be turned into a fake 200");
  } finally { globalThis.fetch = prevFetch; }
});

test("stream HEAD: a malformed 206 with no Content-Range omits Content-Length so jsmediatags falls back to a GET size probe", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }) };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("x", { status: 206, statusText: "Partial Content", headers: { "content-type": "audio/mpeg", "content-length": "1" } });
  try {
    const res = await worker.fetch(makeRequest({ method: "HEAD", url: "https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3" }), env);
    assert.equal(res.status, 200, "still answered, not the origin 403");
    assert.equal(res.headers.get("content-length"), null, "an undeterminable total must OMIT Content-Length (never a fake 0) so the library's _fetchSizeWithGetRequest fallback runs");
  } finally { globalThis.fetch = prevFetch; }
});

test("stream HEAD: a genuinely empty file (whole 200 with Content-Length 0) is answered with Content-Length 0, distinguishing measured-zero from unknown", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }) };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "0" } });
  try {
    const res = await worker.fetch(makeRequest({ method: "HEAD", url: "https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3" }), env);
    assert.equal(res.status, 200, "an empty file is still answered, not the origin 403");
    assert.equal(res.headers.get("content-length"), "0", "a measured 0 total is advertised as Content-Length: 0 (NOT omitted) — the boundary that separates 实测恰等于 0 from 未知 null 省略头");
  } finally { globalThis.fetch = prevFetch; }
});

test("stream HEAD: a path-validation failure stays 403 regardless of method and never reaches the size probe", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }) };
  const prevFetch = globalThis.fetch;
  let probed = false;
  globalThis.fetch = async () => { probed = true; return new Response("x", { status: 206, statusText: "Partial Content", headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-0/10", "content-length": "1" } }); };
  try {
    const escape = await worker.fetch(makeRequest({ method: "HEAD", url: "https://app.example.com/api/stream?sourceId=a&file=" + encodeURIComponent("../secret.mp3") }), env);
    assert.equal(escape.status, 403, "a traversal HEAD must hit the method-agnostic streamPathReject (ATK-5), before any HEAD rewrite");
    const notAudio = await worker.fetch(makeRequest({ method: "HEAD", url: "https://app.example.com/api/stream?sourceId=a&file=notes.txt" }), env);
    assert.equal(notAudio.status, 403, "a non-audio HEAD must be rejected by the extension whitelist before any probe");
    assert.equal(probed, false, "a rejected path must never forward a probe to the origin (no path leak via the HEAD rewrite)");
  } finally { globalThis.fetch = prevFetch; }
});

test("stream GET playback path is untouched by the HEAD interception: the same origin still streams 206", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }) };
  const prevFetch = globalThis.fetch;
  const forwarded = [];
  globalThis.fetch = async (_input, init) => {
    const m = (init && init.method) || "GET";
    forwarded.push(m);
    if (m === "HEAD") return new Response(null, { status: 403, headers: { "content-type": "text/plain" } });
    return new Response("0123456789", { status: 206, statusText: "Partial Content", headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-9/10", "content-length": "10" } });
  };
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: "https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3", headers: { range: "bytes=0-9" } }), env);
    assert.equal(res.status, 206, "a GET must still be forwarded verbatim and proxied as before");
    assert.deepEqual(forwarded, ["GET"], "a GET is never converted to a GET probe with a forced Range");
    const body = await res.text();
    assert.equal(body, "0123456789", "the GET body streams through unchanged");
  } finally { globalThis.fetch = prevFetch; }
});

test("stream upstream timeout: a hung origin is aborted into 504 with a desensitized body (non-admin)", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }), STREAM_FETCH_TIMEOUT_MS: "500" };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
    const sig = init && init.signal;
    if (!sig) return;
    if (sig.aborted) { reject(sig.reason); return; }
    sig.addEventListener("abort", () => reject(sig.reason));
  });
  try {
    const guard = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout-guard: handler hung past 3s")), 3000));
    const res = await Promise.race([worker.fetch(makeRequest({ method: "GET", url: "https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3" }), env), guard]);
    assert.equal(res.status, 504, "S-3: a header-phase timeout must answer 504, never an infinite hang or a 502");
    const body = JSON.parse(await res.text());
    assert.equal(body.error, "源站响应超时", "S-3: non-admin body must be the desensitized timeout text");
    assert.equal(body.diagnostic, null, "S-3: non-admin must not leak the diagnostic");
  } finally { globalThis.fetch = prevFetch; }
});

test("stream upstream timeout: admin receives the abort diagnostic", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]), admin_pass: F.ADMIN_HASH, ["session_" + "f".repeat(64)]: JSON.stringify({ created: FROZEN_NOW }) }), STREAM_FETCH_TIMEOUT_MS: "500" };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
    const sig = init && init.signal;
    if (!sig) return;
    if (sig.aborted) { reject(sig.reason); return; }
    sig.addEventListener("abort", () => reject(sig.reason));
  });
  try {
    const guard = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout-guard")), 3000));
    const res = await Promise.race([worker.fetch(makeRequest({ method: "GET", url: "https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3", headers: { cookie: "admin_token=" + "f".repeat(64) } }), env), guard]);
    assert.equal(res.status, 504, "S-3: admin path also answers 504");
    const body = JSON.parse(await res.text());
    assert.ok(body.diagnostic, "S-3: admin receives the diagnostic object");
    assert.ok(String(body.diagnostic.title || "").length > 0, "S-3/E-4: the 504 diagnostic carries a non-empty title for the admin panel");
  } finally { globalThis.fetch = prevFetch; }
});

test("D-3 stream: an already-aborted client signal aborts the upstream fetch and is not a normal successful stream", async () => {
  const env = { MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }), STREAM_FETCH_TIMEOUT_MS: "5000" };
  const prevFetch = globalThis.fetch;
  let sawSignalAborted = false, upstreamCalled = false;
  globalThis.fetch = (input, init) => {
    upstreamCalled = true;
    const sig = init && init.signal;
    sawSignalAborted = !!(sig && sig.aborted);
    return new Promise((resolve, reject) => {
      if (!sig) return;
      if (sig.aborted) return reject(sig.reason);
      sig.addEventListener("abort", () => reject(sig.reason));
    });
  };
  const ac = new AbortController(); ac.abort(); // client already gone
  try {
    const req = new Request("https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3", { method: "GET", signal: ac.signal });
    const guard = new Promise((_, rej) => setTimeout(() => rej(new Error("guard: handler hung past 3s")), 3000));
    const res = await Promise.race([worker.fetch(req, env), guard]);
    assert.equal(upstreamCalled, true, "upstream fetch attempted");
    assert.equal(sawSignalAborted, true, "the merged client signal must reach the upstream fetch already-aborted");
    assert.equal(res.status, 504, "an aborted client surfaces via the AbortError→504 path (body discarded by runtime)");
  } finally { globalThis.fetch = prevFetch; }
});

// ---- D-1 分段并发（handler 级）----

const STREAM_URL = "https://app.example.com/api/stream?sourceId=a&file=Alpha%20-%20One.mp3";
const STREAM_ENV = () => ({ MUSIC_KV: createKV({ dav_sources: JSON.stringify([{ id: "a", name: "A", url: "https://dav.example.com/dav/" }]) }) });

// D-1 并发分发：大区间（超出 PartSize）→ stub 收到多个带 Range 头的段请求，客户端收 206 且拼接逐字节正确。
// PartSize 默认 1MiB，测试用 STREAM_SEGMENT_PART_SIZE=100 收窄触发域（rangeCount=400 > 100）。
// D-1 fixtures: the PartSize knob clamps at 65536, so fan-out tests synthesize a 400KB upstream
// (RANGE_BODY_500 × 800) with deterministic, position-verifiable content.
const RANGE_BODY_400K = F.RANGE_BODY_500.repeat(800);

const streamEnv = (partSize) => {
  const env = STREAM_ENV();
  env.STREAM_SEGMENT_PART_SIZE = partSize;
  return env;
};

const seg206 = (body, total) => (s, e) => new Response(body.slice(s, e + 1), {
  status: 206,
  statusText: "Partial Content",
  headers: { "content-type": "audio/mpeg", "content-range": `bytes ${s}-${e}/${total}`, "content-length": String(e - s + 1) },
});
const segSlice = seg206(RANGE_BODY_400K, RANGE_BODY_400K.length);

test("D-1 segmented concurrency: a large range fans out into multiple ranged upstream requests, response is a byte-exact 206", async () => {
  const env = streamEnv("65536");
  env.STREAM_SEGMENT_CONCURRENCY = "3";
  const prevFetch = globalThis.fetch;
  const rangeCalls = [];
  let initDone = false;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    rangeCalls.push(h.range || "(no range)");
    // model a range-ignoring upstream: the FIRST request (raw client range forwarded verbatim) gets a whole 200;
    // only the worker-issued segment sub-ranges get honest 206 slices.
    if (!initDone) {
      initDone = true;
      return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (m) return segSlice(parseInt(m[1], 10), parseInt(m[2], 10));
    return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
  };
  try {
    const start = 65536, end = 399999; // 334464 bytes > one 65536 part → 6 segments
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: `bytes=${start}-${end}` } }), env);
    assert.equal(res.status, 206, "aggregated segments must answer 206");
    assert.equal(res.headers.get("content-range"), `bytes ${start}-${end}/${RANGE_BODY_400K.length}`, "Content-Range must be the client's original range (E-5 reset trio)");
    assert.equal(res.headers.get("content-length"), String(end - start + 1), "Content-Length must be the client's range count");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    const body = await res.text();
    assert.equal(body, RANGE_BODY_400K.slice(start, end + 1), "the concatenated stream must equal the client's range byte-for-byte");
    assert.ok(rangeCalls.length >= 6, "multiple ranged segment requests must be issued, got " + rangeCalls.length);
    const segCalls = rangeCalls.filter((r) => r !== `bytes=${start}-${end}`);
    for (const r of segCalls) assert.match(r, /^bytes=\d+-\d+$/, "every segment fetch must carry an explicit ranged header");
  } finally { globalThis.fetch = prevFetch; }
});

test("D-1 segmented concurrency: in-flight concurrency never exceeds the knob", async () => {
  const env = streamEnv("65536");
  env.STREAM_SEGMENT_CONCURRENCY = "2";
  const prevFetch = globalThis.fetch;
  let inFlight = 0, peak = 0, initDone = false;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    if (!initDone) {
      initDone = true;
      return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (!m) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    inFlight++;
    peak = Math.max(peak, inFlight);
    const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return segSlice(s, e);
  };
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: "bytes=0-399999" } }), env);
    await res.text();
    assert.ok(peak <= 2, "peak in-flight segment fetches must be <= concurrency knob, got " + peak);
    assert.ok(peak >= 2, "the window must actually overlap (not fully serialized), got " + peak);
  } finally { globalThis.fetch = prevFetch; }
});

test("D-1 segment-0 downgrade: a 200 on the first segment response header aborts the fan-out, total upstream calls stay minimal, client still gets the local-slice 206", async () => {
  const env = streamEnv("65536");
  const prevFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    calls.push(h.range || "(no range)");
    // every fetch (including fan-out segments) returns a plain 200 whole body
    return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
  };
  try {
    const start = 65536, end = 399999;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: `bytes=${start}-${end}` } }), env);
    assert.equal(res.status, 206, "the downgrade path must still serve the local-slice 206 (current single-connection behavior)");
    assert.equal(res.headers.get("content-range"), `bytes ${start}-${end}/${RANGE_BODY_400K.length}`);
    assert.ok(calls.length <= 2, "no bandwidth multiplication: total upstream calls must stay minimal, got " + calls.length);
    const body = await res.text();
    assert.equal(body, RANGE_BODY_400K.slice(start, end + 1));
  } finally { globalThis.fetch = prevFetch; }
});

test("D-1 probe exhaustion degrades: probe network failures never 502 — the local-slice 206 always serves", async () => {
  const env = streamEnv("65536");
  const prevFetch = globalThis.fetch;
  const calls = [];
  let initDone = false;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    calls.push(h.range || "(no range)");
    if (!initDone) {
      initDone = true;
      return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    }
    // every probe/segment fetch dies at the network layer (limity origin shape)
    throw new TypeError("fetch failed");
  };
  try {
    const start = 65536, end = 399999;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: `bytes=${start}-${end}` } }), env);
    assert.equal(res.status, 206, "probe exhaustion must degrade to the local-slice 206, never a 502");
    assert.equal(res.headers.get("content-range"), `bytes ${start}-${end}/${RANGE_BODY_400K.length}`);
    const body = await res.text();
    assert.equal(body, RANGE_BODY_400K.slice(start, end + 1), "the degraded body must be the client's range byte-for-byte");
    const probeCalls = calls.filter((r) => r.startsWith("bytes=65536-131071")).length;
    assert.equal(probeCalls, 3, "the probe retried exactly 3 attempts (1 initial + 2 retries) before degrading, got " + probeCalls);
  } finally { globalThis.fetch = prevFetch; }
});

test("D-1 segment retry: a headers-phase 5xx is re-sent at most 2 times; a 416 is terminal with zero retries", async () => {
  const env = streamEnv("65536");
  const prevFetch = globalThis.fetch;
  const statusLog = [];
  let initDone = false;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    if (!initDone) {
      initDone = true;
      return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (!m) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    const s = parseInt(m[1], 10);
    if (s === 131072 && statusLog.length < 2) { statusLog.push("5xx"); return new Response("boom", { status: 503, statusText: "Service Unavailable" }); }
    const e = parseInt(m[2], 10);
    return segSlice(s, e);
  };
  try {
    const start = 65536, end = 399999;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: `bytes=${start}-${end}` } }), env);
    const text = await res.text();
    assert.equal(statusLog.length, 2, "two 5xx headers-phase failures must have occurred before success");
    assert.ok(statusLog.length <= 3, "5xx headers-phase failures retry at most 2 times (1+2 attempts), got " + statusLog.length);
    assert.equal(text, RANGE_BODY_400K.slice(start, end + 1), "after retries succeed the aggregate stays byte-exact");
  } finally { globalThis.fetch = prevFetch; }

  const calls2 = [];
  initDone = false;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    calls2.push(h.range || "(no range)");
    if (!initDone) {
      initDone = true;
      return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    }
    if (!m) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    const s = parseInt(m[1], 10);
    if (s === 131072) return new Response(null, { status: 416, statusText: "Range Not Satisfiable", headers: { "content-range": `bytes */${RANGE_BODY_400K.length}` } });
    const e = parseInt(m[2], 10);
    return segSlice(s, e);
  };
  try {
    const start = 65536, end = 399999;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: `bytes=${start}-${end}` } }), env);
    await res.arrayBuffer().catch(() => {});
    const r416 = calls2.filter((r) => r.startsWith("bytes=131072-")).length;
    assert.ok(r416 <= 1, "a terminal 4xx segment must never be retried, got " + r416 + " attempts");
  } finally { globalThis.fetch = prevFetch; }

  const calls3 = [];
  initDone = false;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    calls3.push(h.range || "(no range)");
    if (!initDone) {
      initDone = true;
      return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    }
    if (!m) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    const s = parseInt(m[1], 10);
    if (s === 131072) return new Response("boom", { status: 503, statusText: "Service Unavailable" });
    const e = parseInt(m[2], 10);
    return segSlice(s, e);
  };
  try {
    const start = 65536, end = 399999;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: `bytes=${start}-${end}` } }), env);
    await res.arrayBuffer().catch(() => {});
    const r503 = calls3.filter((r) => r.startsWith("bytes=131072-")).length;
    assert.equal(r503, 3, "a persistently-5xx segment gets exactly 3 attempts (1 initial + 2 retries), got " + r503);
  } finally { globalThis.fetch = prevFetch; }
});

test("D-1 segment network-throw: a persistently-throwing segment gets exactly 3 attempts (1+2) then hard-errors the whole stream (status-0 retry cap, handler integration)", async () => {
  const env = streamEnv("65536");
  const prevFetch = globalThis.fetch;
  const calls = [];
  let initDone = false;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    calls.push(h.range || "(no range)");
    if (!initDone) {
      initDone = true;
      return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (!m) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    if (h.range === "bytes=131072-196607") throw new TypeError("fetch failed");
    const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
    return segSlice(s, e);
  };
  try {
    const start = 65536, end = 399999;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: `bytes=${start}-${end}` } }), env);
    let errored = false;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (e) { errored = true; }
    assert.equal(errored, true, "a persistently-throwing segment must hard-error the whole stream after retries exhaust");
    const segAttempts = calls.filter((r) => r === "bytes=131072-196607").length;
    assert.equal(segAttempts, 3, "the throwing segment gets exactly 3 attempts (1 initial + 2 retries) at the handler integration level, got " + segAttempts);
  } finally { globalThis.fetch = prevFetch; }
});

test("D-1 segment upstream timeout: a per-segment fetch hung past STREAM_FETCH_TIMEOUT_MS is aborted and retried, then hard-errors — the fan-out path never hangs unbounded", async () => {
  const env = streamEnv("65536");
  env.STREAM_FETCH_TIMEOUT_MS = "500";
  const prevFetch = globalThis.fetch;
  const calls = [];
  let initDone = false;
  globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    calls.push(h.range || "(no range)");
    if (!initDone) {
      initDone = true;
      resolve(new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } }));
      return;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (m && h.range === "bytes=131072-196607") {
      const sig = init.signal;
      if (sig.aborted) { reject(sig.reason); return; }
      sig.addEventListener("abort", () => reject(sig.reason));
      return;
    }
    if (!m) { resolve(new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } })); return; }
    const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
    resolve(segSlice(s, e));
  });
  try {
    const start = 65536, end = 399999;
    const guard = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout-guard: fan-out hung past 3s")), 3000));
    const res = await Promise.race([worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: `bytes=${start}-${end}` } }), env), guard]);
    let errored = false;
    let errMessage = "";
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (e) {
      errored = true;
      errMessage = String(e && e.message);
    }
    assert.equal(errored, true, "a hung segment must surface as a stream error after its retries exhaust, never an unbounded hang");
    assert.match(errMessage, /status 0 \(retries exhausted\)/, "the error must name the exhausted status-0 retry path");
    const segAttempts = calls.filter((r) => r === "bytes=131072-196607").length;
    assert.equal(segAttempts, 3, "a hung segment is aborted by the per-segment timer and retried exactly 3 times (1+2), got " + segAttempts);
  } finally { globalThis.fetch = prevFetch; }
});

test("D-1 body-interrupt: a segment body that dies mid-flight hard-errors the whole request, no silent retry re-pull", async () => {  const env = streamEnv("65536");
  const prevFetch = globalThis.fetch;
  const rangeCalls = [];
  let initDone = false;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    if (!initDone) {
      initDone = true;
      return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (!m) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    rangeCalls.push(h.range);
    const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
    if (s === 65536 * 2) {
      // declare 65536 bytes but deliver only 100, then close: a body-phase interruption
      return new Response(new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(Buffer.from(RANGE_BODY_400K.slice(s, s + 100), "utf8"))); c.close(); },
      }), { status: 206, statusText: "Partial Content", headers: { "content-type": "audio/mpeg", "content-range": `bytes ${s}-${e}/${RANGE_BODY_400K.length}`, "content-length": String(e - s + 1) } });
    }
    return segSlice(s, e);
  };
  try {
    const start = 65536, end = 399999;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: `bytes=${start}-${end}` } }), env);
    let errored = false;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (e) { errored = true; }
    assert.equal(errored, true, "a short segment body must surface as a stream error, never a silently truncated or re-pulled body");
    const reissued = rangeCalls.filter((r) => r.startsWith(`bytes=${65536 * 2}-`)).length;
    assert.equal(reissued, 1, "body-phase failure must NOT re-pull the segment (bytes already sent downstream cannot be unsent)");
  } finally { globalThis.fetch = prevFetch; }
});

// ---- O-2：CDN fetch 超时 → 回退串逐字现状 ----
test("O-2 jsmediatags CDN fetch: a hung CDN is aborted within STREAM_FETCH_TIMEOUT_MS and falls back verbatim", async () => {
  const env = STREAM_ENV();
  env.STREAM_FETCH_TIMEOUT_MS = "500";
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
    const sig = init && init.signal;
    if (!sig) return;
    if (sig.aborted) return reject(sig.reason);
    sig.addEventListener("abort", () => reject(sig.reason));
  });
  try {
    const guard = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout-guard: CDN fetch hung past 3s")), 3000));
    const res = await Promise.race([worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/js/jsmediatags.min.js" }), env), guard]);
    assert.equal(res.status, 200, "the fallback is still a 200 response");
    assert.equal(await res.text(), "// jsmediatags unavailable", "fallback body verbatim");
    assert.equal(res.headers.get("cache-control"), null, "fallback carries no Cache-Control (verbatim current behavior)");
    assert.equal(res.headers.get("content-type"), "application/javascript");
  } finally { globalThis.fetch = prevFetch; }
});

// ---- D-5：多段 Range 透传 ----
test("D-5 multi-range header: the raw Range header is forwarded upstream verbatim, clientRange stays null for the local-slice gate", async () => {
  const env = STREAM_ENV();
  const prevFetch = globalThis.fetch;
  let sawRange = null, sawAE = null;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    sawRange = h.range || null;
    sawAE = h["accept-encoding"] || null;
    return new Response(F.RANGE_BODY_500, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "500" } });
  };
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: "bytes=0-1,5-6" } }), env);
    assert.equal(sawRange, "bytes=0-1,5-6", "the raw multi-range header must reach the upstream verbatim");
    assert.equal(sawAE, "identity", "identity pinning applies to the forwarded multi-range too");
    assert.equal(res.status, 200, "an upstream 200 passes through as 200 (same degradation semantics as before, now with the header forwarded)");
  } finally { globalThis.fetch = prevFetch; }
});

// ---- D-10：KV 固化四态 ----
test("D-10 KV hit: the proxy serves the KV copy and never calls the CDN", async () => {
  const env = STREAM_ENV();
  env.MUSIC_KV.__store.set("jsmediatags_3_9_5", F.jsmediatagsBody);
  const prevFetch = globalThis.fetch;
  let cdnCalled = 0;
  globalThis.fetch = async () => { cdnCalled++; return new Response("cdn-body", { status: 200 }); };
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/js/jsmediatags.min.js" }), env);
    assert.equal(await res.text(), F.jsmediatagsBody, "the KV copy is served verbatim");
    assert.equal(cdnCalled, 0, "a KV hit must not touch the CDN");
    assert.equal(res.headers.get("content-type"), "application/javascript; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "public, max-age=604800");
  } finally { globalThis.fetch = prevFetch; }
});

test("D-10 KV miss + CDN success: the body is served and the KV put happens (awaited) before the response returns", async () => {
  const env = STREAM_ENV();
  const prevFetch = globalThis.fetch;
  const puts = [];
  const origPut = env.MUSIC_KV.put.bind(env.MUSIC_KV);
  env.MUSIC_KV.put = async (k, v) => { puts.push({ key: k, value: v }); return origPut(k, v); };
  globalThis.fetch = async () => new Response(F.jsmediatagsBody, { status: 200 });
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/js/jsmediatags.min.js" }), env);
    assert.equal(await res.text(), F.jsmediatagsBody);
    assert.equal(puts.length, 1, "exactly one KV put per CDN success");
    assert.equal(puts[0].key, "jsmediatags_3_9_5", "the put uses the frozen key");
    assert.equal(puts[0].value, F.jsmediatagsBody, "the put stores the full script body");
  } finally { globalThis.fetch = prevFetch; }
});

test("D-10 KV miss + CDN throw: the fallback string is verbatim, no put", async () => {
  const env = STREAM_ENV();
  const prevFetch = globalThis.fetch;
  const puts = [];
  const origPut = env.MUSIC_KV.put.bind(env.MUSIC_KV);
  env.MUSIC_KV.put = async (k, v) => { puts.push({ key: k }); return origPut(k, v); };
  globalThis.fetch = async () => { throw new Error("cdn unreachable"); };
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/js/jsmediatags.min.js" }), env);
    assert.equal(await res.text(), "// jsmediatags unavailable", "fallback verbatim");
    assert.equal(puts.length, 0, "no put on CDN failure");
  } finally { globalThis.fetch = prevFetch; }
});

test("D-10 KV put throws: the client still receives the CDN body (error swallowed, never a 500)", async () => {
  const env = STREAM_ENV();
  const prevFetch = globalThis.fetch;
  env.MUSIC_KV.put = async () => { throw new Error("kv put boom"); };
  globalThis.fetch = async () => new Response(F.jsmediatagsBody, { status: 200 });
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/js/jsmediatags.min.js" }), env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), F.jsmediatagsBody, "a KV put failure must not block the CDN body");
  } finally { globalThis.fetch = prevFetch; }
});

test("D-1 fan-out leak guard: on a successful fan-out the initial whole-file res.body is cancelled exactly once, first segment still byte-exact", async () => {
  const env = streamEnv("65536");
  env.STREAM_SEGMENT_CONCURRENCY = "3";
  const prevFetch = globalThis.fetch;
  let wholeFileCancelCount = 0;
  let initDone = false;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    if (!initDone) {
      initDone = true;
      const r = new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
      const origCancel = r.body.cancel.bind(r.body);
      r.body.cancel = async (reason) => { wholeFileCancelCount++; return origCancel(reason); };
      return r;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (!m) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
    return segSlice(s, e);
  };
  try {
    const start = 0, end = 399999;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: `bytes=${start}-${end}` } }), env);
    const body = await res.text();
    assert.equal(res.status, 206, "successful fan-out still returns 206");
    assert.equal(body, RANGE_BODY_400K.slice(start, end + 1), "first segment + fan-out bytes must remain byte-exact");
    assert.equal(wholeFileCancelCount, 1, "the discarded whole-file res.body must be cancelled exactly once on the success path");
  } finally { globalThis.fetch = prevFetch; }
});

test("F1 CDN non-2xx: an error page is never cached into KV and never served as JS; the 2xx path caches with a self-heal TTL", async () => {
  const env = STREAM_ENV();
  const prevFetch = globalThis.fetch;
  const putCalls = [];
  env.MUSIC_KV.put = async (k, v, opts) => { putCalls.push([k, typeof v === "string" ? v.slice(0, 40) : v, opts]); };
  globalThis.fetch = async () => new Response("<!doctype html><h1>502 Bad Gateway</h1>", { status: 502, statusText: "Bad Gateway" });
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/js/jsmediatags.min.js" }), env);
    const body = await res.text();
    assert.equal(res.status, 200, "the client still receives a loadable JS body");
    assert.equal(body, "// jsmediatags unavailable", "a 502 CDN page must fall back, never pass through");
    assert.equal(putCalls.length, 0, "a non-2xx CDN body must never be written into KV");
  } finally { globalThis.fetch = prevFetch; }
  const env2 = STREAM_ENV();
  globalThis.fetch = async () => new Response("/*ok*/", { status: 200 });
  try {
    const res2 = await worker.fetch(makeRequest({ method: "GET", url: PAGE_URL + "/js/jsmediatags.min.js" }), env2);
    assert.equal(await res2.text(), "/*ok*/", "the 2xx path still serves and caches");
    const lastPut = env2.MUSIC_KV.__puts[env2.MUSIC_KV.__puts.length - 1];
    assert.ok(lastPut && lastPut.opts && lastPut.opts.expirationTtl === 604800, "the success-path cache write must carry a self-heal TTL (存量脏值不再永久驻留)");
  } finally { globalThis.fetch = prevFetch; }
});

test("F2 bridge short body: a first-segment 206 that ends before firstBodyLen must surface as a stream error, never a silently short 206", async () => {
  const env = streamEnv("65536");
  env.STREAM_SEGMENT_CONCURRENCY = "2";
  const prevFetch = globalThis.fetch;
  let initDone = false;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    if (!initDone) {
      initDone = true;
      return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (!m) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
    if (s === 0) {
      return new Response(RANGE_BODY_400K.slice(s, s + 10), {
        status: 206, statusText: "Partial Content",
        headers: { "content-type": "audio/mpeg", "content-range": "bytes " + s + "-" + e + "/" + RANGE_BODY_400K.length },
      });
    }
    return segSlice(s, e);
  };
  try {
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: "bytes=0-399999" } }), env);
    assert.equal(res.status, 206, "fan-out begins");
    await assert.rejects(() => res.text(), /first segment body ended after 10 of 65536/, "an early-ending first segment must hard-error the response stream");
  } finally { globalThis.fetch = prevFetch; }
});

test("F2 probe content-range gate: a 206 whose span is not the requested one is rejected; the client still gets the byte-exact original range via single-connection slicing", async () => {
  const env = streamEnv("65536");
  env.STREAM_SEGMENT_CONCURRENCY = "3";
  const prevFetch = globalThis.fetch;
  let initDone = false;
  let lyingProbeCancels = 0;
  globalThis.fetch = async (input, init) => {
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    if (!initDone) {
      initDone = true;
      return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (!m) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
    const lying = new Response(RANGE_BODY_400K.slice(0, e - s + 1), {
      status: 206, statusText: "Partial Content",
      headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-" + (e - s) + "/" + RANGE_BODY_400K.length },
    });
    const oc = lying.body.cancel.bind(lying.body);
    lying.body.cancel = async (reason) => { lyingProbeCancels++; return oc(reason); };
    return lying;
  };
  try {
    const start = 65536, end = 399999;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: "bytes=" + start + "-" + end } }), env);
    const body = await res.text();
    assert.equal(res.status, 206, "the fallback still answers 206");
    assert.equal(res.headers.get("content-range"), "bytes " + start + "-" + end + "/" + RANGE_BODY_400K.length, "Content-Range must stay the client's original span");
    assert.equal(body, RANGE_BODY_400K.slice(start, end + 1), "a misreported probe must degrade to a byte-exact single-connection slice, never splice foreign bytes");
    assert.ok(lyingProbeCancels >= 1, "the discarded lying probe body must be cancelled");
  } finally { globalThis.fetch = prevFetch; }
});

test("G1 fan-out cap gate: when the max-segments re-scale would push one segment past the 8 MiB PartSize ceiling, the fan-out is skipped and the client still gets the byte-exact range via the single-connection slice", async () => {
  const env = STREAM_ENV();
  env.STREAM_SEGMENT_PART_SIZE = "65536";
  env.STREAM_SEGMENT_MAX_SEGMENTS = "1";
  const prevFetch = globalThis.fetch;
  const BIG_BODY = F.RANGE_BODY_500.repeat(16778);
  const TOTAL = BIG_BODY.length;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(BIG_BODY, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(TOTAL) } });
  };
  try {
    const start = 0, end = 8388608;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: "bytes=" + start + "-" + end } }), env);
    assert.equal(res.status, 206, "the slice fallback still answers 206");
    assert.equal(res.headers.get("content-range"), "bytes " + start + "-" + end + "/" + TOTAL, "Content-Range must stay the client's original span");
    assert.equal(res.headers.get("content-length"), String(end - start + 1));
    const body = await res.text();
    assert.equal(body, BIG_BODY.slice(start, end + 1), "single-connection slice must be byte-exact");
    assert.equal(calls, 1, "no fan-out probe may be issued once the recomputed part size exceeds the 8 MiB cap, got " + calls + " upstream calls");
  } finally { globalThis.fetch = prevFetch; }
});

test("G2 wiring: STREAM_FETCH_TIMEOUT_MS reaches the body-phase stall deadline through the handler into aggregateSegmentedStream", async () => {
  const src01 = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "01-handler.part.js"), "utf8");
  assert.match(src01, /stallDeadlineMs:\s*upstreamTimeoutMs/, "structural lock: the handler must forward the resolved upstream timeout into the aggregator stall deadline");
  const env = streamEnv("65536");
  env.STREAM_FETCH_TIMEOUT_MS = "500";
  const prevFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    if (calls === 1) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (!m) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
    if (s === 0) return segSlice(s, e);
    return new Response(new ReadableStream({
      start(c) {},
      cancel() {},
    }), { status: 206, statusText: "Partial Content", headers: { "content-type": "audio/mpeg", "content-range": "bytes " + s + "-" + e + "/" + RANGE_BODY_400K.length, "content-length": String(e - s + 1) } });
  };
  try {
    const start = 0, end = 131071;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: "bytes=" + start + "-" + end } }), env);
    assert.equal(res.status, 206, "fan-out begins");
    const t0 = Date.now();
    await assert.rejects(() => res.text(), /stalled after 0 of 65536 bytes in segment 0/, "the planned segment stalls; the deadline must be the wired 500ms");
    const elapsed = Date.now() - t0;
    assert.ok(calls >= 2, "precondition: fan-out must have issued the initial + segment requests, got " + calls);
    assert.ok(elapsed < 1400, "STREAM_FETCH_TIMEOUT_MS=500 must set the body-phase stall deadline; the hardcoded 1500 starts its clock strictly after t0 (the segment pump only launches on the consumer's first pull), so the old build breaches 1400 deterministically, took " + elapsed + "ms");
  } finally { globalThis.fetch = prevFetch; }
});

test("H1 probe backoff: a 429 first-segment probe must be retried after an exponential pause, never hammered immediately", async () => {
  const env = streamEnv("65536");
  env.STREAM_SEGMENT_RETRY_BASE_MS = "40";
  const prevFetch = globalThis.fetch;
  const stamps = [];
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    stamps.push(Date.now());
    const h = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.range || "");
    if (calls === 1) return new Response(RANGE_BODY_400K, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": String(RANGE_BODY_400K.length) } });
    if (calls === 2) return new Response("", { status: 429, statusText: "Too Many Requests", headers: { "content-length": "0" } });
    const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
    return segSlice(s, e);
  };
  try {
    const start = 0, end = 131071;
    const res = await worker.fetch(makeRequest({ method: "GET", url: STREAM_URL, headers: { range: "bytes=" + start + "-" + end } }), env);
    assert.equal(res.status, 206, "fan-out must still answer 206 after a backed-off probe retry");
    const body = await res.text();
    assert.equal(body, RANGE_BODY_400K.slice(start, end + 1), "bytes must stay byte-exact through the retry");
    assert.equal(calls, 4, "exactly initial + 429 probe + backed-off honest probe + one planned segment, got " + calls);
    const gap = stamps[2] - stamps[1];
    assert.ok(gap >= 35, "the retry after a 429 probe must wait the configured 40ms backoff, observed gap " + gap + "ms");
  } finally { globalThis.fetch = prevFetch; }
});
