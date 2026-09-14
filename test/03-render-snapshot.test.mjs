import "../runtime-lock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadParts } from "./helper/load-parts.mjs";

const { renderHTML } = loadParts();

const GOLDEN_SHA256 = "7d323f5a84861bd185c6a43123ffd590b0de11047e112350180b1d68ca518f7c";
const GOLDEN_LENGTH = 96415;

test("Tier-3 renderHTML snapshot: golden length & sha256 master", () => {
  const html = renderHTML();
  assert.equal(html.length, GOLDEN_LENGTH, "HTML length drift");
  const sha = createHash("sha256").update(html, "utf8").digest("hex");
  assert.equal(sha, GOLDEN_SHA256, "HTML digest drift — template literal bytes must remain strictly identical");
});

test("Tier-3 renderHTML snapshot: structural anchors", () => {
  const html = renderHTML();
  assert.ok(html.startsWith("<!DOCTYPE html>"), "must start with DOCTYPE");
  assert.ok(html.endsWith("</html>"), "must end with </html> (no trailing newline in template literal return)");
  assert.ok(html.includes("<title>Cloud Music Hub</title>"), "default title must be present for /play= replacement");
  assert.ok(html.includes("<style>"), "inlined style must be present");
  assert.ok(html.includes(":root {"), "root vars must be present");
  assert.ok(html.includes("async function init() {"), "main app init present");
  assert.ok(html.includes('<svg style="display:none;">'), "symbol sprite present");
  assert.ok(html.includes('id="icon-play"'), "play icon symbol present");
  assert.ok(html.includes('id="icon-pause"'), "pause icon symbol present");
});

test("Tier-3 regression lock: template-cooked regex preserved verbatim", () => {
  const html = renderHTML();
  // 已知缺陷保留：renderHTML 外层模板内的 song.name.replace(/\.[^/.]+$/, "")，
  // 模板字符串求值把 \. cook 成 .，客户端拿到的是单点号正则。
  // 有意原样保留，不要顺手修：
  assert.ok(
    html.includes('song.name.replace(/.[^/.]+$/, "");'),
    "must contain the template-cooked single-dot regex"
  );
  assert.ok(
    !html.includes('song.name.replace(/\\.[^/.]+$/, "")'),
    "must NOT contain the un-cooked backslash variant — doing so means someone touched the template escaping"
  );
});

test("Tier-3 lock: client escapeHtml differs from server escapeHtmlText by design", () => {
  const html = renderHTML();
  assert.ok(html.includes("function escapeHtml(s) {"), "client escapeHtml function must be defined");
  assert.ok(html.includes("return String(s).replace(/&/g, '&amp;')"), "client escapeHtml implementation body");
  assert.ok(!html.includes("escapeHtmlText("), "server-only escapeHtmlText must never appear in client template");
});