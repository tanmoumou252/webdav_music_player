import "../../runtime-lock.mjs";
import { createHash } from "node:crypto";

const ROOT_HREF = new URL("../../", import.meta.url).href.replace(/\/+$/, "/");
process.env.TZ = "UTC";

const RealDate = globalThis.Date;
export const FROZEN_NOW = 1700000000000;

export function freezeClock(now = FROZEN_NOW) {
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = FrozenDate;
  return () => {
    globalThis.Date = RealDate;
  };
}

export function installStubFetch(handler) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input && input.url);
    const normInit = {
      method: (init && init.method) || "GET",
      headers:
        init && init.headers
          ? Object.fromEntries(new Headers(init.headers).entries())
          : {},
    };
    calls.push({ url, ...normInit });
    return handler(url, normInit);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = prev;
    },
  };
}

export function makeRequest({ method = "GET", url, headers = {}, body }) {
  return new Request(url, { method, headers, body });
}

export async function runHandler(worker, req, env) {
  const res = await worker.fetch(req, env);
  const headers = {};
  for (const [k, v] of res.headers.entries()) headers[k] = v;
  if (typeof res.headers.getSetCookie === "function") {
    const cookies = res.headers.getSetCookie();
    if (cookies.length) headers["set-cookie[]"] = cookies;
  }
  const body = await res.text();
  return { status: res.status, statusText: res.statusText, headers, body };
}

export function redact(s) {
  return String(s)
    .replace(/admin_token=[0-9a-f]{64}/g, "admin_token=<TOKEN>")
    .replace(/session_[0-9a-f]{64}/g, "session_<TOKEN>")
    .replace(/"timestamp"\s*:\s*"[^"]*"/g, '"timestamp":"<TS>"')
    .replace(/"cause"\s*:\s*"((?:\\.|[^"\\])*)"/g, (m, inner) =>
      /\\n\s*at /.test(inner) ? '"cause":"<STACK>"' : m
    )
    .replace(new RegExp(ROOT_HREF.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&"), "g"), "<ROOT>/");
}

export function redactRecord(rec) {
  const out = {
    status: rec.status,
    statusText: rec.statusText,
    headers: {},
    body: rec.body === undefined ? undefined : redact(rec.body),
  };
  for (const [k, v] of Object.entries(rec.headers || {})) {
    out.headers[k] = Array.isArray(v) ? v.map(redact) : redact(v);
  }
  if (rec.stubCalls) {
    out.stubCalls = rec.stubCalls.map((c) => ({
      url: redact(c.url),
      method: c.method,
      headers: Object.fromEntries(
        Object.entries(c.headers || {}).map(([k, v]) => [k, redact(v)])
      ),
    }));
  }
  if (rec.post !== undefined) out.post = JSON.parse(redact(JSON.stringify(rec.post)));
  return out;
}

export function json(rec) {
  return JSON.parse(rec.body);
}

export function digestHtml(rec) {
  const ct = String((rec.headers && rec.headers["content-type"]) || "");
  if (!ct.includes("text/html") || typeof rec.body !== "string") return rec;
  return {
    ...rec,
    body: {
      htmlLen: rec.body.length,
      sha256: createHash("sha256").update(rec.body, "utf8").digest("hex"),
    },
  };
}

export async function comparable(raw) {
  return digestHtml(redactRecord(raw));
}