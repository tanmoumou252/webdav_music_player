import { test } from "node:test";
import assert from "node:assert/strict";
import { loadParts } from "./helper/load-parts.mjs";
import { createKV } from "./helper/kv.mjs";
import { installStubFetch, freezeClock } from "./helper/harness.mjs";
import { ADMIN_HASH, BASIC_A, SOURCE_A, SOURCE_ERR, PROPFIND_A, PROPFIND_B, PROPFIND_ONLY_DIR, PROPFIND_NON_AUDIO, WAF_403_BODY, HTML_LOGIN_PAGE, davResponse } from "./helper/fixtures.mjs";

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
  assert.ok(html.startsWith("<title>Artist - Title | 站点</title>"));
  assert.ok(html.includes('<meta property="og:type" content="music.song">'));
  assert.ok(html.includes('<meta property="og:url" content="https://app.example.com/?play=a1b2c3d4">'));
  assert.ok(html.includes('<meta name="twitter:card" content="summary">'));
  assert.ok(html.includes('<meta property="og:description" content="Artist - Title · 站点">'));
  const xss = P.buildShareHeadHtml("https://x.test/\"onmouseover=alert(1)", "A<B>&C.mp3", "T\"T");
  assert.ok(xss.includes("&lt;B&gt;&amp;C"));
  assert.ok(xss.includes("T&quot;T"));
  assert.ok(xss.includes("https://x.test/&quot;onmouseover=alert(1)"), "raw quote in url must be entity-escaped");
  assert.ok(xss.includes("<title>A&lt;B&gt;&amp;C | T&quot;T</title>"));
  assert.ok(P.buildShareHeadHtml("https://x.test", "", "").includes("<title> | Cloud Music Hub</title>"));
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