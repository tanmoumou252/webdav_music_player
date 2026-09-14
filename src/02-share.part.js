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

function buildShareHeadHtml(requestUrl, name, siteTitle) {
  const display = getShareDisplayParts(name);
  const brand = siteTitle || "Cloud Music Hub";
  const titleText = display.artist ? display.artist + " - " + display.title : display.title;
  const description = display.artist ? titleText + " · " + brand : titleText;
  const safeTitle = escapeHtmlText(titleText + " | " + brand);
  const safeDesc = escapeHtmlText(description);
  const safeUrl = escapeHtmlText(String(requestUrl || "").split("#")[0]);
  const safeBrand = escapeHtmlText(brand);
  return "<title>" + safeTitle + "</title>" +
    "<meta name=\"description\" content=\"" + safeDesc + "\">" +
    "<meta property=\"og:type\" content=\"music.song\">" +
    "<meta property=\"og:title\" content=\"" + safeTitle + "\">" +
    "<meta property=\"og:description\" content=\"" + safeDesc + "\">" +
    "<meta property=\"og:url\" content=\"" + safeUrl + "\">" +
    "<meta property=\"og:site_name\" content=\"" + safeBrand + "\">" +
    "<meta name=\"twitter:card\" content=\"summary\">" +
    "<meta name=\"twitter:title\" content=\"" + safeTitle + "\">" +
    "<meta name=\"twitter:description\" content=\"" + safeDesc + "\">";
}

