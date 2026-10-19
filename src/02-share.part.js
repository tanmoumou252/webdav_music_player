function getShareDisplayParts(name) {
  const base = String(name || "").replace(/\.[^/.]+$/, "").trim();
  const parts = base.split(/\s+-\s+/);
  if (parts.length > 1) {
    const artist = parts.shift().trim();
    const title = parts.join(" - ").trim() || base;
    return { artist: artist, title: title };
  }
  return { artist: "", title: base };
}

function escapeHtmlText(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const OG_ICON_PNG_B64 = "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";

const OG_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#1ed760"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

const OG_NOTE_PATH_D = "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z";
const OG_COVER_TITLE_MAX = 22;
const OG_COVER_ARTIST_MAX = 30;

function clampOgCoverLine(value, max) {
  const raw = String(value || "");
  if (raw.length <= max) return raw;
  let end = max;
  if (end < raw.length && raw.charCodeAt(end) >= 0xdc00 && raw.charCodeAt(end) <= 0xdfff) {
    end -= 1;
  }
  return raw.slice(0, end) + "…";
}

function buildOgCoverSvg(coverId, name) {
  if (!coverId || !/^[0-9a-f]{8}$/i.test(String(coverId))) return null;
  const display = getShareDisplayParts(name);
  if (!display.title) return null;
  const title = escapeHtmlText(clampOgCoverLine(display.title, OG_COVER_TITLE_MAX));
  const artistLine = display.artist ? "<text x=\"480\" y=\"360\" font-family=\"Segoe UI,sans-serif\" font-size=\"36\" fill=\"#9aa4b2\">" + escapeHtmlText(clampOgCoverLine(display.artist, OG_COVER_ARTIST_MAX)) + "</text>" : "";
  return "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1200\" height=\"630\" viewBox=\"0 0 1200 630\">" +
    "<defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">" +
    "<stop offset=\"0\" stop-color=\"#0d1117\"/><stop offset=\"1\" stop-color=\"#14301b\"/></linearGradient></defs>" +
    "<rect width=\"1200\" height=\"630\" fill=\"url(#g)\"/>" +
    "<g transform=\"translate(120 171) scale(12)\" fill=\"#1ed760\"><path d=\"" + OG_NOTE_PATH_D + "\"/></g>" +
    "<text x=\"480\" y=\"290\" font-family=\"Segoe UI,sans-serif\" font-size=\"56\" fill=\"#ffffff\">" + title + "</text>" +
    artistLine +
    "</svg>";
}

let ogIconPngBytes = null;

function decodeOgIconPng() {
  if (ogIconPngBytes) return ogIconPngBytes;
  const binary = atob(OG_ICON_PNG_B64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  ogIconPngBytes = bytes;
  return bytes;
}

const SHARE_INDEX_PREFIX = "share_meta_index_v1_";
const SHARE_INDEX_MAX = 20000;
const SHARE_NAME_MAX = 300;

function shareIndexSourceKey(sourceId) {
  const raw = String(sourceId || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!raw) return null;
  return SHARE_INDEX_PREFIX + raw;
}

function normalizeShareIndexPairs(items) {
  const byId = new Map();
  const incoming = Array.isArray(items) ? items : [];
  for (const item of incoming) {
    if (!item || typeof item.id !== "string" || !/^[0-9a-f]{8}$/.test(item.id)) continue;
    if (typeof item.name !== "string" || !item.name) continue;
    if (byId.has(item.id)) byId.delete(item.id);
    byId.set(item.id, [item.id, item.name.slice(0, SHARE_NAME_MAX)]);
  }
  const out = Array.from(byId.values());
  while (out.length > SHARE_INDEX_MAX) {
    out.pop();
  }
  return out;
}

function pickShareIndexName(index, id) {
  if (!Array.isArray(index) || typeof id !== "string" || !id) return null;
  for (const pair of index) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    if (pair[0] === id && typeof pair[1] === "string" && pair[1]) return pair[1];
  }
  return null;
}

function shareTitleText(name, siteTitle) {
  const brand = siteTitle || "Cloud Music Hub";
  const display = getShareDisplayParts(name);
  const titleText = display.artist ? display.artist + " - " + display.title : display.title;
  return titleText + " | " + brand;
}

function buildShareHeadHtml(requestUrl, name, siteTitle, coverId) {
  const brand = siteTitle || "Cloud Music Hub";
  const rawUrl = String(requestUrl || "").split("#")[0];
  let origin = "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") origin = parsed.origin;
  } catch (e) {
    origin = "";
  }
  const imageUrl = origin ? origin + "/og-icon.png" : "/og-icon.png";
  const pageUrl = origin && !name ? origin + "/" : rawUrl;
  const safeBrand = escapeHtmlText(brand);
  const safeImage = escapeHtmlText(imageUrl);
  const safeUrl = escapeHtmlText(pageUrl);
  const imageTags =
    "<meta property=\"og:image\" content=\"" + safeImage + "\">" +
    "<meta property=\"og:image:width\" content=\"512\">" +
    "<meta property=\"og:image:height\" content=\"512\">" +
    "<meta property=\"og:image:alt\" content=\"" + safeBrand + "\">" +
    "<meta name=\"twitter:image\" content=\"" + safeImage + "\">" +
    "<meta name=\"twitter:image:alt\" content=\"" + safeBrand + "\">" +
    "<meta name=\"twitter:card\" content=\"summary\">" +
    "<meta property=\"og:site_name\" content=\"" + safeBrand + "\">";
  if (!name) {
    const genericTitle = escapeHtmlText(brand);
    const genericDesc = escapeHtmlText(brand + " · 多源 WebDAV 音乐库");
    return "<meta name=\"description\" content=\"" + genericDesc + "\">" +
      "<meta property=\"og:type\" content=\"website\">" +
      "<meta property=\"og:title\" content=\"" + genericTitle + "\">" +
      "<meta property=\"og:description\" content=\"" + genericDesc + "\">" +
      "<meta name=\"twitter:title\" content=\"" + genericTitle + "\">" +
      "<meta name=\"twitter:description\" content=\"" + genericDesc + "\">" +
      "<meta property=\"og:url\" content=\"" + safeUrl + "\">" +
      imageTags;
  }
  const display = getShareDisplayParts(name);
  const titleText = display.artist ? display.artist + " - " + display.title : display.title;
  const safeTitle = escapeHtmlText(titleText + " | " + brand);
  const description = display.artist ? titleText + " · " + brand : titleText;
  const safeDesc = escapeHtmlText(description);
  return "<meta name=\"description\" content=\"" + safeDesc + "\">" +
    "<meta property=\"og:type\" content=\"music.song\">" +
    "<meta property=\"og:title\" content=\"" + safeTitle + "\">" +
    "<meta property=\"og:description\" content=\"" + safeDesc + "\">" +
    "<meta name=\"twitter:title\" content=\"" + safeTitle + "\">" +
    "<meta name=\"twitter:description\" content=\"" + safeDesc + "\">" +
    "<meta property=\"og:url\" content=\"" + safeUrl + "\">" +
    imageTags;
}

