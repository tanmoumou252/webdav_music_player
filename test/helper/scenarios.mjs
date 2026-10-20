import { createHash } from "node:crypto";
import { createKV } from "./kv.mjs";
import * as F from "./fixtures.mjs";
import {
  FROZEN_NOW,
  freezeClock,
  installStubFetch,
  makeRequest,
} from "./harness.mjs";

const PAGE = "https://app.example.com";
const IP = "9.9.9.9";
const TOKEN = "f".repeat(64);
const COOKIE = { cookie: "admin_token=" + TOKEN };

const GET = (path, headers = {}) => ({ method: "GET", url: PAGE + path, headers });
const POST = (path, body, headers = {}) => ({
  method: "POST",
  url: PAGE + path,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const jsonText = (str) => {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
};

function seedAdmin(extra = {}) {
  return {
    admin_pass: F.ADMIN_HASH,
    [`session_${TOKEN}`]: JSON.stringify({ created: FROZEN_NOW }),
    ...extra,
  };
}

function seedSources(arr, admin = false) {
  return { ...(admin ? seedAdmin() : {}), dav_sources: JSON.stringify(arr) };
}

function route(map, fallback) {
  return (url) => {
    for (const [pre, fn] of Object.entries(map)) {
      if (url.startsWith(pre)) return fn(url);
    }
    const f = fallback || (() => new Response("", { status: 404 }));
    return f(url);
  };
}

const errSource = F.SOURCE_ERR;

export function scenarios() {
  return [
    {
      name: "options",
      seedKV: null,
      request: { method: "OPTIONS", url: PAGE + "/api/status" },
      stub: null,
      post: async () => ({}),
    },
    {
      name: "nokv",
      seedKV: null,
      request: GET("/"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "jsmediatags-ok",
      seedKV: {},
      request: GET("/js/jsmediatags.min.js"),
      stub: route({
        "https://cdnjs.cloudflare.com/": () =>
          new Response(F.jsmediatagsBody, { status: 200 }),
      }),
      post: async () => ({}),
    },
    {
      name: "jsmediatags-down",
      seedKV: {},
      request: GET("/js/jsmediatags.min.js"),
      stub: route({
        "https://cdnjs.cloudflare.com/": () => {
          throw new Error("cdn unreachable");
        },
      }),
      post: async () => ({}),
    },
    {
      name: "status-uninit",
      seedKV: {},
      request: GET("/api/status"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "status-init-guest",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/status"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "status-admin-cookie",
      seedKV: seedSources([F.SOURCE_A], true),
      request: GET("/api/status", COOKIE),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "init-first",
      seedKV: {},
      request: POST("/api/admin/init", {
        adminPass: F.ADMIN_PASS,
        siteTitle: "我的站",
      }),
      stub: null,
      post: async (env) => ({
        adminPassCount1: (await env.MUSIC_KV.get("admin_pass")) !== null,
        siteTitle: await env.MUSIC_KV.get("site_title"),
      }),
    },
    {
      name: "init-twice",
      seedKV: seedAdmin(),
      request: POST("/api/admin/init", { adminPass: F.ADMIN_PASS }),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "init-short-pass",
      seedKV: {},
      request: POST("/api/admin/init", { adminPass: "abc" }),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "init-no-pass",
      seedKV: {},
      request: POST("/api/admin/init", {}),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "login-ok",
      seedKV: seedAdmin(),
      request: {
        ...POST("/api/admin/login", { adminPass: F.ADMIN_PASS }),
        headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      },
      stub: null,
      post: async (env) => {
        const rl = await env.MUSIC_KV.get(`rl_login_${IP}`);
        const sessions = await env.MUSIC_KV.list({ prefix: "session_" });
        return { rl, sessionCount: sessions.keys.length };
      },
    },
    {
      name: "login-bad",
      seedKV: seedAdmin(),
      request: {
        ...POST("/api/admin/login", { adminPass: "wrongpass" }),
        headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      },
      stub: null,
      post: async (env) => ({ rl: await env.MUSIC_KV.get(`rl_login_${IP}`) }),
    },
    {
      name: "login-lockout",
      seedKV: seedAdmin({ [`rl_login_${IP}`]: "5" }),
      request: {
        ...POST("/api/admin/login", { adminPass: F.ADMIN_PASS }),
        headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      },
      stub: null,
      post: async () => ({}),
    },
    {
      name: "login-plaintext-upgrade",
      seedKV: { admin_pass: "legacy1234" },
      request: {
        ...POST("/api/admin/login", { adminPass: "legacy1234" }),
        headers: { "content-type": "application/json", "cf-connecting-ip": IP },
      },
      stub: null,
      post: async (env) => ({
        upgradedHashLen: (await env.MUSIC_KV.get("admin_pass")).length,
        upgradedIsHex64: /^[0-9a-f]{64}$/.test(
          await env.MUSIC_KV.get("admin_pass")
        ),
      }),
    },
    {
      name: "sources-get-guest",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/admin/sources"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "sources-get-admin",
      seedKV: seedSources([F.SOURCE_A, F.SOURCE_B], true),
      request: GET("/api/admin/sources", COOKIE),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "sources-post-invalid-url",
      seedKV: seedAdmin(),
      request: POST(
        "/api/admin/sources",
        { sources: [{ id: "x", name: "X", url: "javascript:alert(1)" }] },
        COOKIE
      ),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "sources-post-valid",
      seedKV: seedAdmin({ cache_v3_list_all: "{}", cache_v3_list_a: "{}" }),
      request: POST(
        "/api/admin/sources",
        { sources: [F.SOURCE_A, F.SOURCE_B], siteTitle: "新标题" },
        COOKIE
      ),
      stub: null,
      post: async (env) => ({
        cacheKeys: (
          await env.MUSIC_KV.list({ prefix: "cache_v3_list_" })
        ).keys.length,
        sourcesLen: JSON.parse(await env.MUSIC_KV.get("dav_sources")).length,
        siteTitle: await env.MUSIC_KV.get("site_title"),
      }),
    },
    {
      name: "sources-post-newpass",
      seedKV: seedAdmin({ cache_v3_list_all: "{}" }),
      request: POST(
        "/api/admin/sources",
        { sources: [F.SOURCE_A], newAdminPass: "newpass123" },
        COOKIE
      ),
      stub: null,
      post: async (env) => ({
        sessionCount: (
          await env.MUSIC_KV.list({ prefix: "session_" })
        ).keys.length,
        passIsNewHex: /^[0-9a-f]{64}$/.test(
          await env.MUSIC_KV.get("admin_pass")
        ),
        passIsOld: (await env.MUSIC_KV.get("admin_pass")) === F.ADMIN_HASH,
        cacheKeys: (
          await env.MUSIC_KV.list({ prefix: "cache_v3_list_" })
        ).keys.length,
      }),
    },
    {
      name: "sources-post-newpass-short",
      seedKV: seedAdmin(),
      request: POST("/api/admin/sources", { newAdminPass: "short" }, COOKIE),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "logout",
      seedKV: seedAdmin(),
      request: GET("/api/admin/logout", COOKIE),
      stub: null,
      post: async (env) => ({
        sessionCount: (
          await env.MUSIC_KV.list({ prefix: "session_" })
        ).keys.length,
      }),
    },
    {
      name: "list-empty",
      seedKV: {},
      request: GET("/api/list"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "list-single-admin",
      seedKV: seedSources([F.SOURCE_A], true),
      request: GET("/api/list?sourceId=a", COOKIE),
      stub: route({
        [F.SOURCE_A.url]: F.davResponse(F.PROPFIND_A),
      }),
      post: async (env) => ({
        cached: (await env.MUSIC_KV.get("cache_v3_list_a")) !== null,
      }),
    },
    {
      name: "list-single-guest",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/list?sourceId=a"),
      stub: route({
        [F.SOURCE_A.url]: F.davResponse(F.PROPFIND_A),
      }),
      post: async (env) => ({
        cached: (await env.MUSIC_KV.get("cache_v3_list_a")) !== null,
      }),
    },
    {
      name: "list-all-merge",
      seedKV: seedSources([F.SOURCE_A, F.SOURCE_B], true),
      request: GET("/api/list", COOKIE),
      stub: route({
        [F.SOURCE_A.url]: F.davResponse(F.PROPFIND_A),
        [F.SOURCE_B.url]: F.davResponse(F.PROPFIND_B),
      }),
      post: async (env) => ({
        cachedAll: (await env.MUSIC_KV.get("cache_v3_list_all")) !== null,
      }),
    },
    {
      name: "list-cache-hit-guest",
      seedKV: {
        dav_sources: JSON.stringify([F.SOURCE_A]),
        cache_v3_list_all: JSON.stringify({
          items: [
            {
              id: "a1b2c3d4",
              name: "Alpha - One.mp3",
              href: "/da/Alpha%20-%20One.mp3",
              availableNodes: [{ sourceId: "a", href: "/da/x.mp3" }],
            },
          ],
          debugs: ["dbg1"],
          diagnostics: [{ title: "x", timestamp: "12:00" }],
          fromCache: false,
          isAdmin: true,
        }),
      },
      request: GET("/api/list"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "list-cache-hit-admin",
      seedKV: {
        ...seedAdmin(),
        dav_sources: JSON.stringify([F.SOURCE_A]),
        cache_v3_list_all: JSON.stringify({
          items: [
            {
              id: "a1b2c3d4",
              name: "Beta & Band - Two.flac",
              href: "/da/b.flac",
              availableNodes: [{ sourceId: "b", href: "/da/b.flac" }],
            },
          ],
          debugs: ["dbg1"],
          diagnostics: [{ title: "x", timestamp: "12:00" }],
          fromCache: false,
          isAdmin: true,
        }),
      },
      request: GET("/api/list", COOKIE),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "list-refresh-cooldown",
      seedKV: {
        ...seedAdmin(),
        dav_sources: JSON.stringify([F.SOURCE_A]),
        cache_v3_list_all: JSON.stringify({
          items: [{ id: "a1b2c3d4", name: "Z - Z.mp3", href: "/z.mp3" }],
          debugs: [],
          diagnostics: null,
          fromCache: false,
          isAdmin: true,
        }),
        lock_sync_all: String(FROZEN_NOW - 5000),
      },
      request: GET("/api/list?refresh=true", COOKIE),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "list-no-source-admin",
      seedKV: seedSources([F.SOURCE_A], true),
      request: GET("/api/list?sourceId=zzz", COOKIE),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "list-waf-admin",
      seedKV: seedSources([errSource], true),
      request: GET("/api/list?sourceId=e", COOKIE),
      stub: route({
        [errSource.url]: () =>
          new Response(F.WAF_403_BODY, {
            status: 403,
            statusText: "Forbidden",
            headers: { "content-type": "text/plain" },
          }),
      }),
      post: async () => ({}),
    },
    {
      name: "list-html-page",
      seedKV: seedSources([F.SOURCE_A], true),
      request: GET("/api/list?sourceId=a", COOKIE),
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response(F.HTML_LOGIN_PAGE, {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      }),
      post: async () => ({}),
    },
    {
      name: "list-crash-admin",
      seedKV: seedSources([F.SOURCE_A], true),
      request: GET("/api/list?sourceId=a", COOKIE),
      stub: route({
        [F.SOURCE_A.url]: () => ({
          headers: { get: () => "application/xml" },
          status: 207,
          statusText: "Multi-Status",
          text: async () => {
            throw new Error("broken response body");
          },
        }),
      }),
      post: async () => ({}),
    },
    {
      name: "list-crash-guest",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/list?sourceId=a"),
      stub: route({
        [F.SOURCE_A.url]: () => ({
          headers: { get: () => "application/xml" },
          status: 207,
          statusText: "Multi-Status",
          text: async () => {
            throw new Error("broken response body");
          },
        }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-missing-params",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/stream"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "stream-absolute-url-guest",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET(
        "/api/stream?sourceId=a&file=" + encodeURIComponent("https://evil.example.com/x.mp3")
      ),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "stream-path-escape-admin",
      seedKV: seedSources([F.SOURCE_A], true),
      request: GET("/api/stream?sourceId=a&file=../secret.mp3", COOKIE),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "stream-not-audio",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/stream?sourceId=a&file=notes.txt"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "stream-ok",
      seedKV: seedSources([F.SOURCE_A], true),
      request: {
        ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3", COOKIE),
        headers: { ...COOKIE, range: "bytes=0-99" },
      },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response("AUDIODATA", {
            status: 206,
            statusText: "Partial Content",
            headers: {
              "content-type": "audio/mpeg",
              "content-range": "bytes 0-99/100",
              "content-length": "100",
            },
          }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-ok-norange",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"),
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response("AUDIODATA", {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "audio/mpeg", "content-length": "9" },
          }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-upstream-err-admin",
      seedKV: seedSources([F.SOURCE_A], true),
      request: {
        ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3", COOKIE),
        headers: { ...COOKIE },
      },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response("Not Found", {
            status: 404,
            statusText: "Not Found",
            headers: { "content-type": "text/plain" },
          }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-upstream-err-guest",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"),
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response("Not Found", {
            status: 404,
            statusText: "Not Found",
            headers: { "content-type": "text/plain" },
          }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-network-admin",
      seedKV: seedSources([F.SOURCE_A], true),
      request: GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3", COOKIE),
      stub: route({
        [F.SOURCE_A.url]: () => {
          throw new Error("connection refused");
        },
      }),
      post: async () => ({}),
    },
    {
      name: "stream-network-guest",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"),
      stub: route({
        [F.SOURCE_A.url]: () => {
          throw new Error("connection refused");
        },
      }),
      post: async () => ({}),
    },
    {
      name: "html-root",
      seedKV: {},
      request: GET("/"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "play-hit",
      seedKV: {
        site_title: "分享站",
        cache_v3_list_all: JSON.stringify({
          items: [
            {
              id: "a1b2c3d4",
              name: "Artist - Title.mp3",
              href: "/da/a.mp3",
              availableNodes: [{ sourceId: "a", href: "/da/a.mp3" }],
            },
          ],
          debugs: [],
          diagnostics: null,
          fromCache: false,
          isAdmin: false,
        }),
      },
      request: GET("/?play=a1b2c3d4"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "play-uppercase",
      seedKV: {
        site_title: "分享站",
        cache_v3_list_all: JSON.stringify({
          items: [
            {
              id: "a1b2c3d4",
              name: "Artist - Title.mp3",
              href: "/da/a.mp3",
              availableNodes: [{ sourceId: "a", href: "/da/a.mp3" }],
            },
          ],
          debugs: [],
          diagnostics: null,
          fromCache: false,
          isAdmin: false,
        }),
      },
      request: GET("/?play=A1B2C3D4"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "play-miss",
      seedKV: {
        site_title: "分享站",
        cache_v3_list_all: JSON.stringify({
          items: [
            {
              id: "00000000",
              name: "Other - Song.mp3",
              href: "/da/o.mp3",
              availableNodes: [{ sourceId: "a", href: "/da/o.mp3" }],
            },
          ],
          debugs: [],
          diagnostics: null,
          fromCache: false,
          isAdmin: false,
        }),
      },
      request: GET("/?play=deadbeef"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "play-invalid-id",
      seedKV: {
        site_title: "分享站",
        cache_v3_list_all: JSON.stringify({
          items: [],
          debugs: [],
          diagnostics: null,
          fromCache: false,
          isAdmin: false,
        }),
      },
      request: GET("/?play=xyz"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "stream-range-upstream-ignores-tail",
      seedKV: seedSources([F.SOURCE_A]),
      request: { ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"), headers: { range: "bytes=100-" } },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response(F.RANGE_BODY_500, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "500" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-range-upstream-ignores-window",
      seedKV: seedSources([F.SOURCE_A]),
      request: { ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"), headers: { range: "bytes=10-19" } },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response(F.RANGE_BODY_500, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "500" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-suffix-upstream-ignores-tail",
      seedKV: seedSources([F.SOURCE_A]),
      request: { ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"), headers: { range: "bytes=-300" } },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response(F.RANGE_BODY_500, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "500" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-suffix-oversize-full",
      seedKV: seedSources([F.SOURCE_A]),
      request: { ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"), headers: { range: "bytes=-900" } },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response(F.RANGE_BODY_500, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "500" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-suffix-upstream-honest-206",
      seedKV: seedSources([F.SOURCE_A]),
      request: { ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"), headers: { range: "bytes=-300" } },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response("xyz", { status: 206, statusText: "Partial Content", headers: { "content-type": "audio/mpeg", "content-range": "bytes 497-499/500", "content-length": "3" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-suffix-empty-416",
      seedKV: seedSources([F.SOURCE_A]),
      request: { ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"), headers: { range: "bytes=-300" } },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response("", { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "0" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-range-unsatisfiable",
      seedKV: seedSources([F.SOURCE_A]),
      request: { ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"), headers: { range: "bytes=900-" } },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response(F.RANGE_BODY_500, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "500" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-range-upstream-no-length",
      seedKV: seedSources([F.SOURCE_A]),
      request: { ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"), headers: { range: "bytes=100-" } },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response(F.RANGE_BODY_500, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-norange-upstream-advertises-ranges",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"),
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response(F.RANGE_BODY_500, { status: 200, statusText: "OK", headers: { "content-type": "audio/mpeg", "content-length": "500", "accept-ranges": "bytes" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-content-type-fallback",
      seedKV: seedSources([F.SOURCE_A]),
      request: GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"),
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response(new Uint8Array(Buffer.from(F.RANGE_BODY_500, "latin1")), { status: 200, statusText: "OK", headers: { "content-length": "500" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "stream-upstream-416-passthrough",
      seedKV: seedSources([F.SOURCE_A]),
      request: { ...GET("/api/stream?sourceId=a&file=Alpha%20-%20One.mp3"), headers: { range: "bytes=900-" } },
      stub: route({
        [F.SOURCE_A.url]: () =>
          new Response(null, { status: 416, statusText: "Range Not Satisfiable", headers: { "content-range": "bytes */500" } }),
      }),
      post: async () => ({}),
    },
    {
      name: "list-all-writes-share-index",
      seedKV: seedSources([F.SOURCE_A, F.SOURCE_B], true),
      request: GET("/api/list", COOKIE),
      stub: route({
        [F.SOURCE_A.url]: F.davResponse(F.PROPFIND_A),
        [F.SOURCE_B.url]: F.davResponse(F.PROPFIND_B),
      }),
      post: async (env) => ({
        indexA: JSON.parse((await env.MUSIC_KV.get("share_meta_index_v1_a")) || "null"),
        indexB: JSON.parse((await env.MUSIC_KV.get("share_meta_index_v1_b")) || "null"),
      }),
    },
    {
      name: "list-single-writes-share-index",
      seedKV: seedSources([F.SOURCE_A], true),
      request: GET("/api/list?sourceId=a", COOKIE),
      stub: route({ [F.SOURCE_A.url]: F.davResponse(F.PROPFIND_A) }),
      post: async (env) => ({ indexA: JSON.parse((await env.MUSIC_KV.get("share_meta_index_v1_a")) || "null") }),
    },
    {
      name: "list-source-index-isolation",
      seedKV: {
        ...seedSources([F.SOURCE_A, F.SOURCE_B], true),
        share_meta_index_v1_b: JSON.stringify([["beefbeef", "Untouched - ByB.mp3"]]),
      },
      request: GET("/api/list?sourceId=a", COOKIE),
      stub: route({ [F.SOURCE_A.url]: F.davResponse(F.PROPFIND_A) }),
      post: async (env) => ({
        indexA: JSON.parse((await env.MUSIC_KV.get("share_meta_index_v1_a")) || "null"),
        indexB: JSON.parse((await env.MUSIC_KV.get("share_meta_index_v1_b")) || "null"),
      }),
    },
    {
      name: "play-hit-index-fallback",
      seedKV: {
        site_title: "分享站",
        dav_sources: JSON.stringify([F.SOURCE_A]),
        share_meta_index_v1_a: JSON.stringify([["a1b2c3d4", "Artist - Title.mp3"]]),
      },
      request: GET("/?play=a1b2c3d4"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "play-miss-no-index",
      seedKV: {
        site_title: "分享站",
        cache_v3_list_all: JSON.stringify({ items: [], debugs: [], diagnostics: null, fromCache: false, isAdmin: false }),
        share_meta_index_v1_b: JSON.stringify([["22222222", "Other - Song.mp3"]]),
      },
      request: GET("/?play=deadbeef"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "play-hit-xss",
      seedKV: {
        site_title: "分享站",
        dav_sources: JSON.stringify([F.SOURCE_A]),
        share_meta_index_v1_a: JSON.stringify([["deadbeef", "<script>alert(1)</script> - \"Quote\" & Amp.mp3"]]),
      },
      request: GET("/?play=deadbeef"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "play-hit-orphan-index",
      seedKV: {
        site_title: "分享站",
        dav_sources: JSON.stringify([F.SOURCE_A]),
        share_meta_index_v1_b: JSON.stringify([["22222222", "Ghost - Song.mp3"]]),
      },
      request: GET("/?play=22222222"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "sources-post-removes-index",
      seedKV: seedAdmin({
        dav_sources: JSON.stringify([F.SOURCE_A, F.SOURCE_B]),
        share_meta_index_v1_a: JSON.stringify([["aaaaaaaa", "Keep - Me.mp3"]]),
        share_meta_index_v1_b: JSON.stringify([["bbbbbbbb", "Drop - Me.mp3"]]),
      }),
      request: POST("/api/admin/sources", { sources: [F.SOURCE_A] }, COOKIE),
      stub: null,
      post: async (env) => ({
        indexA: (await env.MUSIC_KV.get("share_meta_index_v1_a")) !== null,
        indexB: (await env.MUSIC_KV.get("share_meta_index_v1_b")) !== null,
        sourcesLen: JSON.parse(await env.MUSIC_KV.get("dav_sources")).length,
      }),
    },
    {
      name: "sources-post-key-collision",
      seedKV: seedAdmin({
        dav_sources: JSON.stringify([{ id: "a.b", name: "旧源", url: "https://dav.example.com/dav/" }]),
        share_meta_index_v1_ab: JSON.stringify([["aaaaaaaa", "Keep - Collide.mp3"]]),
      }),
      request: POST("/api/admin/sources", { sources: [{ id: "ab", name: "新源", url: "https://dav.example.com/dav/" }] }, COOKIE),
      stub: null,
      post: async (env) => ({
        oldIndexPresent: (await env.MUSIC_KV.get("share_meta_index_v1_ab")) !== null,
        sourcesLen: JSON.parse(await env.MUSIC_KV.get("dav_sources")).length,
      }),
    },
    {
      name: "og-icon-png",
      seedKV: {},
      request: GET("/og-icon.png"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "og-icon-svg",
      seedKV: {},
      request: GET("/icon.svg"),
      stub: null,
      post: async () => ({}),
    },
    {
      name: "favicon-ico",
      seedKV: {},
      request: GET("/favicon.ico"),
      stub: null,
      post: async () => ({}),
    },
  ];
}

export function scenarioNamed(name) {
  const found = scenarios().find((s) => s.name === name);
  if (!found) throw new Error("scenario not found: " + name);
  return found;
}

export async function runOne(scenario, worker) {
  const unfreeze = freezeClock();
  try {
    const env = scenario.seedKV === null ? {} : { MUSIC_KV: createKV(scenario.seedKV) };
    const stubs = scenario.stub
      ? installStubFetch(scenario.stub)
      : installStubFetch(() => {
          throw new Error("no fetch expected");
        });
    try {
      const req = makeRequest(scenario.request);
      const res = await worker.fetch(req, env);
      const headers = {};
      for (const [k, v] of res.headers.entries()) headers[k] = v;
      if (typeof res.headers.getSetCookie === "function") {
        const cookies = res.headers.getSetCookie();
        if (cookies.length) headers["set-cookie[]"] = cookies;
      }
      const raw = await res.arrayBuffer();
      const contentType = String(headers["content-type"] || "");
      const isTextBody = contentType === "" || /^(text\/|application\/json|application\/javascript|image\/svg\+xml)/.test(contentType);
      const body = isTextBody
        ? new TextDecoder().decode(raw)
        : { binLen: raw.byteLength, sha256: createHash("sha256").update(Buffer.from(raw)).digest("hex") };
      return {
        name: scenario.name,
        status: res.status,
        statusText: res.statusText,
        headers,
        body,
        stubCalls: stubs.calls,
        post: await scenario.post(env),
      };
    } finally {
      stubs.restore();
    }
  } finally {
    unfreeze();
  }
}

export function contains(rec, needle) {
  if (typeof rec.body !== "string") {
    throw new TypeError("contains(): expected a string body for scenario '" + rec.name + "' but got a " + describeBody(rec.body) + " — text-substring checks do not apply to summarized bodies");
  }
  return rec.body.includes(needle);
}

export function bodyJson(rec) {
  if (typeof rec.body !== "string") {
    throw new TypeError("bodyJson(): expected a string body for scenario '" + rec.name + "' but got a " + describeBody(rec.body) + " — JSON parsing does not apply to summarized bodies");
  }
  return jsonText(rec.body);
}

function describeBody(body) {
  if (body && typeof body === "object" && "htmlLen" in body) return "html digest {htmlLen, sha256}";
  if (body && typeof body === "object" && "binLen" in body) return "binary digest {binLen, sha256}";
  return body === undefined ? "undefined body" : typeof body;
}

export function goldensOf(results) {
  const out = {};
  for (const name of Object.keys(results)) {
    out[name] = results[name];
  }
  return out;
}