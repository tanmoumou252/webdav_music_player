import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseGoldenRecord } from "./tools/record.mjs";
import { loadParts } from "./helper/load-parts.mjs";
import { createKV } from "./helper/kv.mjs";
import { installStubFetch, freezeClock } from "./helper/harness.mjs";
import { ADMIN_HASH, BASIC_A, SOURCE_A, SOURCE_ERR, PROPFIND_A, PROPFIND_B, PROPFIND_ONLY_DIR, PROPFIND_NON_AUDIO, WAF_403_BODY, HTML_LOGIN_PAGE, davResponse, RANGE_BODY_500 } from "./helper/fixtures.mjs";

const P = loadParts();

test("getShareDisplayParts: artist - title", () => {
  assert.deepEqual(P.getShareDisplayParts("Artist - Title.mp3"), { artist: "Artist", title: "Title" });
  assert.deepEqual(P.getShareDisplayParts("A - B - C.flac"), { artist: "A", title: "B - C" });
  assert.deepEqual(P.getShareDisplayParts("Single.mp3"), { artist: "", title: "Single" });
  assert.deepEqual(P.getShareDisplayParts(""), { artist: "", title: "" });
  assert.deepEqual(P.getShareDisplayParts(null), { artist: "", title: "" });
  assert.deepEqual(P.getShareDisplayParts("  spaced  name .wav"), { artist: "", title: "spaced  name" });
  assert.deepEqual(P.getShareDisplayParts("dash-only - no-ext"), { artist: "dash-only", title: "no-ext" });
});

test("escapeHtmlText: entity chain and nullish guard", () => {
  assert.equal(P.escapeHtmlText("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(P.escapeHtmlText(null), "");
  assert.equal(P.escapeHtmlText(undefined), "");
  assert.equal(P.escapeHtmlText(""), "");
  assert.equal(P.escapeHtmlText(0), "");
  assert.equal(P.escapeHtmlText("a&amp;b"), "a&amp;amp;b");
});

test("buildShareHeadHtml: escaped OG/Twitter head", () => {
  const html = P.buildShareHeadHtml("https://app.example.com/?play=a1b2c3d4#frag", "Artist - Title.mp3", "站点");
  assert.ok(html.includes('<meta property="og:title" content="Artist - Title | 站点">'));
  assert.ok(!html.includes("<title>"), "the document title is swapped by the handler, never emitted by the head builder");
  assert.ok(html.includes('<meta property="og:type" content="music.song">'));
  assert.ok(html.includes('<meta property="og:url" content="https://app.example.com/?play=a1b2c3d4">'));
  assert.ok(html.includes('<meta name="twitter:card" content="summary">'));
  assert.ok(html.includes('<meta name="twitter:title" content="Artist - Title | 站点">'), "song card restores twitter:title parity with og:title");
  assert.ok(html.includes('<meta name="twitter:description" content="Artist - Title · 站点">'), "song card restores twitter:description parity with og:description");
  assert.ok(html.includes('<meta property="og:description" content="Artist - Title · 站点">'));
  assert.ok(html.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'));
  assert.ok(html.includes('<meta name="twitter:image" content="https://app.example.com/og-icon.png">'));
  assert.ok(html.includes('<meta property="og:image:width" content="512">'));
  assert.ok(html.includes('<meta property="og:image:height" content="512">'));
  const withCover = P.buildShareHeadHtml("https://app.example.com/?play=a1b2c3d4#frag", "Artist - Title.mp3", "站点", "a1b2c3d4");
  assert.ok(withCover.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'), "song card uses the raster /og-icon.png for social scrapers");
  assert.ok(withCover.includes('<meta name="twitter:image" content="https://app.example.com/og-icon.png">'));
  assert.ok(withCover.includes('<meta name="twitter:card" content="summary">'), "song card uses summary, never summary_large_image");
  assert.ok(withCover.includes('<meta property="og:image:width" content="512">'));
  assert.ok(withCover.includes('<meta property="og:image:height" content="512">'));
  assert.ok(withCover.includes('<meta property="og:image:alt" content="站点">'));
  assert.ok(withCover.includes("og:description"), "song card restores og:description");
  assert.ok(withCover.includes('<meta property="og:description" content="Artist - Title · 站点">'));
  assert.ok(withCover.includes("og:site_name"), "song card restores og:site_name");
  assert.ok(withCover.includes('<meta name="description"'), "song card restores the non-og description tag");
  assert.ok(withCover.includes('<meta property="og:title" content="Artist - Title | 站点">'), "song og:title carries the brand suffix");
  const genericStays = P.buildShareHeadHtml("https://app.example.com/", "", "站点", "a1b2c3d4");
  assert.ok(genericStays.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'), "generic card ignores coverId");
  assert.ok(genericStays.includes('<meta property="og:site_name" content="站点">'), "generic card keeps site name");
  assert.ok(genericStays.includes('<meta name="twitter:title" content="站点">'), "generic card carries twitter:title");
  assert.ok(genericStays.includes('<meta name="twitter:description" content="站点 · 多源 WebDAV 音乐库">'), "generic card carries twitter:description");
  const fallback = P.buildShareHeadHtml("https://app.example.com/?play=a1b2c3d4", "Artist - Title.mp3", "站点");
  assert.ok(fallback.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'), "three-arg call keeps the static icon contract");
  assert.ok(fallback.includes('<meta property="og:description" content="Artist - Title · 站点">'), "three-arg call keeps description");
  assert.ok(fallback.includes('<meta property="og:title" content="Artist - Title | 站点">'), "three-arg call keeps the branded title");
  const xss = P.buildShareHeadHtml("https://x.test/\"onmouseover=alert(1)", "A<B>&C.mp3", "T\"T");
  assert.ok(xss.includes("&lt;B&gt;&amp;C"));
  assert.ok(xss.includes("T&quot;T"));
  assert.ok(xss.includes("https://x.test/&quot;onmouseover=alert(1)"), "raw quote in url must be entity-escaped");
  assert.ok(xss.includes('<meta property="og:image" content="https://x.test/og-icon.png">'), "image url is origin-derived and must stay absolute");
  assert.ok(!xss.includes('content="https://x.test/"'), "no attribute value may carry a raw quote that breaks out of the markup");
  assert.ok(xss.includes('<meta property="og:title" content="A&lt;B&gt;&amp;C | T&quot;T">'));
  assert.ok(P.buildShareHeadHtml("https://x.test", "", "").includes('<meta property="og:type" content="website">'));
  assert.ok(P.buildShareHeadHtml("https://x.test", "", "").includes('<meta property="og:url" content="https://x.test/">'));
});

test("generateTrackId: FNV-1a golden hex", () => {
  assert.equal(P.generateTrackId("Alpha - One.mp3"), "93f8adb4");
  assert.equal(P.generateTrackId("Beta & Band - Two.flac"), "d0bc3107");
  assert.equal(P.generateTrackId("Gamma <live>.m4a"), "17e2b518");
  assert.equal(P.generateTrackId(""), P.generateTrackId("   "));
  assert.match(P.generateTrackId("anything"), /^[0-9a-f]{8}$/);
  assert.equal(P.generateTrackId("  Alpha - One.mp3  "), P.generateTrackId("alpha - one.mp3"));
});

test("decodeXmlEntities: all entity forms", () => {
  assert.equal(P.decodeXmlEntities("&apos;&#39;&#039;&#x27;"), "''''");
  assert.equal(P.decodeXmlEntities("&quot;&#34;"), "\"\"");
  assert.equal(P.decodeXmlEntities("&amp;&lt;&gt;&nbsp;"), "&<> ");
  assert.equal(P.decodeXmlEntities("&#160;"), " ");
  assert.equal(P.decodeXmlEntities("&#x2022;&bull;"), "••");
  assert.equal(P.decodeXmlEntities("&#65;&#x42;"), "AB");
  assert.equal(P.decodeXmlEntities(""), "");
  assert.equal(P.decodeXmlEntities("Beta &amp; Band"), "Beta & Band");
  assert.equal(P.decodeXmlEntities("&amp;lt;"), "<");
});

test("normalizeSongKey: NFC + spaces + smart quotes + lowercase", () => {
  assert.equal(P.normalizeSongKey("  It\u2019s \t\u201CHi\u201D  "), "it's \"hi\"");
  assert.equal(P.normalizeSongKey("\uFF07\uFF02"), "'\"");
  assert.equal(P.normalizeSongKey("&amp;X"), "&x");
  assert.equal(P.normalizeSongKey("CAF\u00C9.flac"), "café.flac");
  assert.equal(P.normalizeSongKey("cafe\u0301.flac"), P.normalizeSongKey("CAFÉ.flac"));
});

test("isValidSourceUrl: http/https only", () => {
  assert.equal(P.isValidSourceUrl("https://dav.example.com/x"), true);
  assert.equal(P.isValidSourceUrl("http://a.test"), true);
  assert.equal(P.isValidSourceUrl("HTTPS://A.TEST"), true);
  assert.equal(P.isValidSourceUrl("ftp://a.test"), false);
  assert.equal(P.isValidSourceUrl("javascript:alert(1)"), false);
  assert.equal(P.isValidSourceUrl(""), false);
  assert.equal(P.isValidSourceUrl(null), false);
  assert.equal(P.isValidSourceUrl(undefined), false);
  assert.equal(P.isValidSourceUrl(123), false);
});

test("session cookie strings", () => {
  assert.equal(P.sessionCookie("tok123"), "admin_token=tok123; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000");
  assert.equal(P.clearedSessionCookie(), "admin_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
});

test("assertStreamPathContained", () => {
  assert.equal(P.assertStreamPathContained("https://a.test/dav/", "https://a.test/dav/song.mp3"), true);
  assert.equal(P.assertStreamPathContained("https://a.test/dav", "https://a.test/dav"), true);
  assert.equal(P.assertStreamPathContained("https://a.test/dav", "https://a.test/david/song.mp3"), false);
  assert.equal(P.assertStreamPathContained("https://a.test/dav", "https://a.test/secret.mp3"), false);
  assert.equal(P.assertStreamPathContained("https://a.test/dav", "https://evil.test/dav/song.mp3"), false);
  assert.equal(P.assertStreamPathContained("https://a.test/dav", "not a url"), false);
  assert.equal(P.assertStreamPathContained("not a url", "https://a.test/dav/s.mp3"), false);
  assert.equal(P.assertStreamPathContained("https://a.test", "https://a.test/whatever/deep.flac"), true);
});

test("resolveWebDavUrl", () => {
  assert.equal(P.resolveWebDavUrl("https://a.test/dav/", "song.mp3"), "https://a.test/dav/song.mp3");
  assert.equal(P.resolveWebDavUrl("https://a.test/dav", "song.mp3"), "https://a.test/dav/song.mp3");
  assert.equal(P.resolveWebDavUrl("https://a.test/dav/", "Alpha - One.mp3"), "https://a.test/dav/Alpha%20-%20One.mp3");
  assert.equal(P.resolveWebDavUrl("https://a.test/dav/", "a%20b.mp3"), "https://a.test/dav/a%20b.mp3");
  assert.equal(P.resolveWebDavUrl("https://a.test/dav/", "/dav/song.mp3"), "https://a.test/dav/song.mp3");
  assert.equal(P.resolveWebDavUrl("https://a.test/dav/", "/other/song.mp3"), "https://a.test/dav/other/song.mp3");
  assert.equal(P.resolveWebDavUrl("https://a.test", "song.mp3"), "https://a.test/song.mp3");
  assert.equal(P.resolveWebDavUrl("https://a.test/", "sub/dir/song.mp3"), "https://a.test/sub/dir/song.mp3");
  assert.equal(P.resolveWebDavUrl("https://a.test/dav", "%zz.mp3"), "https://a.test/dav/%25zz.mp3");
  assert.equal(P.resolveWebDavUrl("https://a.test/dav/", "中文歌曲.mp3"), "https://a.test/dav/" + encodeURI("中文歌曲.mp3"));
});

test("hashAdminPass: SHA-256 golden hex (Node WebCrypto parity)", async () => {
  assert.equal(await P.hashAdminPass("hunter22"), ADMIN_HASH);
  assert.equal(
    await P.hashAdminPass(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  assert.match(await P.hashAdminPass("x"), /^[0-9a-f]{64}$/);
});

test("createSession / isSessionValid against memory KV", async () => {
  const unfreeze = freezeClock();
  try {
    const kv = createKV();
    const env = { MUSIC_KV: kv };
    const token = await P.createSession(env);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.ok(kv.__store.has("session_" + token));
    const put = kv.__puts.find((p) => p.key === "session_" + token);
    assert.deepEqual(put.opts, { expirationTtl: 2592000 });
    assert.deepEqual(JSON.parse(put.value), { created: 1700000000000 });
    assert.equal(await P.isSessionValid(env, token), true);
    assert.equal(await P.isSessionValid(env, "a".repeat(64)), false);
    assert.equal(await P.isSessionValid(env, null), false);
    assert.equal(await P.isSessionValid(env, undefined), false);
  } finally {
    unfreeze();
  }
});

test("generateDiagnostic: branch table", () => {
  const unfreeze = freezeClock();
  try {
    const d = P.generateDiagnostic(403, "Forbidden", "https://a.test/dav/", "PROPFIND", "源A");
    assert.equal(d.title, "源【源A】访问受限 (403 Forbidden)");
    assert.equal(d.status, 403);
    assert.equal(d.statusText, "Forbidden");
    assert.equal(d.method, "PROPFIND");
    assert.equal(d.targetUrl, "https://a.test/dav/");
    assert.equal(d.contentType, "");
    assert.equal(d.bodyPreview, "");
    assert.equal(typeof d.timestamp, "string");
    assert.equal(P.generateDiagnostic(0, "", "u", "GET", "s").title, "源【s】连接失败 (无法连通)");
    assert.equal(P.generateDiagnostic(0, "", "u", "GET", "s").status, 0);
    assert.equal(P.generateDiagnostic(0, "", "u", "GET", "s").statusText, "Unknown");
    assert.ok(P.generateDiagnostic(0, "boom", "u", "GET", "s").cause.includes("目标主机: boom"));
    assert.equal(
      P.generateDiagnostic(403, "x", "u", "PROPFIND", "s", WAF_403_BODY).title,
      "源【s】触发了网盘服务端的临时 IP 频控拦截 (403 WAF)"
    );
    assert.equal(
      P.generateDiagnostic(403, "x", "u", "PROPFIND", "s", "blocked by security system").title,
      "源【s】触发了网盘服务端的临时 IP 频控拦截 (403 WAF)"
    );
    assert.equal(
      P.generateDiagnostic(200, "OK", "u", "PROPFIND", "s", "", "text/html; charset=utf-8").title,
      "源【s】端点返回了网页而非 WebDAV"
    );
    assert.equal(P.generateDiagnostic(401, "x", "u", "GET", "s").title, "源【s】认证失败 (401 Unauthorized)");
    assert.equal(P.generateDiagnostic(404, "x", "u", "GET", "s").title, "源【s】目标不存在 (404 Not Found)");
    assert.equal(P.generateDiagnostic(405, "x", "u", "PROPFIND", "s").title, "源【s】方法不被支持 (405 Method Not Allowed)");
    assert.equal(P.generateDiagnostic(502, "x", "u", "GET", "s").title, "源【s】连接失败 (无法连通)");
    assert.equal(P.generateDiagnostic(500, "x", "u", "GET", "s").title, "源【s】连接失败 (无法连通)");
    const long = P.generateDiagnostic(404, "x", "u", "GET", "s", "x".repeat(500));
    assert.equal(long.bodyPreview.length, 300);
    assert.equal(P.generateDiagnostic(418, "x", "u", "GET", "s").title, "源【s】响应异常");
    assert.equal(P.generateDiagnostic(404, "x", "u", "GET", "s").cause, "请求的路径在 WebDAV 服务器上未找到。目标 URL: u");
  } finally {
    unfreeze();
  }
});

test("streamPathReject: guest vs admin", async () => {
  const unfreeze = freezeClock();
  try {
    const guest = P.streamPathReject("https://a.test/x.mp3", "GET", "源A", { "Access-Control-Allow-Origin": "*" }, false);
    assert.equal(guest.status, 403);
    const gj = await guest.json();
    assert.deepEqual(gj, { error: "访问被拒绝", diagnostic: null });
    assert.equal(guest.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(guest.headers.get("Content-Type"), "application/json; charset=utf-8");

    const admin = P.streamPathReject("https://a.test/x.mp3", "GET", "源A", {}, true);
    assert.equal(admin.status, 403);
    const aj = await admin.json();
    assert.equal(aj.error, "访问被拒绝：路径校验未通过");
    assert.equal(aj.diagnostic.status, 403);
    assert.equal(aj.diagnostic.statusText, "Path validation rejected");
    assert.equal(aj.diagnostic.targetUrl, "https://a.test/x.mp3");
    assert.equal(typeof aj.diagnostic.timestamp, "string");
  } finally {
    unfreeze();
  }
});

test("fetchWebDavList: parse + decode + audio filter", async () => {
  const stub = installStubFetch(() => davResponse(PROPFIND_A)());
  try {
    const res = await P.fetchWebDavList(SOURCE_A);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, "https://dav.example.com/dav/");
    assert.equal(stub.calls[0].method, "PROPFIND");
    assert.equal(stub.calls[0].headers.authorization, BASIC_A);
    assert.equal(stub.calls[0].headers.depth, "1");
    assert.deepEqual(res.items, [
      { name: "Alpha - One.mp3", href: "/dav/Alpha%20-%20One.mp3" },
      { name: "Beta & Band - Two.flac", href: "/dav/Beta%20&%20Band%20-%20Two.flac" },
    ]);
    assert.equal(res.diagnostic, null);
    assert.equal(res.debug.status, 207);
    assert.equal(res.debug.allHrefsCount, 3);
    assert.equal(res.debug.rawLength, PROPFIND_A.length);
    assert.equal(res.debug.rawPreview, PROPFIND_A.slice(0, 300));
  } finally {
    stub.restore();
  }
});

test("fetchWebDavList: prefixed namespace + href fallback name", async () => {
  const stub = installStubFetch(() => davResponse(PROPFIND_B)());
  try {
    const res = await P.fetchWebDavList({ id: "b", name: "源B", url: "https://dav.example.net/dav" });
    assert.deepEqual(res.items, [
      { name: "Alpha - One.mp3", href: "/dwb/Alpha - One.mp3" },
      { name: "Gamma <live>.m4a", href: "/dwb/Gamma%20<live>.m4a" },
    ]);
  } finally {
    stub.restore();
  }
});

test("fetchWebDavList: empty / non-audio / waf / html / network-throw", async () => {
  let stub = installStubFetch(() => davResponse(PROPFIND_ONLY_DIR)());
  try {
    const res = await P.fetchWebDavList(SOURCE_ERR);
    assert.deepEqual(res.items, []);
    assert.equal(res.diagnostic.title, "源【坏源】未发现音频单曲");
    assert.ok(res.diagnostic.cause.includes("未扫描到任何已知音频格式"));
    assert.equal(stub.calls[0].url, "https://err.example.com/dav/");
    assert.equal(stub.calls[0].headers.authorization, undefined);
  } finally {
    stub.restore();
  }

  stub = installStubFetch(() => davResponse(PROPFIND_NON_AUDIO)());
  try {
    const res = await P.fetchWebDavList(SOURCE_ERR);
    assert.deepEqual(res.items, []);
    assert.ok(res.diagnostic.cause.includes("全部是文件夹或非音频扩展名"));
  } finally {
    stub.restore();
  }

  stub = installStubFetch(() =>
    new Response(WAF_403_BODY, { status: 403, statusText: "Forbidden", headers: { "content-type": "text/plain" } })
  );
  try {
    const res = await P.fetchWebDavList(SOURCE_ERR);
    assert.deepEqual(res.items, []);
    assert.ok(res.diagnostic.title.includes("403 WAF"));
    assert.equal(res.debug.allHrefsCount, 0);
  } finally {
    stub.restore();
  }

  stub = installStubFetch(() =>
    new Response(HTML_LOGIN_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
  );
  try {
    const res = await P.fetchWebDavList(SOURCE_ERR);
    assert.ok(res.diagnostic.title.includes("端点返回了网页而非 WebDAV"));
  } finally {
    stub.restore();
  }

  stub = installStubFetch(() => {
    throw new Error("connect ECONNREFUSED");
  });
  try {
    const res = await P.fetchWebDavList(SOURCE_ERR);
    assert.deepEqual(res.items, []);
    assert.equal(res.diagnostic.status, 0);
    assert.equal(res.diagnostic.statusText, "connect ECONNREFUSED");
    assert.equal(res.debug.rawPreview, "");
  } finally {
    stub.restore();
  }
});

test("D-2 fetchWebDavList: a hung PROPFIND is aborted into a status-0 diagnostic, never an infinite wait", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => new Promise((resolve, reject) => {
    const sig = init && init.signal;
    if (sig) { if (sig.aborted) return reject(sig.reason); sig.addEventListener("abort", () => reject(sig.reason)); }
    // else hang forever
  });
  try {
    const guard = new Promise((_, rej) => setTimeout(() => rej(new Error("guard: fetchWebDavList hung past 3s")), 3000));
    const res = await Promise.race([
      P.fetchWebDavList({ id: "x", name: "挂起源", url: "https://hang.example.com/dav/" }, { STREAM_FETCH_TIMEOUT_MS: "500" }),
      guard,
    ]);
    assert.equal(res.debug.status, 0, "a PROPFIND timeout must surface as a status-0 diagnostic result, not throw/hang");
    assert.ok(res.diagnostic, "the timeout must produce a diagnostic");
    assert.deepEqual(res.items, [], "a timed-out listing yields no items");
  } finally { globalThis.fetch = prevFetch; }
});

test("server escapeHtmlText null-guard differs from client escapeHtml by design (no unify)", () => {
  assert.equal(P.escapeHtmlText(null), "");
  const html = P.renderHTML();
  assert.ok(html.includes("function escapeHtml(s) {"));
  assert.ok(!html.includes("function escapeHtmlText("), "server-only helper must not leak into template");
});

test("shareTitleText: artist - title with brand suffix", () => {
  assert.equal(P.shareTitleText("Artist - Title.mp3", "站点"), "Artist - Title | 站点");
  assert.equal(P.shareTitleText("Single.mp3", ""), "Single | Cloud Music Hub");
  assert.equal(P.shareTitleText(null, "站点"), " | 站点");
});

test("parseSingleByteRange: single ranges parsed with suffix slot; suffix ranges parsed; malformed rejected", () => {
  assert.deepEqual(P.parseSingleByteRange("bytes=0-"), { start: 0, end: null, suffix: null });
  assert.deepEqual(P.parseSingleByteRange("bytes=100-199"), { start: 100, end: 199, suffix: null });
  assert.deepEqual(P.parseSingleByteRange(" bytes=5-5 "), { start: 5, end: 5, suffix: null });
  assert.deepEqual(P.parseSingleByteRange("bytes=-500"), { start: null, end: null, suffix: 500 });
  assert.deepEqual(P.parseSingleByteRange("bytes=-1"), { start: null, end: null, suffix: 1 });
  assert.equal(P.parseSingleByteRange("bytes=-0"), null);
  assert.equal(P.parseSingleByteRange("bytes=-"), null);
  assert.equal(P.parseSingleByteRange("bytes=0-1,5-9"), null);
  assert.equal(P.parseSingleByteRange("bytes=abc"), null);
  assert.equal(P.parseSingleByteRange("bytes=9-3"), null);
  assert.equal(P.parseSingleByteRange(""), null);
  assert.equal(P.parseSingleByteRange(null), null);
  assert.equal(P.parseSingleByteRange(undefined), null);
});

test("audioContentTypeFor: extension fallback, no guessing beyond the map", () => {
  assert.equal(P.audioContentTypeFor("Alpha - One.mp3"), "audio/mpeg");
  assert.equal(P.audioContentTypeFor("Dir/Sub/X.FLAC"), "audio/flac");
  assert.equal(P.audioContentTypeFor("song.m4a"), "audio/mp4");
  assert.equal(P.audioContentTypeFor("song.dsf"), "audio/x-dsf");
  assert.equal(P.audioContentTypeFor("song.dff"), "audio/x-dff");
  assert.equal(P.audioContentTypeFor("no-extension"), null);
  assert.equal(P.audioContentTypeFor("trailing."), null);
  assert.equal(P.audioContentTypeFor(".mp3"), "audio/mpeg");
  assert.equal(P.audioContentTypeFor("song.txt"), null);
  assert.equal(P.audioContentTypeFor(""), null);
  assert.equal(P.audioContentTypeFor(null), null);
});

test("sliceReadableStream: exact prefix skip, exact count, early cancel", async () => {
  const source = (chunks) =>
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new Uint8Array(c));
        controller.close();
      },
    });
  const a = await new Response(P.sliceReadableStream(source([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]), 3, 4)).arrayBuffer();
  assert.deepEqual(Array.from(new Uint8Array(a)), [3, 4, 5, 6]);
  await assert.rejects(async () => {
    await new Response(P.sliceReadableStream(source([[1, 2, 3]]), 0, 99)).arrayBuffer();
  }, "a body shorter than the declared count must error out, never resolve short");
  const c = await new Response(P.sliceReadableStream(source([[1], [2], [3], [4]]), 1, 2)).arrayBuffer();
  assert.deepEqual(Array.from(new Uint8Array(c)), [2, 3]);
  assert.equal(P.sliceReadableStream(null, 0, 5), null);
  assert.equal(P.sliceReadableStream(source([[9]]), 0, 0), null);
});

test("sliceReadableStream coalescing: 1KB chunks coalesce into a single output chunk for a 4KB slice", async () => {
  const KB = 1024;
  const mk = (n, fill) => new Uint8Array(n).fill(fill);
  const streamOf = (chunks) => new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } });
  const readChunks = async (stream) => {
    const out = [];
    const r = stream.getReader();
    for (;;) {
      const res = await r.read();
      if (res.done) return out;
      out.push(res.value);
    }
  };
  const agg = await readChunks(P.sliceReadableStream(streamOf([mk(KB, 1), mk(KB, 2), mk(KB, 3), mk(KB, 4)]), 0, KB * 4));
  assert.equal(agg.length, 1, "J1: four 1KB chunks must flush once when count is met");
  assert.deepEqual(Array.from(agg[0].slice(0, 4)), [1, 1, 1, 1], "byte order preserved across buffered chunks");
  const bigPass = await readChunks(P.sliceReadableStream(streamOf([mk(KB * 256, 7)]), 0, KB * 256));
  assert.equal(bigPass.length, 1, "J1: a chunk at/above FLUSH_BYTES passes through in one piece");
  assert.equal(bigPass[0].every((b) => b === 7), true);
  const mixed = await readChunks(P.sliceReadableStream(streamOf([mk(2, 1), mk(KB * 256, 2)]), 0, KB * 256 + 2));
  assert.equal(mixed.length, 2, "J1: pending small chunk flushes before the big chunk, order preserved");
  assert.equal(mixed[0].byteLength, 2);
  assert.equal(mixed[1].byteLength, KB * 256);
  const emptyIn = await readChunks(P.sliceReadableStream(streamOf([mk(KB, 1), new Uint8Array(0), mk(KB, 3), new Uint8Array(0)]), 0, KB * 2));
  assert.equal(emptyIn.length, 1, "J1: zero-byte chunks never produce standalone output pieces");
  assert.equal(emptyIn[0].byteLength, KB * 2);
  const skipCross = await readChunks(P.sliceReadableStream(streamOf([mk(2, 9), mk(2, 8), mk(6, 7)]), 5, 3));
  assert.equal(skipCross.length, 1);
  assert.deepEqual(Array.from(skipCross[0]), [7, 7, 7], "J1: skipped bytes must never leak into the coalesce buffer");
  const one = await readChunks(P.sliceReadableStream(streamOf([mk(KB, 5)]), 0, 1));
  assert.equal(one.length, 1, "J1: count=1 emits exactly one byte-chunk");
  assert.equal(one[0].byteLength, 1);
  const exactFill = await readChunks(P.sliceReadableStream(streamOf([mk(2, 1), mk(2, 2)]), 0, 4));
  assert.equal(exactFill.length, 1, "J1: upstream done exactly at count closes after one flush, never errors");
  await assert.rejects(async () => {
    await readChunks(P.sliceReadableStream(streamOf([mk(2, 1), mk(2, 2)]), 0, 5));
  }, /ended after 4 of 5/, "A2: the error message keeps the received-so-far accounting");
  let fedBytes = 0;
  let idx = 0;
  const longSource = new ReadableStream({
    pull(c) {
      if (idx >= 300) { c.close(); return; }
      idx += 1; fedBytes += 1024; c.enqueue(mk(1024, 3));
    }
  });
  const smallCount = await readChunks(P.sliceReadableStream(longSource, 0, 1000));
  assert.ok(smallCount.reduce((n, ch) => n + ch.byteLength, 0) >= 1000, "J1: the requested bytes must be delivered");
  assert.ok(fedBytes < 300 * 1024, "J1-生死线: a 1000-byte slice must cancel the long source early, fed " + fedBytes);
  let fed2 = 0;
  let idx2 = 0;
  const midSource = new ReadableStream({
    pull(c) {
      if (idx2 >= 70) { c.close(); return; }
      idx2 += 1; fed2 += 1024; c.enqueue(mk(1024, 9));
    }
  });
  const midReader = P.sliceReadableStream(midSource, 0, 70000).getReader();
  const first = await midReader.read();
  assert.equal(first.value.byteLength, 32768, "J1: the first output piece is capped at FLUSH_BYTES");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fed2 <= 66 * 1024, "J1: after delivering a piece the pull must yield — reads may run at most one hwm-prefilled piece ahead, never drain the source: fed " + fed2);
  const pieces = [first.value];
  for (;;) {
    const res = await midReader.read();
    if (res.done) break;
    assert.ok(res.value.byteLength <= 32768, "J1: every coalesced piece stays capped at FLUSH_BYTES");
    pieces.push(res.value);
  }
  let midTotal = 0;
  for (const ch of pieces) midTotal += ch.byteLength;
  assert.equal(midTotal, 70000, "J1: all requested bytes delivered across yielded pulls, byte sum preserved");
});

test("normalizeShareIndexPairs: dedup to newest, validates id/name, keeps the head 20000", () => {
  const pairs = P.normalizeShareIndexPairs([
    { id: "aaaaaaaa", name: "A" },
    { id: "bbbbbbbb", name: "B" },
    { id: "cccccccc", name: "C" },
    { id: "aaaaaaaa", name: "A2" },
  ]);
  assert.deepEqual(pairs, [["bbbbbbbb", "B"], ["cccccccc", "C"], ["aaaaaaaa", "A2"]]);
  assert.deepEqual(P.normalizeShareIndexPairs(null), []);
  assert.deepEqual(P.normalizeShareIndexPairs("garbage"), []);
  assert.deepEqual(
    P.normalizeShareIndexPairs([{ id: "not-hex", name: "X" }, { id: "deadbeef" }, { id: "deadbeef", name: "" }, { id: "deadbeef", name: 123 }, null]),
    []
  );
  const many = [];
  for (let i = 0; i < 20000 + 500; i++) {
    many.push({ id: i.toString(16).padStart(8, "0"), name: "N" + i });
  }
  const capped = P.normalizeShareIndexPairs(many);
  assert.equal(capped.length, 20000);
  assert.deepEqual(capped[0], ["00000000", "N0"]);
  assert.deepEqual(capped[19999], ["00004e1f", "N19999"]);
  assert.equal(P.normalizeShareIndexPairs([{ id: "deadbeef", name: "x".repeat(500) }])[0][1].length, 300);
});

test("shareIndexSourceKey: whitelisted key namespace or null", () => {
  assert.equal(P.shareIndexSourceKey("a"), "share_meta_index_v1_a");
  assert.equal(P.shareIndexSourceKey("ab12-CD_9"), "share_meta_index_v1_ab12-CD_9");
  assert.equal(P.shareIndexSourceKey("a/../b c"), "share_meta_index_v1_abc");
  assert.equal(P.shareIndexSourceKey(""), null);
  assert.equal(P.shareIndexSourceKey("///"), null);
  assert.equal(P.shareIndexSourceKey(null), null);
});

test("pickShareIndexName: only non-empty string names resolve", () => {
  const index = [["a1b2c3d4", "Artist - Title.mp3"], ["00000000", ""]];
  assert.equal(P.pickShareIndexName(index, "a1b2c3d4"), "Artist - Title.mp3");
  assert.equal(P.pickShareIndexName(index, "00000000"), null);
  assert.equal(P.pickShareIndexName(index, "deadbeef"), null);
  assert.equal(P.pickShareIndexName(null, "a1b2c3d4"), null);
  assert.equal(P.pickShareIndexName("garbage", "a1b2c3d4"), null);
});

test("og icon asset: embedded PNG decodes to the frozen 512x512 golden bytes", () => {
  const bytes = Buffer.from(P.OG_ICON_PNG_B64, "base64");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), 512);
  assert.equal(bytes.readUInt32BE(20), 512);
  assert.equal(bytes[24], 8, "bit depth");
  assert.equal(bytes[25], 6, "RGBA color type");
  assert.equal(bytes.subarray(bytes.length - 12).toString("hex"), "0000000049454e44ae426082");
  const decoded = P.decodeOgIconPng();
  assert.equal(decoded.length, bytes.length);
  assert.equal(decoded[0], 137);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "3cdfb30483b96f7e9d9bdf59aee66a1723f2a446a8014de12b95f64564ae426d"
  );
  assert.ok(P.OG_ICON_SVG.startsWith("<svg "), "svg twin must be a bare svg element");
  assert.ok(P.OG_ICON_SVG.endsWith("</svg>"));
  assert.ok(P.OG_ICON_SVG.includes("#1ed760"));
});

test("buildShareHeadHtml: name that degrades to no title keeps the static icon, never a 404 cover url", () => {
  const degraded = P.buildShareHeadHtml("https://app.example.com/?play=a1b2c3d4", "   .mp3", "站点", "a1b2c3d4");
  assert.ok(degraded.includes('<meta property="og:image" content="https://app.example.com/og-icon.png">'), "caller must fall back to the static icon");
});

test("buildShareHeadHtml: song card keeps the raster alt on the site brand", () => {
  const noArtist = P.buildShareHeadHtml("https://app.example.com/?play=a1b2c3d4", "純歌名.mp3", "站点", "a1b2c3d4");
  assert.ok(noArtist.includes('<meta property="og:image:alt" content="站点">'), "alt stays on the site brand, not the bare title");
  assert.ok(noArtist.includes('<meta name="twitter:image:alt" content="站点">'));
});

test("fixtures: RANGE_BODY_500 is the 500-byte positional probe body", () => {
  assert.equal(RANGE_BODY_500.length, 500);
  assert.equal(RANGE_BODY_500.slice(0, 10), "0123456789");
  assert.equal(RANGE_BODY_500.slice(100, 110), "0123456789");
});

test("record tool: golden baseline must be an object mapping, never a bare array or scalar", () => {
  assert.deepEqual(parseGoldenRecord('{"stream-ok":{"status":200}}'), { "stream-ok": { status: 200 } }, "a valid object baseline parses through");
  for (const bad of ["[]", "[1,2]", "5", '"x"', "true", "false", "null"]) {
    assert.throws(() => parseGoldenRecord(bad), /top-level value is/, "non-object baseline " + JSON.stringify(bad) + " must be rejected");
  }
  assert.throws(() => parseGoldenRecord("{ not json"), SyntaxError, "malformed JSON still surfaces as a parse error");
  for (const protoKey of ['{"__proto__":5}', '{"__proto__":{"x":1},"valid":1}']) {
    assert.throws(() => parseGoldenRecord(protoKey), /__proto__/, "own __proto__ key must be rejected: " + protoKey);
  }
  for (const badValue of ['{"stream-ok":null}', '{"stream-ok":[]}', '{"stream-ok":42}', '{"stream-ok":"x"}', '{"stream-ok":true}']) {
    assert.throws(() => parseGoldenRecord(badValue), /scenario record/, "partially corrupted baseline must be rejected: " + badValue);
  }
});

test("record tool: freshness is byte-identity, never mtime", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const src = readFileSync(join(root, "test", "tools", "record.mjs"), "utf8");
  assert.ok(src.includes("Buffer.compare(stitched, built)"), "recorder must compare the concatenated src bytes with the artifact");
  assert.ok(!src.includes("mtimeMs"), "recorder must not judge freshness by clock metadata");
});

test("build.mjs --verify-staged audits the git index, not only the working tree", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const src = readFileSync(join(root, "build.mjs"), "utf8");
  assert.ok(src.includes("if (VERIFY_STAGED) {"), "verify-staged branch must exist");
  assert.ok(src.includes('["ls-files", "--cached", "-z", "--", "src"]'), "verify-staged must enumerate the staged src/*.part.js set via git ls-files");
  assert.ok(src.includes('["show", ":" + name]'), "verify-staged must read and compare each staged blob via git show :<path>");
});

test("parseContentRangeTotal: derives the full length from a Content-Range value", () => {
  assert.equal(P.parseContentRangeTotal("bytes 0-0/9245049"), 9245049, "206 head probe: total after the slash, never the slice length");
  assert.equal(P.parseContentRangeTotal("bytes 497-499/500"), 500);
  assert.equal(P.parseContentRangeTotal("bytes */0"), 0, "empty file measured exactly at the boundary is 0, distinct from invalid");
  assert.equal(P.parseContentRangeTotal("bytes */500"), 500, "a 416 passthrough still carries the total");
  assert.equal(P.parseContentRangeTotal("bytes 10-19/500   "), 500, "trailing whitespace tolerated");
  assert.equal(P.parseContentRangeTotal("bytes 0-0/ 500"), 500, "whitespace after the slash tolerated");
  assert.equal(P.parseContentRangeTotal(null), null, "missing header degrades to null so the library falls back to a GET size probe");
  assert.equal(P.parseContentRangeTotal(""), null);
  assert.equal(P.parseContentRangeTotal("bytes 0-0/*"), null, "open-ended total is not a number");
  assert.equal(P.parseContentRangeTotal("bytes 0-0/512x512"), null, "trailing non-digits are not silently truncated");
  assert.equal(P.parseContentRangeTotal("bytes 0-19"), null, "no slash means no total");
});

test("parseUpstreamTimeoutMs: degenerate env knob values never yield NaN or sub-500ms timers", () => {
  assert.equal(P.parseUpstreamTimeoutMs(undefined), 8000, "S-1: missing knob falls back to default");
  assert.equal(P.parseUpstreamTimeoutMs(null), 8000, "S-1: null falls back");
  assert.equal(P.parseUpstreamTimeoutMs("abc"), 8000, "S-1: non-numeric string must NEVER become NaN");
  assert.equal(P.parseUpstreamTimeoutMs("0"), 8000, "S-1: zero is not a valid timeout");
  assert.equal(P.parseUpstreamTimeoutMs("-5"), 8000, "S-1: negative is not a valid timeout");
  assert.equal(P.parseUpstreamTimeoutMs({}), 8000, "S-1: object falls back");
  assert.equal(P.parseUpstreamTimeoutMs("20"), 500, "S-1: sub-floor values clamp up to 500ms");
  assert.equal(P.parseUpstreamTimeoutMs(7000), 7000, "S-1: in-range number passes through");
  assert.equal(P.parseUpstreamTimeoutMs("7000"), 7000, "S-1: numeric string parses");
  assert.equal(P.parseUpstreamTimeoutMs(1e9), 300000, "S-1: huge values clamp to the 300s ceiling");
});

// ---- D-8 属性/变异测试辅助（零依赖，自包含；只读 src，不改任何被测函数） ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SRC06 = readFileSync(join(process.cwd(), "src", "06-webdav.part.js"), "utf8");
function extractFnSource(name) {
  const start = SRC06.indexOf("function " + name + "(");
  assert.notEqual(start, -1, "extractFnSource: function " + name + " must exist in src/06");
  const braceOpen = SRC06.indexOf("{", SRC06.indexOf(")", start));
  assert.notEqual(braceOpen, -1, "extractFnSource: body-open for " + name);
  let depth = 0, i = braceOpen;
  for (; i < SRC06.length; i++) {
    const c = SRC06[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return SRC06.slice(start, i);
}
function evalHandle(fnText) {
  return new Function(src06ScopeDeps() + "return " + fnText)();
}
function src06ScopeDeps() {
  const constLine = /^const SEGMENT_PART_SIZE_MAX = \d+;$/m.exec(SRC06);
  assert.ok(constLine, "evalHandle: src/06 must keep one top-level SEGMENT_PART_SIZE_MAX declaration to inject into the isolated eval scope");
  const retryConst = /^const SEGMENT_RETRY_BASE_MS = \d+;$/m.exec(SRC06);
  const retryDeps = retryConst ? "\n" + retryConst[0] + "\n" + extractFnSource("segmentRetryDelayMs") : "";
  return constLine[0] + "\n" + extractFnSource("parseUpstreamTimeoutMs") + retryDeps + "\n";
}
function sourceOf(chunks) {
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); c.close(); } });
}
async function collectSlices(stream) {
  const reader = stream.getReader();
  const pieces = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pieces.push(value);
  }
  return pieces;
}
function randParts(rng, total) {
  const parts = [];
  let i = 0;
  while (i < total) {
    const len = Math.min(total - i, 1 + Math.floor(rng() * 700));
    parts.push(len);
    i += len;
  }
  return parts;
}

// INV-A/B/C：字节守恒 + 确定性 + 缓冲上界，跨随机切分 × 随机 start/count
test("D-8 INV-A/B/C sliceReadableStream: conservation, determinism, flush-bound hold across randomized chunking", async () => {
  const FLUSH = 32768; // 契约：src/06:142 合并界（与既有 test/01:455/462 同源），非抄实跑输出
  const rng = mulberry32(0x9E3779B9);
  const slice = evalHandle(extractFnSource("sliceReadableStream"));
  for (let round = 0; round < 64; round++) {
    const total = 1 + Math.floor(rng() * 5000);
    const bytes = [];
    for (let k = 0; k < total; k++) bytes.push((k * 131 + round * 17) & 0xff);
    const lens = randParts(rng, total);
    const chunks = [];
    let off = 0;
    for (const L of lens) { chunks.push(bytes.slice(off, off + L)); off += L; }
    const start = Math.floor(rng() * total);
    const maxCount = total - start;
    const count = 1 + Math.floor(rng() * maxCount); // 满额区间：start+count<=total
    const p1 = await collectSlices(slice(sourceOf(chunks), start, count));
    const p2 = await collectSlices(slice(sourceOf(chunks), start, count)); // INV-B 确定性
    const flat1 = [].concat(...p1.map((a) => Array.from(a)));
    const flat2 = [].concat(...p2.map((a) => Array.from(a)));
    assert.deepEqual(flat1, bytes.slice(start, start + count), "INV-A conservation round " + round);
    assert.deepEqual(flat2, flat1, "INV-B determinism round " + round);
    for (const piece of p1) assert.ok(piece.byteLength <= FLUSH, "INV-C flush-bound round " + round); // INV-C
  }
  // INV-A 短读：start+count>total 必 error（含 start>=total 退化）
  for (let round = 0; round < 16; round++) {
    const total = 1 + Math.floor(rng() * 2000);
    const bytes = [];
    for (let k = 0; k < total; k++) bytes.push(k & 0xff);
    const chunks = [];
    let off = 0;
    for (const L of randParts(rng, total)) { chunks.push(bytes.slice(off, off + L)); off += L; }
    const start = Math.floor(rng() * (total + 50)); // 可越界
    const count = 1 + Math.floor(rng() * 300);
    if (start + count <= total) continue;
    await assert.rejects(
      () => new Response(slice(sourceOf(chunks), start, count)).arrayBuffer(),
      /ended after \d+ of \d+/,
      "INV-A short-read must hard-error round " + round
    );
  }
});

// INV-D：parseSingleByteRange 全域形状 + 永不抛
test("D-8 INV-D parseSingleByteRange: total function, only legal shapes, illegal inputs null", () => {
  const parse = evalHandle(extractFnSource("parseSingleByteRange"));
  const illegal = [
    "0-10", "items=0-1", "BYTES=0-1", "bytes=9-3", "bytes=-0", "bytes=-", "bytes=0-1,5-6",
    "bytes=a-b", "bytes=", "bytes=-abc", "  ", "", null, undefined, 0, 123, {}, [], true,
    "bytes=Infinity-", "bytes=-Infinity", "bytes=0-1 , 2-3",
  ];
  for (const v of illegal) {
    let r;
    assert.doesNotThrow(() => { r = parse(v); }, "INV-D never throws for " + JSON.stringify(v));
    assert.equal(r, null, "INV-D illegal must be null: " + JSON.stringify(v));
  }
  const legal = ["bytes=0-10", "bytes=5-", "bytes=-100", "bytes=10-10", " bytes=7-9 ", "bytes=0-0"];
  for (const v of legal) {
    const r = parse(v);
    assert.notEqual(r, null, "INV-D legal must parse: " + v);
    const keys = ["start", "end", "suffix"];
    const setCount = keys.filter((k) => r[k] !== null && r[k] !== undefined).length;
    if (r.suffix !== null) { // 后缀形：start/end 必 null，suffix>=1
      assert.equal(r.start, null, "suffix-form start null: " + v);
      assert.equal(r.end, null, "suffix-form end null: " + v);
      assert.ok(r.suffix >= 1, "suffix>=1: " + v);
    } else {
      assert.ok(r.start >= 0 && Number.isInteger(r.start), "start>=0 int: " + v);
      if (r.end !== null) assert.ok(r.end >= r.start, "end>=start: " + v);
    }
    assert.ok(setCount <= 2, "shape mutex (at most start+end or just suffix): " + v);
  }
});

// INV-M：变异负控——每个缺陷变异必让对应正属性"翻红"，证明上述断言 load-bearing
test("D-8 INV-M: injected defects flip the positive properties red (anti-green-wash)", async () => {
  const sliceText = extractFnSource("sliceReadableStream");
  const parseText = extractFnSource("parseSingleByteRange");

  // M-parse-1: end<start 守卫失效 → bytes=9-3 不该解析成功
  {
    assert.ok(parseText.includes("end < start"), "M-parse-1 needle before mutation");
    const m = parseText.replace("if (!isFinite(end) || end < start) return null;",
      "if (!isFinite(end)) return null;");
    assert.ok(m.includes("if (!isFinite(end)) return null;"), "M-parse-1 mutation applied");
    const p = evalHandle(m);
    assert.notEqual(p("bytes=9-3"), null, "M-parse-1: guard stripped must let the illegal range through (load-bearing proof)");
  }
  // M-parse-2: suffix<=0 守卫失效 → bytes=-0 不该解析成功
  {
    assert.ok(parseText.includes("suffix <= 0"), "M-parse-2 needle before mutation");
    const m = parseText.replace("if (!isFinite(suffix) || suffix <= 0) return null;",
      "if (!isFinite(suffix)) return null;");
    const p = evalHandle(m);
    assert.notEqual(p("bytes=-0"), null, "M-parse-2: suffix-zero guard is load-bearing");
  }
  // M-parse-3: 多段被误判 → 把单段正则的尾段放宽允许逗号（探针 bytes=0-1,5：真实现仍拒绝，变异体匹配 "1,5"）
  {
    const needle = "const match = /^bytes=(\\d+)-(\\d*)$/.exec(trimmed);";
    assert.ok(parseText.includes(needle), "M-parse-3 needle before mutation");
    const m = parseText.replace(needle, "const match = /^bytes=(\\d+)-([\\d,]*)$/.exec(trimmed);");
    const p = evalHandle(m);
    assert.notEqual(p("bytes=0-1,5"), null, "M-parse-3: multi-range rejection is load-bearing");
  }
  // M-slice-1: 尾截断缺失 → 产出超 count，守恒破
  {
    assert.ok(sliceText.includes("value.subarray(0, count - sent)"), "M-slice-1 needle before mutation");
    const m = sliceText.replace("value = value.subarray(0, count - sent);", "value = value;");
    const s = evalHandle(m);
    const out = await collectSlices(s(sourceOf([[1, 2, 3, 4, 5, 6, 7, 8]]), 0, 3));
    assert.notDeepEqual([].concat(...out.map((a) => Array.from(a))), [1, 2, 3], "M-slice-1: truncation is load-bearing (output must overshoot)");
  }
  // M-slice-2: 跳过记账错 → 命中"整块跳过"分支（start=4 落在第 2 块）：变异体 skip 只记 1 字节 → 欠账多跳 → 短读 error 或错位产出，二者皆非 [4,5]
  {
    assert.ok(sliceText.includes("skipped += value.byteLength;"), "M-slice-2 needle before mutation");
    const m = sliceText.replace("skipped += value.byteLength;", "skipped += 1;");
    const s = evalHandle(m);
    const got = await collectSlices(s(sourceOf([[0, 1, 2, 3], [4, 5, 6, 7]]), 4, 2)).then(
      (pieces) => [].concat(...pieces.map((a) => Array.from(a))),
      () => null // 变异体翻红形态 A：短读 error
    );
    assert.notDeepEqual(got, [4, 5], "M-slice-2: skip accounting is load-bearing (mutant must not emit the correct slice)");
  }
  // M-slice-3: 短读静默 close → 应 error 却静默 resolve（变异体 close 时 pending 未入队，产出 < count 即证）
  {
    assert.ok(sliceText.includes('controller.error(new Error("upstream body ended after "'), "M-slice-3 needle before mutation");
    const m = sliceText.replace(
      /controller\.error\(new Error\("upstream body ended after " \+ sent \+ " of " \+ count \+ " bytes"\)\);/,
      "controller.close();");
    const s = evalHandle(m);
    const out = await new Response(s(sourceOf([[1, 2, 3]]), 0, 99)).arrayBuffer();
    assert.ok(out.byteLength < 99, "M-slice-3: short-read error is load-bearing (mutant silently resolves short, got " + out.byteLength + ")");
  }
});

// ---- D-1 三旋钮 INV-PC：parseSegmentConcurrency / parseSegmentPartSize / parseSegmentMaxSegments ----
test("D-1 INV-PC parseSegmentConcurrency: total function, FALLBACK 3, clamp 1-8", () => {
  const parse = evalHandle(extractFnSource("parseSegmentConcurrency"));
  assert.equal(parse(undefined), 3, "missing knob falls back to 3");
  assert.equal(parse(null), 3);
  assert.equal(parse("abc"), 3, "non-numeric string must never become NaN");
  assert.equal(parse("0"), 3, "zero is not a valid concurrency");
  assert.equal(parse("-1"), 3, "negative falls back");
  assert.equal(parse("3.5"), 3, "non-integer falls back");
  assert.equal(parse({}), 3);
  assert.equal(parse("1"), 1, "in-range passes through");
  assert.equal(parse(4), 4);
  assert.equal(parse("8"), 8);
  assert.equal(parse("2"), 2, "sub-floor values clamp up to 1");
  assert.equal(parse(0.5), 1, "sub-floor number clamps to 1");
  assert.equal(parse(1e9), 8, "huge values clamp to the 8 ceiling");
});

test("D-1 INV-PC parseSegmentPartSize: total function, FALLBACK 1048576, clamp 65536-8388608", () => {
  const parse = evalHandle(extractFnSource("parseSegmentPartSize"));
  assert.equal(parse(undefined), 1048576, "missing knob falls back to 1MiB");
  assert.equal(parse(null), 1048576);
  assert.equal(parse("abc"), 1048576, "non-numeric string must never become NaN");
  assert.equal(parse("0"), 1048576, "zero falls back");
  assert.equal(parse("-1"), 1048576, "negative falls back");
  assert.equal(parse("1.5"), 1048576, "non-integer falls back");
  assert.equal(parse("100"), 65536, "sub-floor clamps up to 64KiB");
  assert.equal(parse(1048576), 1048576, "in-range passes through");
  assert.equal(parse("2097152"), 2097152, "numeric string parses");
  assert.equal(parse(1e12), 8388608, "huge values clamp to the 8MiB ceiling");
});

test("D-1 INV-PC parseSegmentMaxSegments: total function, FALLBACK 16, clamp 1-64", () => {
  const parse = evalHandle(extractFnSource("parseSegmentMaxSegments"));
  assert.equal(parse(undefined), 16, "missing knob falls back to 16");
  assert.equal(parse(null), 16);
  assert.equal(parse("abc"), 16, "non-numeric string must never become NaN");
  assert.equal(parse("0"), 16, "zero falls back");
  assert.equal(parse("-1"), 16, "negative falls back");
  assert.equal(parse("2.5"), 16, "non-integer falls back");
  assert.equal(parse("1"), 1, "in-range passes through");
  assert.equal(parse(16), 16);
  assert.equal(parse("64"), 64);
  assert.equal(parse("1000"), 64, "huge values clamp to the 64 ceiling");
});

// ---- D-1 INV-AGG：aggregateSegmentedStream 属性测试（守恒/定序/取消传播/段短读硬错/206-200 混发）----
// 段 fetcher 形态：segFetch(i) 返回 { status, stream }——聚合器对每段调一次，拿到 206 响应体流。
function buildAggHarness(segments, opts = {}) {
  let calls = 0;
  const callLog = [];
  const segFetch = async (i, signal) => {
    calls++;
    callLog.push({ index: i, aborted: !!(signal && signal.aborted) });
    const seg = segments[i];
    if (!seg) throw new Error("no segment " + i);
    if (seg.fail && (opts.failUntil === undefined || calls <= opts.failUntil)) throw new Error("headers-phase failure");
    if (seg.status && seg.status !== 206) {
      return { status: seg.status, headers: seg.headers || {}, stream: seg.stream || null };
    }
    return { status: 206, headers: { "content-range": "bytes " + seg.start + "-" + seg.end + "/" + opts.total }, stream: sourceOf(seg.chunks) };
  };
  return { segFetch, callLog, callsRef: { get n() { return calls; } } };
}
function segBody(bytes, start, end) {
  return { start, end, chunks: [bytes] };
}

test("D-1 INV-AGG aggregateSegmentedStream: strict-order conservation across randomized segment counts", async () => {
  const rng = mulberry32(0xD1D1D1D1);
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  for (let round = 0; round < 32; round++) {
    const segCount = 2 + Math.floor(rng() * 5);
    const segLen = 1 + Math.floor(rng() * 300);
    const bytes = [];
    for (let k = 0; k < segCount * segLen; k++) bytes.push((k * 97 + round * 31) & 0xff);
    const segments = [];
    for (let i = 0; i < segCount; i++) {
      segments.push(segBody(bytes.slice(i * segLen, (i + 1) * segLen), i * segLen, (i + 1) * segLen - 1));
    }
    const h = buildAggHarness(segments, { total: segCount * segLen });
    const out = await collectSlices(agg(h.segFetch, segCount));
    const flat = [].concat(...out.map((a) => Array.from(a)));
    assert.deepEqual(flat, bytes, "INV-AGG conservation round " + round);
    assert.equal(h.callLog.length, segCount, "each segment fetched exactly once, round " + round);
    for (let i = 0; i < segCount; i++) assert.equal(h.callLog[i].index, i, "call order is index order, round " + round);
  }
});

test("D-1 INV-AGG aggregateSegmentedStream: downstream cancel cancels every in-flight segment reader", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const cancelled = new Set();
  const launched = [];
  const segFetch = async (i) => {
    launched.push(i);
    return {
      status: 206,
      headers: { "content-range": "bytes " + i * 4 + "-" + (i * 4 + 3) + "/12" },
      stream: new ReadableStream({
        start(c) { c.enqueue(new Uint8Array([i])); },
        cancel() { cancelled.add(i); },
      }),
    };
  };
  const out = agg(segFetch, 3);
  const reader = out.getReader();
  const first = await reader.read();
  assert.ok(!first.done, "first segment data flows");
  await new Promise((r) => setTimeout(r, 20));
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(launched.length >= 2, "window launched at least 2 segments, got " + launched.length);
  for (const i of launched) {
    assert.ok(cancelled.has(i), "every launched segment reader must be cancelled on downstream cancel, segment " + i + " not cancelled");
  }
});

test("D-1 INV-AGG aggregateSegmentedStream: headers-phase failure retries up to 2, then hard-errors the whole stream", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const perSegment = new Map();
  const segFetch = async (i) => {
    perSegment.set(i, (perSegment.get(i) || 0) + 1);
    // production shape: the handler's segFetch swallows fetch throw/timeout into {status: 0}
    return { status: 0, stream: null };
  };
  await assert.rejects(
    () => collectSlices(agg(segFetch, 2, { segmentRetryBaseMs: 0, retrySleep: () => Promise.resolve() })),
    /status 0/,
    "a segment whose headers never arrive must hard-error after retries are exhausted"
  );
  assert.equal(perSegment.size, 2, "both launched segments attempted");
  for (const [i, n] of perSegment) {
    assert.equal(n, 3, "segment " + i + " attempts exactly 3 (1 initial + 2 retries) even for network-phase status-0");
  }
});

test("D-1 INV-AGG aggregateSegmentedStream: a non-206 segment status is terminal — the whole stream errors, never mixes bodies", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const segments = [
    segBody([1, 2, 3, 4], 0, 3),
    { status: 200, headers: { "content-length": "4" }, stream: sourceOf([[5, 6, 7, 8]]) },
  ];
  const segFetch = async (i) => {
    const seg = segments[i];
    if (seg.status === 206) return { status: 206, headers: {}, stream: sourceOf(seg.chunks) };
    return { status: seg.status, headers: seg.headers, stream: seg.stream };
  };
  await assert.rejects(
    () => collectSlices(agg(segFetch, 2)),
    /200|206|segment/,
    "a 200 mid-sequence must hard-error the aggregate (no silent byte mixing)"
  );
});

test("D-1 INV-AGG aggregateSegmentedStream: a body that ends short hard-errors, never silently closes (sliceReadableStream parity)", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const segFetch = async (i) => {
    if (i === 1) return { status: 206, headers: { "content-range": "bytes 104-107/500" }, stream: sourceOf([[1]]) }; // declares 4, delivers 1 then done
    return { status: 206, headers: { "content-range": "bytes 100-103/500" }, stream: sourceOf([[9, 9, 9, 9]]) };
  };
  await assert.rejects(
    () => collectSlices(agg(segFetch, [4, 4])),
    /ended after 1 of 4/,
    "a short segment body must hard-error like sliceReadableStream does"
  );
});

test("D-1 INV-AGG merge-grain: a single segment fed many sub-merge chunks yields coalesced chunks, byte-identical, none split mid-byte", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const tiny = [];
  for (let i = 0; i < 200; i++) tiny.push([i % 251]);
  const segFetch = async () => ({ status: 206, headers: { "content-range": "bytes 0-199/200" }, stream: sourceOf(tiny.map((t) => new Uint8Array(t))) });
  const pieces = await collectSlices(agg(segFetch, [200], { concurrency: 1, mergeBytes: 8192 }));
  const joined = new Uint8Array(pieces.reduce((n, p) => n + p.byteLength, 0));
  let off = 0; for (const p of pieces) { joined.set(p, off); off += p.byteLength; }
  assert.equal(off, 200, "all 200 bytes must arrive, none swallowed at tail");
  assert.ok(pieces.every((p) => p.byteLength > 0), "no zero-length chunk may be enqueued");
  assert.equal(joined.length, 200, "byte count preserved");
});

test("D-1 knob parseSegmentMergeBytes: total-function clamp (fallback/min/max, zero NaN leak)", () => {
  const parse = evalHandle(extractFnSource("parseSegmentMergeBytes"));
  assert.equal(parse(undefined), 32768, "missing env -> 32 KiB fallback");
  assert.equal(parse("0"), 32768, "zero -> fallback");
  assert.equal(parse(-5), 32768, "negative -> fallback");
  assert.equal(parse("abc"), 32768, "non-numeric -> fallback");
  assert.equal(parse("1"), 8192, "below MIN clamps to 8 KiB");
  assert.equal(parse("99999999"), 1048576, "above MAX clamps to 1 MiB");
  assert.equal(parse("65536"), 65536, "in-range passes through");
});

test("D-1 INV-AGG merge-grain: chunk count is bounded by ceil(bytes/mergeBytes), proving coalescing actually engaged", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const tiny = []; for (let i = 0; i < 500; i++) tiny.push(new Uint8Array([i % 251]));
  const segFetch = async () => ({ status: 206, headers: { "content-range": "bytes 0-499/500" }, stream: sourceOf(tiny) });
  const pieces = await collectSlices(agg(segFetch, [500], { concurrency: 1, mergeBytes: 8192 }));
  assert.ok(pieces.length <= Math.ceil(500 / 8192) + 1, "must coalesce; got " + pieces.length + " chunks for 500 bytes @ mergeBytes 8192");
  assert.ok(pieces.length < 500, "coalescing must reduce chunk count below one-per-byte");
});

test("D-1 INV-AGG merge-grain stall window: a silent upstream must flush its coalesced bytes and hard-error the short segment, never hang or silently close", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const segFetch = async () => ({
    status: 206,
    headers: { "content-range": "bytes 0-3/100" },
    stream: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {},
    }),
  });
  const t0 = Date.now();
  await assert.rejects(
    () => collectSlices(agg(segFetch, [100], { concurrency: 1, mergeBytes: 8192, stallDeadlineMs: 1500 })),
    /stalled after 4 of 100/,
    "a segment that goes permanently silent short of its declared length must hard-error like a short body does (sliceReadableStream parity), not silently close"
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, "a permanently silent upstream must terminate the stream, not hang forever, took " + elapsed + "ms");
});

test("F2b gate total-function: probeContentRangeOk accepts exact spans (incl. star total and case-insensitive unit) and never throws on junk", () => {
  const ok = evalHandle(extractFnSource("probeContentRangeOk"));
  assert.equal(ok("bytes 65536-131071/400000", 65536, 131071), true, "exact requested span");
  assert.equal(ok("bytes 0-65535/400000", 65536, 131071), false, "misreported start rejected");
  assert.equal(ok("bytes 65536-99999/400000", 65536, 131071), false, "misreported end rejected");
  assert.equal(ok("bytes 65536-131071/*", 65536, 131071), true, "star total judged by the span alone");
  assert.equal(ok("BYTES 65536-131071/400000", 65536, 131071), true, "unit token case-insensitive");
  assert.equal(ok(null, 65536, 131071), false, "missing header false, never a throw");
  assert.equal(ok(undefined, 0, 0), false, "undefined header false");
  assert.equal(ok("", 0, 0), false, "empty header false");
  assert.equal(ok("bytes abc-def/400000", 0, 0), false, "unparseable false");
  assert.equal(ok(123, 0, 0), false, "non-string false");
});

test("F3 STALL window: a live source trickling every 220ms must complete byte-exact, never be killed by idle cycles", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const payload = []; for (let k = 0; k < 6; k++) payload.push(new Uint8Array([k + 1, k + 1]));
  let issued = 0;
  let sourceStopped = false;
  const segFetch = async () => ({
    status: 206,
    headers: { "content-range": "bytes 0-11/12" },
    stream: new ReadableStream({
      start(c) {
        const tick = () => {
          if (sourceStopped) return;
          if (issued < payload.length) { c.enqueue(payload[issued++]); setTimeout(tick, 220); }
          else c.close();
        };
        tick();
      },
      cancel() { sourceStopped = true; },
    }),
  });
  const pieces = await collectSlices(agg(segFetch, [12], { concurrency: 1, mergeBytes: 8192, stallDeadlineMs: 1500 }));
  let off = 0; const joined = new Uint8Array(12);
  for (const p of pieces) { assert.ok(p.byteLength > 0, "no zero-length chunk"); joined.set(p, off); off += p.byteLength; }
  assert.equal(off, 12, "a 220ms-gap live source must deliver all 12 bytes");
  for (let k = 0; k < 6; k++) { assert.equal(joined[k * 2], k + 1, "byte order preserved at " + k * 2); assert.equal(joined[k * 2 + 1], k + 1); }
});

test("F3 STALL lower-bound: a single ~900ms inter-chunk silence must survive, bracketing the deadline so it can never be shrunk to a hair-trigger", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const chunks = [new Uint8Array([7, 7]), new Uint8Array([9, 9])];
  let issued = 0;
  const segFetch = async () => ({
    status: 206,
    headers: { "content-range": "bytes 0-3/4" },
    stream: new ReadableStream({
      start(c) {
        c.enqueue(chunks[issued++]);
        setTimeout(() => { c.enqueue(chunks[issued++]); c.close(); }, 900);
      },
    }),
  });
  const pieces = await collectSlices(agg(segFetch, [4], { concurrency: 1, mergeBytes: 8192, stallDeadlineMs: 1500 }));
  let off = 0; for (const p of pieces) off += p.byteLength;
  assert.equal(off, 4, "a live source with one 900ms pause must still deliver all 4 bytes (deadline must be well above 900ms)");
});

test("G2 stall deadline honors an explicit stallDeadlineMs option, not a hardcoded constant", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const segFetch = async () => ({
    status: 206,
    headers: { "content-range": "bytes 0-3/100" },
    stream: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {},
    }),
  });
  const t0 = Date.now();
  await assert.rejects(
    () => collectSlices(agg(segFetch, [100], { concurrency: 1, mergeBytes: 8192, stallDeadlineMs: 300 })),
    /stalled after 4 of 100/,
    "an explicit stallDeadlineMs must be honored"
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1200, "the stall must fire at the provided 300ms deadline, not a hardcoded 1500, took " + elapsed + "ms");
});

test("H1 segmentRetryDelayMs scheduler: exponential doubling per retry index with default and parse clamps", () => {
  const delay = evalHandle(extractFnSource("segmentRetryDelayMs"));
  assert.equal(delay(0, 40), 40, "first retry waits the base");
  assert.equal(delay(1, 40), 80, "second retry doubles");
  assert.equal(delay(2, 40), 160, "third retry doubles again");
  assert.equal(delay(3, 100), 800, "growth follows 2^attempt");
  assert.equal(delay(0, undefined), 250, "an undefined base falls back to the shipped default");
  const parse = evalHandle(extractFnSource("parseSegmentRetryBaseMs"));
  assert.equal(parse("0"), 0, "explicit zero is the escape valve: disable backoff, keep immediate retry");
  assert.equal(parse("abc"), 250, "junk falls back to the default");
  assert.equal(parse(-1), 250, "negative falls back to the default");
  assert.equal(parse(undefined), 250, "unset falls back to the default");
  assert.equal(parse(1e9), 10000, "an operator misconfiguration cannot stretch the backoff base past 10s");
});

test("H1 aggregateSegmentedStream: a retryable segment failure waits exponentially before each retry, keeping the retry budget and the post-wait cancel/failure checks", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const perSegment = new Map();
  const slept = [];
  const segFetch = async (i) => {
    perSegment.set(i, (perSegment.get(i) || 0) + 1);
    return { status: 0, stream: null };
  };
  await assert.rejects(
    () => collectSlices(agg(segFetch, 2, { segmentRetryBaseMs: 60, retrySleep: (ms) => { slept.push(ms); return Promise.resolve(); } })),
    /status 0/,
    "the stream must still hard-error once retries are exhausted"
  );
  assert.equal(perSegment.get(0), 3, "retry budget stays 1 initial + 2 retries for segment 0");
  assert.equal(perSegment.get(1), 3, "retry budget stays 1 initial + 2 retries for segment 1");
  const sorted = slept.slice().sort((a, b) => a - b);
  assert.deepEqual(sorted, [60, 60, 120, 120], "one exponential wait before every retry: 60 then 120 per segment");
});

test("H2 aggregateSegmentedStream: a retryable headers-phase failure cancels the rejected response body before the backoff wait", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const events = [];
  let attempt = 0;
  const segFetch = async () => {
    attempt++;
    if (attempt === 1) {
      return { status: 503, stream: { cancel() { events.push("cancel"); return Promise.resolve(); } } };
    }
    return { status: 206, stream: sourceOf([[7, 8, 9]]) };
  };
  const stream = agg(segFetch, 1, { segmentRetryBaseMs: 60, retrySleep: (ms) => { events.push("sleep:" + ms); return Promise.resolve(); } });
  const pieces = await collectSlices(stream);
  assert.deepEqual(events, ["cancel", "sleep:60"], "the rejected body must be cancelled before the retry backoff, exactly once");
  assert.equal(Buffer.concat(pieces).toString("hex"), "070809", "the aggregate stays byte-exact after the retry succeeds");
});

test("H2 aggregateSegmentedStream: a rejected cancel of the failed body must not block the backoff or the retry", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const events = [];
  let attempt = 0;
  const segFetch = async () => {
    attempt++;
    if (attempt === 1) {
      return { status: 503, stream: { cancel() { events.push("cancel-attempted"); return Promise.reject(new Error("cancel boom")); } } };
    }
    return { status: 206, stream: sourceOf([[1, 2]]) };
  };
  const stream = agg(segFetch, 1, { segmentRetryBaseMs: 60, retrySleep: (ms) => { events.push("sleep:" + ms); return Promise.resolve(); } });
  const pieces = await collectSlices(stream);
  assert.deepEqual(events, ["cancel-attempted", "sleep:60"], "the retry chain advances on schedule even when the body cancel rejects");
  assert.equal(Buffer.concat(pieces).toString("hex"), "0102", "the aggregate stays byte-exact after the retry succeeds");
});

test("H2 aggregateSegmentedStream: a synchronous throw from the failed body cancel must not block the backoff or the retry", async () => {
  const agg = evalHandle(extractFnSource("aggregateSegmentedStream"));
  const events = [];
  let attempt = 0;
  const segFetch = async () => {
    attempt++;
    if (attempt === 1) {
      return { status: 429, stream: { cancel() { throw new Error("cancel sync throw"); } } };
    }
    return { status: 206, stream: sourceOf([[3, 4]]) };
  };
  const stream = agg(segFetch, 1, { segmentRetryBaseMs: 60, retrySleep: (ms) => { events.push("sleep:" + ms); return Promise.resolve(); } });
  const pieces = await collectSlices(stream);
  assert.deepEqual(events, ["sleep:60"], "the retry chain advances on schedule even when the body cancel throws synchronously");
  assert.equal(Buffer.concat(pieces).toString("hex"), "0304", "the aggregate stays byte-exact after the retry succeeds");
});

test("A-shape lock: the Tier-4 HEAD parity test self-skips via a three-path git status porcelain probe", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const t00 = readFileSync(join(root, "test", "00-build-parity.test.mjs"), "utf8");
  assert.ok(t00.includes("t.skip"), "test/00 must self-skip while artifacts drift pending commit");
  assert.ok(t00.includes('["status", "--porcelain", "--", "src", "worker.js", "golden/worker.head.mjs"]'), "the drift gate must probe all three artifact paths in a single porcelain command");
  const buildSrc = readFileSync(join(root, "build.mjs"), "utf8");
  assert.ok(!buildSrc.includes("stays RED"), "build.mjs must stop advertising stays RED");
  assert.ok(!buildSrc.includes("expected red"), "build.mjs must stop advertising expected red");
});

test("D-1a lock: the joined pull catch cancels both inner readers (rejection-safe) before erroring the controller", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const src01 = readFileSync(join(root, "src", "01-handler.part.js"), "utf8");
  assert.ok(src01.includes("try { bridgeReader.cancel(e).catch(() => {}); } catch (cErr) {}"), "the bridge reader must be cancelled on the joined error path");
  assert.ok(src01.includes("try { aggReader.cancel(e).catch(() => {}); } catch (cErr) {}"), "the agg reader must be cancelled on the joined error path");
});

test("D-1b lock: the aggregateSegmentedStream call no longer passes the dead signal option", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const src01 = readFileSync(join(root, "src", "01-handler.part.js"), "utf8");
  assert.ok(!src01.includes("signal: fanoutAbort.signal"), "the dead opts.signal slot must be removed from the aggregator call");
  assert.ok(src01.includes("fanoutAbort.signal.aborted"), "fanoutAbort keeps its live references, no drive-by cleanup");
  assert.ok(src01.includes("fanoutAbort.abort()"), "fanoutAbort keeps its abort wiring, no drive-by cleanup");
});

test("D-1c lock: every request.signal abort listener in src/01 registers once", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const src01 = readFileSync(join(root, "src", "01-handler.part.js"), "utf8");
  const lines = src01.split("\n").filter((line) => line.includes('addEventListener("abort"'));
  assert.equal(lines.length, 4, "exactly four request.signal abort listeners are expected, got " + lines.length);
  for (const line of lines) {
    assert.ok(line.includes("{ once: true }"), "every abort listener must carry { once: true }: " + line.trim());
  }
});
