function assertStreamPathContained(srcUrl, targetUrl) {
  let parsed, base;
  try {
    parsed = new URL(targetUrl);
    base = new URL(srcUrl);
  } catch (e) {
    return false;
  }
  if (parsed.origin !== base.origin) return false;
  let basePath, targetPath;
  try {
    basePath = decodeURIComponent(base.pathname).replace(/\/+$/, "");
    targetPath = decodeURIComponent(parsed.pathname);
  } catch (e) {
    return false;
  }
  if (!basePath) return true;
  return targetPath === basePath || targetPath.startsWith(basePath + "/");
}

function streamPathReject(targetUrl, method, srcName, corsHeaders, isAdmin) {
  if (!isAdmin) {
    return new Response(JSON.stringify({ error: "访问被拒绝", diagnostic: null }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    });
  }
  const diag = {
    sourceName: srcName,
    status: 403,
    statusText: "Path validation rejected",
    method: method,
    targetUrl: targetUrl,
    contentType: "",
    bodyPreview: "",
    title: "访问被拒绝：路径校验未通过",
    cause: "file 参数必须是所配置源目录内的相对路径；绝对 URL 与目录逃逸一律拒绝。",
    solution: "请从正常歌曲列表播放；手动构造链接时使用列表返回的相对 href。",
    timestamp: new Date().toLocaleTimeString()
  };
  return new Response(JSON.stringify({ error: diag.title, diagnostic: diag }), {
    status: 403,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}

function resolveWebDavUrl(baseUrl, href) {
  const u = new URL(baseUrl);
  const origin = u.origin;
  const basePath = u.pathname.replace(/\/$/, "");

  let fullPath = "";
  if (href.startsWith("/")) {
    if (basePath && href.startsWith(basePath)) {
      fullPath = href;
    } else {
      fullPath = basePath + href;
    }
  } else {
    fullPath = (basePath ? basePath + "/" : "/") + href;
  }

  const parts = fullPath.split("/").filter(Boolean);
  const normalizedPath = "/" + parts.join("/");
  try {
    return encodeURI(decodeURI(origin + normalizedPath));
  } catch (e) {
    const safePath = origin + normalizedPath.replace(/%(?![0-9a-fA-F]{2})/g, "%25");
    return encodeURI(decodeURI(safePath));
  }
}

function parseSingleByteRange(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const suffixMatch = /^bytes=-(\d+)$/.exec(trimmed);
  if (suffixMatch) {
    const suffix = parseInt(suffixMatch[1], 10);
    if (!isFinite(suffix) || suffix <= 0) return null;
    return { start: null, end: null, suffix: suffix };
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(trimmed);
  if (!match) return null;
  const start = parseInt(match[1], 10);
  if (!isFinite(start) || start < 0) return null;
  if (match[2] === "") return { start: start, end: null, suffix: null };
  const end = parseInt(match[2], 10);
  if (!isFinite(end) || end < start) return null;
  return { start: start, end: end, suffix: null };
}

const AUDIO_CONTENT_TYPES = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  alac: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  aac: "audio/aac",
  ape: "audio/x-ape",
  wma: "audio/x-ms-wma",
  mka: "audio/x-matroska",
  dsd: "audio/x-dsf",
  dsf: "audio/x-dsf",
  dff: "audio/x-dff"
};

function audioContentTypeFor(fileName) {
  const name = String(fileName || "");
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return AUDIO_CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] || null;
}

function sliceReadableStream(stream, start, count) {
  if (!stream || !(count > 0)) return null;
  const reader = stream.getReader();
  let skipped = 0;
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (sent < count) {
          const chunk = await reader.read();
          if (chunk.done) {
            if (sent < count) {
              controller.error(new Error("upstream body ended after " + sent + " of " + count + " bytes"));
            } else {
              controller.close();
            }
            return;
          }
          let value = chunk.value;
          if (skipped < start) {
            const remain = start - skipped;
            if (value.byteLength <= remain) {
              skipped += value.byteLength;
              continue;
            }
            value = value.subarray(remain);
            skipped = start;
          }
          if (sent + value.byteLength > count) {
            value = value.subarray(0, count - sent);
          }
          sent += value.byteLength;
          controller.enqueue(value);
          if (sent >= count) {
            controller.close();
            reader.cancel().catch(() => {});
          }
          return;
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}

async function fetchWebDavList(src) {
  let targetUrl = src.url.endsWith("/") ? src.url : src.url + "/";

  const headers = new Headers({ "Depth": "1" });
  if (src.user || src.pass) {
    headers.set("Authorization", "Basic " + btoa(unescape(encodeURIComponent(`${src.user || ""}:${src.pass || ""}`))));
  }

  let davRes;
  try {
    davRes = await fetch(targetUrl, { method: "PROPFIND", headers });
  } catch (e) {
    const diag = generateDiagnostic(0, e.message, targetUrl, "PROPFIND", src.name);
    return {
      diagnostic: diag,
      debug: { sourceId: src.id, sourceName: src.name, targetUrl, status: 0, statusText: e.message, allHrefs: [], rawPreview: "" },
      items: []
    };
  }

  const contentType = davRes.headers.get("content-type") || "";
  const rawBody = await davRes.text();

  const allHrefMatches = [...rawBody.matchAll(/<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/gi)];
  const allFoundHrefs = allHrefMatches.map(m => m[1].trim());

  const debug = {
    sourceId: src.id,
    sourceName: src.name,
    targetUrl: targetUrl,
    status: davRes.status,
    statusText: davRes.statusText,
    contentType: contentType,
    allHrefs: allFoundHrefs,
    allHrefsCount: allFoundHrefs.length,
    rawPreview: rawBody.slice(0, 300),
    rawLength: rawBody.length
  };

  if (!davRes.ok && davRes.status !== 207) {
    return {
      diagnostic: generateDiagnostic(davRes.status, davRes.statusText, targetUrl, "PROPFIND", src.name, rawBody, contentType),
      debug,
      items: []
    };
  }

  if (contentType.toLowerCase().includes("html") || rawBody.trim().startsWith("<!DOCTYPE") || rawBody.trim().startsWith("<html")) {
    return {
      diagnostic: generateDiagnostic(davRes.status, davRes.statusText, targetUrl, "PROPFIND", src.name, rawBody, contentType),
      debug,
      items: []
    };
  }

  const items = [];
  const responseRegex = /<(?:\w+:)?response[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi;
  let match;

  while ((match = responseRegex.exec(rawBody)) !== null) {
    const block = match[1];
    const isDir = /<(?:\w+:)?collection\s*\/?>/i.test(block);
    if (isDir) continue;

    const hrefMatch = block.match(/<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i);
    if (!hrefMatch) continue;

    const decodedHref = decodeXmlEntities(hrefMatch[1].trim());
    const nameMatch = block.match(/<(?:\w+:)?displayname[^>]*>([\s\S]*?)<\/(?:\w+:)?displayname>/i);
    
    let name = "";
    if (nameMatch && nameMatch[1].trim()) {
      name = decodeXmlEntities(nameMatch[1].trim());
    } else {
      try {
        name = decodeURIComponent(decodedHref.replace(/\/$/, "").split("/").pop());
      } catch (e) {
        name = decodedHref.replace(/\/$/, "").split("/").pop();
      }
    }

    if (/\.(mp3|flac|m4a|ogg|wav|aac|ape|alac|opus|wma|dsd|dsf|dff|mka)$/i.test(name)) {
      items.push({ name, href: decodedHref });
    }
  }

  let emptyDiagnostic = null;
  if (items.length === 0) {
    let specificCause = `服务端返回了 HTTP ${davRes.status}，但未扫描到任何已知音频格式的单曲文件。`;
    let specificSolution = "请确认该目录下是否存有支持的音频文件（如 .mp3/.flac）。注意：Linux 严格区分大小写！";

    if (allFoundHrefs.length > 1) {
      specificCause = `服务端返回了 ${allFoundHrefs.length} 个条目，但全部是文件夹或非音频扩展名。`;
    }

    emptyDiagnostic = {
      sourceName: src.name,
      status: davRes.status,
      statusText: davRes.statusText,
      method: "PROPFIND",
      targetUrl: targetUrl,
      contentType: contentType,
      title: `源【${src.name}】未发现音频单曲`,
      cause: specificCause,
      solution: specificSolution,
      timestamp: new Date().toLocaleTimeString(),
      bodyPreview: rawBody.slice(0, 300)
    };
  }

  return { items, debug, diagnostic: emptyDiagnostic };
}

