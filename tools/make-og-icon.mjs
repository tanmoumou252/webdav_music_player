import { deflateSync } from "node:zlib";
import { writeFileSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src", "02-share.part.js");
const MARK_START = 'const OG_ICON_PNG_B64 = "';
const W = 512;
const H = 512;
const PAD = 0.13;
const RAD = 92;
const S = 4;
const INV24 = 0.041666666666666664;
const scale = W * (1 - 2 * PAD) * INV24;
const ox = W * 0.5;
const oy = H * 0.5;
const gx = (v) => (v - 12) * scale + ox;
const gy = (v) => (v - 12) * scale + oy;

const disc = [gx(10), gy(17), 4 * scale];
const stem = [gx(10), gy(7), gx(14), gy(17)];
const flag = [gx(14), gy(3), gx(18), gy(7)];

function inGlyph(px, py) {
  const dx = px - disc[0];
  const dy = py - disc[1];
  if (dx * dx + dy * dy <= disc[2] * disc[2]) return true;
  if (px >= stem[0] && px <= stem[2] && py >= stem[1] && py <= stem[3]) return true;
  if (px >= flag[0] && px <= flag[2] && py >= flag[1] && py <= flag[3]) return true;
  return false;
}

function insideCard(px, py) {
  if (px >= RAD && px <= W - 1 - RAD) return true;
  if (py >= RAD && py <= H - 1 - RAD) return true;
  const cx = Math.max(RAD, Math.min(W - 1 - RAD, px));
  const cy = Math.max(RAD, Math.min(H - 1 - RAD, py));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= RAD * RAD;
}

const BG = [24, 24, 24];
const FG = [30, 215, 96];
const px = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let cardCov = 0;
    let glyphCov = 0;
    for (let sy = 0; sy < S; sy++) {
      for (let sx = 0; sx < S; sx++) {
        const a = x + (sx + 0.5) * 0.25;
        const b = y + (sy + 0.5) * 0.25;
        if (insideCard(a, b)) {
          cardCov = cardCov + 1;
          if (inGlyph(a, b)) glyphCov = glyphCov + 1;
        }
      }
    }
    const g = cardCov === 0 ? 0 : glyphCov * Math.pow(cardCov, -1);
    const o = (y * W + x) * 4;
    px[o] = Math.round(BG[0] * (1 - g) + FG[0] * g);
    px[o + 1] = Math.round(BG[1] * (1 - g) + FG[1] * g);
    px[o + 2] = Math.round(BG[2] * (1 - g) + FG[2] * g);
    px[o + 3] = Math.round(cardCov * 15.9375);
  }
}

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const stride = W * 4 + 1;
const raw = Buffer.alloc(stride * H);
for (let y = 0; y < H; y++) {
  px.copy(raw, y * stride + 1, y * W * 4, (y + 1) * W * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
const b64 = png.toString("base64");

function fail(msg) {
  console.error("make-og-icon: " + msg);
  process.exit(1);
}

const before = readFileSync(SRC, "utf8");
const at = before.indexOf(MARK_START);
if (at < 0) fail("anchor `" + MARK_START + "` not found in src/02-share.part.js");
if (before.indexOf(MARK_START, at + 1) >= 0) fail("anchor appears more than once in src/02-share.part.js");
const valueStart = at + MARK_START.length;
const valueEnd = before.indexOf('";', valueStart);
if (valueEnd < 0 || before.indexOf("\n", valueStart) < valueEnd) fail("anchor line is malformed");
const patched = before.slice(0, valueStart) + b64 + before.slice(valueEnd);
if (!Buffer.from(b64, "base64").equals(png)) fail("pre-write round-trip failed: base64 does not decode back to the generated PNG");

mkdirSync(join(ROOT, "build", "out"), { recursive: true });
writeFileSync(join(ROOT, "build", "out", "og-icon.png"), png);
writeFileSync(SRC + ".tmp", patched);
renameSync(SRC + ".tmp", SRC);

const after = readFileSync(SRC, "utf8");
const ra = after.indexOf(MARK_START) + MARK_START.length;
const rb = after.indexOf('";', ra);
const roundTrip = Buffer.from(after.slice(ra, rb), "base64");
if (!roundTrip.equals(png)) fail("self-check failed: the constant in src/02-share.part.js does not decode to the generated PNG");
if (after.length !== patched.length) fail("self-check failed: written file length drift");

console.log("pngBytes=" + png.length);
console.log("base64Chars=" + b64.length);
console.log("sha256=" + createHash("sha256").update(png).digest("hex"));
console.log("constant written + self-checked: src/02-share.part.js (" + roundTrip.length + " bytes round-trip)");
console.log("eyes-only artifact: build/out/og-icon.png");
