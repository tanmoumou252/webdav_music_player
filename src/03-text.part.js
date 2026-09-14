function generateTrackId(name) {
  let h = 2166136261;
  const s = (name || "").trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function decodeXmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&#x2022;/gi, "•")
    .replace(/&bull;/g, "•")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function normalizeSongKey(str) {
  return decodeXmlEntities(str)
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\u2018\u2019\uFF07]/g, "'")
    .replace(/[\u201C\u201D\uFF02]/g, '"')
    .toLowerCase();
}

