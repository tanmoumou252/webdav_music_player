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

const OG_ICON_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAANHElEQVR42u3d3XGcSBSAUYUwEagIgRAIgRAIgRDIgBAmhAmBEHjVGyEQgmy5esoqlUvWDwi673k4L1u71loSdT+gu+fh8al7AABi8U0AAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAMAOngnNNSAAAAGAAEAAAAIAAYAAAAQAAgABAAgABAACABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAAABgABAAAACAAGAAAAEAAIAAQAIAAQAAgAQAAgABAAgABAACABAACAAEACAAEAAIAAAAYDffwEACAAEAAIAEAAIAAQAIAAQAAgAQAAgABAAgABAACAAAAGAAEAAAAIAAYAAAAQAAgABAAgABAACABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAAABgABAAAACAAGAAAAEAAIAAQAIAASAAPBNAAGAAEAAAAIAAYAAAAQAAgABAAgABAACABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAAABgABAAAACAAGAAAAEAAIAAQAIAAQAAgAQAAgABAAgABAACABAACAAEACAAEAAIAAAAYAAQACAAEAAIAAAAYAAQAAAAgABgAAABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAQAAgABAAgABAACAAAAGAAEAAAAIAAYAAAAQAAgABAAgABAACABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAABDUAAgAAABgABAAAACAAGAAAAEAAIAAQAIAAQAAgAQAAgABAAgABAACABAACAAEACAAEAAIAAAAYAAQAAAAgABgAAABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAQAAgABAAQMYBMD8+dQ2bcw0IAEAAnNrkZwUCABAAgAAABAAgAAABAAgAQAAAAgAQAIAAAAEgAEAAAAJAAIAAAASAAAABAAgAAQACABAAAgAEACAABAAIAEAACAAQAIAAEAAgAAABIABAAAACQACAAAAEgAAAAQAIAAEAAgAQAIAAAAQAIAAAAQAIAEAAAAIAEACAAAAEAAgAQAAIABAAgAAQACAAAAEgAEAAAAJAAIAAAASAAAABAAgAAQACABAAAgAEACAABAAIAEAACAAQAIAAEAAgAAABIABAAAACABAAgAAABAAgAAABAAgAQAAAAgAQAIAAAAEACAABAAIAEAACAAQAIAAEAAgAQAAIABAAgAAQACAAAAEgAEAAAAJAAIAAAASAAAABAAgAAQACABAAAgAEACAABAAIAEAAAAIAEACAAAAEACAAAAEACABAAAACABAAIAB8E0AACAAQAIAAEAAgAAABIABAAAACQACAAAAEgAAAAQAIAAEAAgAQAAIABAAgAAQACABAAAgAEACAABAAIAAAASAAQAAAAsDPCwQAIAAAAQAIAEAAAAIAEACAAAAEACAAAN8EEAACAAQAIAAEAAgAQAAIABAAgAAQACAAAAEgAEAAAAJAAIAAAASAAAABAAgAAQACABAAAgAEACAABAAIAEAACAAQAIAA8LMCAQAIAEAAAAIAEACAAAAEACAAAAEACABAAIAAEAAgAAABIABAAAACQACAAAAEgAAAAQAIAAEAAgAQAAIABAAgAAQACABAAAgAEACAABAAIAAAASAAQAAAAkAAgAAABIAAAAEACABAAAACABAAgAAABAAgAAABAAgAQAAAAgAEACAABAAIAEAACAAQAIAAEAAgAAABIABAAAACQACAAAAEgAAAAQAIAAEAAgAQAAIABAAgAAQACABAAAgAEACAABAAIAAAAQAIAEAAAAIAEACAAAAEACAAAAEACABAAIAAAD7i8vjUNUn3+58Nb0z/8PbfadN/XwsAAQACAM6lfjXgXwbPvONgW9PXuKav16TQEAACAAQA7HxX/3JXPqYhc5aBt6Qo6Hd+WiAAQABAGE0a+HNGA/AeBN3GTwgEAAgAKFqbBuia0dB7z22jGBAAIACgyDv9kob+/2JAAAACgNDv9If0yPw5mDUFTy0AAAFApJX714BD/72B2QkAQABQ8mP+ycB/d/FgJwAAAYDBLwQEACAAMPiDh4AAAAEAp1Z5x795CDQCAAQAnNkQYCsfAgAEALx63L8YfggA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";

const OG_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#1ed760"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

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

