import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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