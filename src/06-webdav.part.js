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

function parseContentRangeTotal(value) {
  if (!value) return null;
  const match = /\/\s*(\d+)\s*$/.exec(String(value).trim());
  if (!match) return null;
  const total = parseInt(match[1], 10);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function parseUpstreamTimeoutMs(raw) {
  const FALLBACK = 8000;
  const MIN = 500;
  const MAX = 300000;
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN);
  if (!Number.isFinite(n) || n <= 0) return FALLBACK;
  if (n < MIN) return MIN;
  if (n > MAX) return MAX;
  return n;
}

function parseSegmentConcurrency(raw) {
  const FALLBACK = 3;
  const MIN = 1;
  const MAX = 8;
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN);
  if (!Number.isFinite(n) || n <= 0) return FALLBACK;
  if (n < MIN) return MIN;
  if (n > MAX) return MAX;
  return n;
}

const SEGMENT_PART_SIZE_MAX = 8388608;

function parseSegmentPartSize(raw) {
  const FALLBACK = 1048576;
  const MIN = 65536;
  const MAX = SEGMENT_PART_SIZE_MAX;
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN);
  if (!Number.isFinite(n) || n <= 0) return FALLBACK;
  if (n < MIN) return MIN;
  if (n > MAX) return MAX;
  return n;
}

function parseSegmentMaxSegments(raw) {
  const FALLBACK = 16;
  const MIN = 1;
  const MAX = 64;
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN);
  if (!Number.isFinite(n) || n <= 0) return FALLBACK;
  if (n < MIN) return MIN;
  if (n > MAX) return MAX;
  return n;
}

function parseSegmentMergeBytes(raw) {
  const FALLBACK = 32768;
  const MIN = 8192;
  const MAX = 1048576;
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN);
  if (!Number.isFinite(n) || n <= 0) return FALLBACK;
  if (n < MIN) return MIN;
  if (n > MAX) return MAX;
  return n;
}

const SEGMENT_RETRY_BASE_MS = 250;

function segmentRetryDelayMs(attempt, baseMs) {
  const base = baseMs >= 0 ? baseMs : SEGMENT_RETRY_BASE_MS;
  return base * Math.pow(2, attempt);
}

function parseSegmentRetryBaseMs(raw) {
  const FALLBACK = SEGMENT_RETRY_BASE_MS;
  const MAX = 10000;
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN);
  if (!Number.isFinite(n) || n < 0) return FALLBACK;
  if (n > MAX) return MAX;
  return n;
}

function probeContentRangeOk(rawHeader, wantStart, wantEnd) {
  if (typeof rawHeader !== "string") return false;
  const m = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(rawHeader.trim());
  if (!m) return false;
  const s = parseInt(m[1], 10);
  const e = parseInt(m[2], 10);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  return s === wantStart && e === wantEnd;
}

function sliceReadableStream(stream, start, count) {
  if (!stream || !(count > 0)) return null;
  const reader = stream.getReader();
  let skipped = 0;
  let sent = 0;
  const FLUSH_BYTES = 32768;
  let pending = null;
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
          if (pending && pending.byteLength + value.byteLength <= FLUSH_BYTES) {
            const merged = new Uint8Array(pending.byteLength + value.byteLength);
            merged.set(pending, 0);
            merged.set(value, pending.byteLength);
            pending = merged;
            if (sent < count) continue;
            controller.enqueue(pending);
            pending = null;
            controller.close();
            reader.cancel().catch(() => {});
            return;
          }
          if (pending) {
            controller.enqueue(pending);
            pending = null;
            if (value.byteLength < FLUSH_BYTES && sent < count) {
              pending = value;
              return;
            }
          }
          if (value.byteLength < FLUSH_BYTES && sent < count) {
            pending = value;
            continue;
          }
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

function aggregateSegmentedStream(segFetch, segments, options) {
  if (typeof segFetch !== "function") return null;
  if (typeof segments === "number") segments = new Array(segments).fill(null);
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const opts = options || {};
  const concurrency = opts.concurrency > 0 ? opts.concurrency : 3;
  const mergeBytes = opts.mergeBytes > 0 ? opts.mergeBytes : 32768;
  const retryBaseMs = typeof opts.segmentRetryBaseMs === "number" && opts.segmentRetryBaseMs >= 0 ? opts.segmentRetryBaseMs : SEGMENT_RETRY_BASE_MS;
  const retrySleep = typeof opts.retrySleep === "function" ? opts.retrySleep : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const MERGE_STALL_MS = 40;
  const STALL_DEADLINE_MS = opts.stallDeadlineMs > 0 ? opts.stallDeadlineMs : parseUpstreamTimeoutMs(undefined);
  const STALL = Symbol("stall");
  let failed = null;
  let cancelRequested = false;
  const readers = new Map();
  const queues = new Map();
  const pendingSeg = new Map();
  const inFlight = new Set();
  let consumeIndex = 0;
  const waiters = new Set();
  const notify = () => {
    const list = [...waiters];
    waiters.clear();
    for (const w of list) { try { w(); } catch (wErr) {} }
  };

  function fail(e) {
    if (failed) return;
    failed = e;
    for (const r of readers.values()) { try { r.cancel(); } catch (cErr) {} }
    readers.clear();
    for (const q of queues.values()) q.length = 0;
    queues.clear();
    pendingSeg.clear();
    notify();
  }

  async function pump(i, reader) {
    try {
      let got = 0;
      let pendingRead = reader.read();
      let lastProgressAt = Date.now();
      for (;;) {
        if (cancelRequested || failed) return;
        let stallTimer = null;
        const raced = await Promise.race([pendingRead, new Promise((resolve) => { stallTimer = setTimeout(() => resolve(STALL), MERGE_STALL_MS); })]);
        if (raced === STALL) {
          const pend = pendingSeg.get(i);
          if (!pend || pend.byteLength === 0) {
            if (Date.now() - lastProgressAt < STALL_DEADLINE_MS) continue;
            const declaredIdle = typeof segments[i] === "number" ? segments[i] : null;
            if (declaredIdle !== null && got < declaredIdle) {
              fail(new Error("upstream body stalled after " + got + " of " + declaredIdle + " bytes in segment " + i));
              return;
            }
            const qi = queues.get(i) || [];
            qi.push({ done: true });
            queues.set(i, qi);
            try { await reader.cancel(); } catch (cErr) {}
            notify();
            return;
          }
          const qs = queues.get(i) || [];
          qs.push({ value: pend });
          pendingSeg.delete(i);
          queues.set(i, qs);
          notify();
          continue;
        }
        if (stallTimer) clearTimeout(stallTimer);
        lastProgressAt = Date.now();
        const chunk = raced;
        if (chunk.done) {
          const declared = typeof segments[i] === "number" ? segments[i] : null;
          if (declared !== null && got < declared) {
            fail(new Error("upstream body ended after " + got + " of " + declared + " bytes in segment " + i));
            return;
          }
          const q = queues.get(i) || [];
          const pendDone = pendingSeg.get(i);
          if (pendDone) { q.push({ value: pendDone }); pendingSeg.delete(i); }
          q.push({ done: true });
          queues.set(i, q);
          notify();
          return;
        }
        got += chunk.value.byteLength;
        const declared = typeof segments[i] === "number" ? segments[i] : null;
        let value = chunk.value;
        if (declared !== null && got > declared) {
          value = value.subarray(0, value.byteLength - (got - declared));
        }
        const q = queues.get(i) || [];
        if (value.byteLength > 0) {
          const pend = pendingSeg.get(i);
          if (pend && pend.byteLength + value.byteLength <= mergeBytes) {
            const merged = new Uint8Array(pend.byteLength + value.byteLength);
            merged.set(pend, 0);
            merged.set(value, pend.byteLength);
            pendingSeg.set(i, merged);
          } else {
            if (pend) { q.push({ value: pend }); pendingSeg.delete(i); }
            if (value.byteLength < mergeBytes && (declared === null || got < declared)) pendingSeg.set(i, value);
            else q.push({ value });
          }
        }
        queues.set(i, q);
        notify();
        if (declared !== null && got >= declared) {
          const q2 = queues.get(i);
          const pendFull = pendingSeg.get(i);
          if (pendFull) { q2.push({ value: pendFull }); pendingSeg.delete(i); }
          q2.push({ done: true });
          try { await reader.cancel(); } catch (cErr) {}
          notify();
          return;
        }
        while (!cancelRequested && !failed && i !== consumeIndex && i !== consumeIndex + 1) {
          await new Promise((resolve) => { waiters.add(resolve); });
        }
        if (cancelRequested || failed) return;
        pendingRead = reader.read();
      }
    } catch (e) {
      fail(e);
    }
  }

  async function launch(i) {
    inFlight.add(i);
    try {
      for (let attempt = 0; ; attempt++) {
        if (cancelRequested || failed) return;
        let res = null;
        try {
          res = await segFetch(i);
        } catch (fetchErr) {
          if (attempt >= 2 || cancelRequested || failed) {
            fail(fetchErr);
            return;
          }
          await retrySleep(segmentRetryDelayMs(attempt, retryBaseMs));
          if (cancelRequested || failed) return;
          continue;
        }
        if (res && res.status === 206 && res.stream) {
          const reader = res.stream.getReader();
          readers.set(i, reader);
          await pump(i, reader);
          if (failed || cancelRequested) {
            try { await reader.cancel(); } catch (cErr) {}
          }
          return;
        }
        const retryable = res && (res.status === 0 || res.status === 429 || res.status >= 500);
        if (!retryable || attempt >= 2 || cancelRequested || failed) {
          fail(new Error("segment " + i + " headers-phase failure with status " + (res ? res.status : "no-response") + (retryable ? " (retries exhausted)" : " (terminal, no retry)")));
          return;
        }
        if (res && res.stream) { try { res.stream.cancel().catch(() => {}); } catch (cErr) {} }
        await retrySleep(segmentRetryDelayMs(attempt, retryBaseMs));
        if (cancelRequested || failed) return;
      }
    } catch (e) {
      fail(e);
    } finally {
      inFlight.delete(i);
      notify();
    }
  }

  function requestMore(upTo) {
    for (let i = nextLaunch; i < upTo && !failed && !cancelRequested; i++) {
      if (!readers.has(i) && !inFlight.has(i)) {
        nextLaunch = i + 1;
        launch(i);
      }
    }
  }

  let nextLaunch = 0;

  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          if (failed) throw failed;
          for (let i = consumeIndex; i < segments.length; i++) {
            requestMore(Math.min(i + concurrency, segments.length));
            const q = queues.get(i);
            if (q && q.length) {
              const item = q.shift();
              if (item.done) {
                queues.delete(i);
                readers.delete(i);
                consumeIndex = i + 1;
                notify();
                continue;
              }
              controller.enqueue(item.value);
              return;
            }
            if (readers.has(i) || inFlight.has(i)) {
              await new Promise((resolve) => { waiters.add(resolve); });
              break;
            }
            if (failed) throw failed;
          }
          if (failed) throw failed;
          let anyPending = false;
          for (let i = consumeIndex; i < segments.length; i++) {
            if (queues.has(i) || readers.has(i) || inFlight.has(i)) { anyPending = true; break; }
          }
          if (!anyPending) {
            controller.close();
            return;
          }
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) {
      cancelRequested = true;
      for (const r of readers.values()) { try { r.cancel(reason); } catch (cErr) {} }
      readers.clear();
      for (const q of queues.values()) q.length = 0;
      queues.clear();
      pendingSeg.clear();
      notify();
    }
  });
}

async function fetchWebDavList(src, env) {
  let targetUrl = src.url.endsWith("/") ? src.url : src.url + "/";

  const headers = new Headers({ "Depth": "1" });
  if (src.user || src.pass) {
    headers.set("Authorization", "Basic " + btoa(unescape(encodeURIComponent(`${src.user || ""}:${src.pass || ""}`))));
  }

  let davRes;
  const listTimeoutMs = parseUpstreamTimeoutMs(env && env.STREAM_FETCH_TIMEOUT_MS);
  const listAbort = new AbortController();
  const listTimer = setTimeout(() => listAbort.abort(), listTimeoutMs);
  try {
    try {
      davRes = await fetch(targetUrl, { method: "PROPFIND", headers, signal: listAbort.signal });
    } finally {
      clearTimeout(listTimer);
    }
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

