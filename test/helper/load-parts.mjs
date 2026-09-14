import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runInThisContext } from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");

export const GAP_LINES = [426, 462, 501, 551, 586, 771];

export const PART_NAMES = [
  "01-handler.part.js",
  "02-share.part.js",
  "03-text.part.js",
  "04-diagnostic.part.js",
  "05-auth.part.js",
  "06-webdav.part.js",
  "07-render.part.js",
];

export function sliceBytes(bytes, gapLines) {
  const starts = [0];
  let pos = 0;
  for (;;) {
    const nl = bytes.indexOf(0x0a, pos);
    if (nl === -1) break;
    starts.push(nl + 1);
    pos = nl + 1;
  }
  const total = starts.length;
  const slices = [];
  let prevEnd = 0;
  for (const gap of gapLines) {
    const end = gap < total ? starts[gap] : bytes.length;
    slices.push(bytes.subarray(prevEnd, end));
    prevEnd = end;
  }
  slices.push(bytes.subarray(prevEnd));
  return slices;
}

function loadPartsFromGolden() {
  const bytes = readFileSync(path.join(ROOT, "golden", "worker.head.mjs"));
  const slices = sliceBytes(bytes, GAP_LINES);
  return slices.slice(1).map((b) => b.toString("utf8"));
}

function loadPartsFromSrc() {
  return PART_NAMES.slice(1).map((n) =>
    readFileSync(path.join(ROOT, "src", n), "utf8")
  );
}

const HANDLES = [
  "getShareDisplayParts",
  "escapeHtmlText",
  "buildShareHeadHtml",
  "generateTrackId",
  "decodeXmlEntities",
  "normalizeSongKey",
  "generateDiagnostic",
  "hashAdminPass",
  "isValidSourceUrl",
  "createSession",
  "isSessionValid",
  "sessionCookie",
  "clearedSessionCookie",
  "assertStreamPathContained",
  "streamPathReject",
  "resolveWebDavUrl",
  "fetchWebDavList",
  "renderHTML",
];

let cached = null;

export function loadParts() {
  if (cached) return cached;
  const texts = existsSync(path.join(ROOT, "src", PART_NAMES[1]))
    ? loadPartsFromSrc()
    : loadPartsFromGolden();
  const body =
    texts.join("") +
    "\n;return {" +
    HANDLES.map((h) => `${h}:${h}`).join(",") +
    "};";
  let fn;
  try {
    fn = new Function(body);
  } catch {
    fn = runInThisContext("(function(){" + body + "})");
  }
  cached = fn();
  return cached;
}