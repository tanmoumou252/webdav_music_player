async function resolveSharedSongName(env, playId) {
  if (!playId || !/^[0-9a-f]{8}$/i.test(playId)) return null;
  const normPlayId = playId.toLowerCase();
  try {
    const cachedPlaylist = await env.MUSIC_KV.get("cache_v3_list_all", "json");
    const cachedSong = cachedPlaylist && Array.isArray(cachedPlaylist.items) ? cachedPlaylist.items.find(item => item && item.id === normPlayId) : null;
    if (cachedSong && typeof cachedSong.name === "string" && cachedSong.name) {
      return cachedSong.name;
    }
    const sources = (await env.MUSIC_KV.get("dav_sources", { type: "json" })) || [];
    for (const srcEntry of sources) {
      const indexKey = srcEntry && typeof srcEntry.id === "string" ? shareIndexSourceKey(srcEntry.id) : null;
      if (!indexKey) continue;
      const pairs = await env.MUSIC_KV.get(indexKey, "json");
      const found = pickShareIndexName(pairs, normPlayId);
      if (found) return found;
    }
  } catch (e) {
    console.error("resolveSharedSongName failed for", normPlayId, e);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (!env.MUSIC_KV) {
      return new Response("请在 Worker 设置中绑定变量名为 MUSIC_KV 的 KV 命名空间！", {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    if (url.pathname === "/js/jsmediatags.min.js") {
      let kvBody = null;
      try {
        kvBody = await env.MUSIC_KV.get("jsmediatags_3_9_5");
      } catch (kvErr) {
        kvBody = null;
      }
      if (kvBody) {
        return new Response(kvBody, {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=604800"
          }
        });
      }
      try {
        const cdnTimeoutMs = parseUpstreamTimeoutMs(env && env.STREAM_FETCH_TIMEOUT_MS);
        const cdnAbort = new AbortController();
        const cdnTimer = setTimeout(() => cdnAbort.abort(), cdnTimeoutMs);
        let cdnRes;
        try {
          cdnRes = await fetch("https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js", { signal: cdnAbort.signal });
        } finally {
          clearTimeout(cdnTimer);
        }
        if (!cdnRes.ok) {
          try { if (cdnRes.body) cdnRes.body.cancel(); } catch (cancelErr) {}
          return new Response("// jsmediatags unavailable", {
            headers: { ...corsHeaders, "Content-Type": "application/javascript" }
          });
        }
        const body = await cdnRes.text();
        try {
          await env.MUSIC_KV.put("jsmediatags_3_9_5", body, { expirationTtl: 604800 });
        } catch (putErr) {}
        return new Response(body, {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=604800"
          }
        });
      } catch (e) {
        return new Response("// jsmediatags unavailable", {
          headers: { ...corsHeaders, "Content-Type": "application/javascript" }
        });
      }
    }

    if (url.pathname === "/og-icon.png" || url.pathname === "/favicon.ico") {
      return new Response(decodeOgIconPng(), {
        headers: {
          ...corsHeaders,
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=604800"
        }
      });
    }

    if (url.pathname === "/icon.svg") {
      return new Response(OG_ICON_SVG, {
        headers: {
          ...corsHeaders,
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=604800"
        }
      });
    }

    const getCookieToken = () => {
      const cookie = request.headers.get("Cookie") || "";
      const match = cookie.match(/admin_token=([^;]+)/);
      if (!match) return null;
      const token = decodeURIComponent(match[1]);
      return /^[0-9a-f]{64}$/.test(token) ? token : null;
    };

    const requireAdmin = async () => {
      const adminPass = await env.MUSIC_KV.get("admin_pass");
      if (!adminPass) return false;
      const headerPass = request.headers.get("x-admin-pass");
      if (headerPass) {
        if (/^[0-9a-f]{64}$/.test(adminPass)) {
          if ((await hashAdminPass(headerPass)) === adminPass) return true;
        } else {
          if (headerPass === adminPass) {
            await env.MUSIC_KV.put("admin_pass", await hashAdminPass(headerPass));
            return true;
          }
        }
      }
      return isSessionValid(env, getCookieToken());
    };

    if (url.pathname === "/api/status") {
      const adminPass = await env.MUSIC_KV.get("admin_pass");
      const sources = (await env.MUSIC_KV.get("dav_sources", { type: "json" })) || [];
      const siteTitle = (await env.MUSIC_KV.get("site_title")) || "我的多源音乐库";
      const isAdmin = await requireAdmin();

      return new Response(JSON.stringify({
        isInitialized: !!adminPass,
        isAdmin: isAdmin,
        title: siteTitle,
        sources: sources.map(s => ({ id: s.id, name: s.name }))
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/admin/init" && request.method === "POST") {
      const existingPass = await env.MUSIC_KV.get("admin_pass");
      if (existingPass) return new Response(JSON.stringify({ error: "已初始化" }), { status: 400, headers: corsHeaders });

      const { adminPass, siteTitle } = await request.json();
      if (!adminPass) return new Response(JSON.stringify({ error: "密码必填" }), { status: 400, headers: corsHeaders });
      if (typeof adminPass !== "string" || adminPass.length < 8) return new Response(JSON.stringify({ error: "密码长度至少 8 位" }), { status: 400, headers: corsHeaders });

      await env.MUSIC_KV.put("admin_pass", await hashAdminPass(adminPass));
      if (siteTitle) await env.MUSIC_KV.put("site_title", siteTitle);

      const headers = new Headers(corsHeaders);
      headers.set("Content-Type", "application/json");
      headers.append("Set-Cookie", sessionCookie(await createSession(env)));
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const rlKey = "rl_login_" + ip;
      const rlCount = parseInt((await env.MUSIC_KV.get(rlKey)) || "0", 10);
      if (rlCount >= 5) {
        const rlHeaders = new Headers(corsHeaders);
        rlHeaders.set("Retry-After", "600");
        return new Response(JSON.stringify({ error: "尝试过于频繁，请 10 分钟后再试" }), { status: 429, headers: rlHeaders });
      }

      const { adminPass } = await request.json();
      const realPass = await env.MUSIC_KV.get("admin_pass");
      const realHashed = realPass && /^[0-9a-f]{64}$/.test(realPass);
      const passEq = realPass && typeof adminPass === "string" ? (realHashed ? (await hashAdminPass(adminPass)) === realPass : adminPass === realPass) : false;

      if (!realPass || !passEq) {
        await env.MUSIC_KV.put(rlKey, String(rlCount + 1), { expirationTtl: 600 });
        return new Response(JSON.stringify({ error: "密码错误" }), { status: 403, headers: corsHeaders });
      }

      if (!realHashed) await env.MUSIC_KV.put("admin_pass", await hashAdminPass(adminPass));

      await env.MUSIC_KV.delete(rlKey);

      const headers = new Headers(corsHeaders);
      headers.set("Content-Type", "application/json");
      headers.append("Set-Cookie", sessionCookie(await createSession(env)));
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    if (url.pathname === "/api/admin/sources" && request.method === "GET") {
      if (!(await requireAdmin())) return new Response(JSON.stringify({ error: "未授权" }), { status: 403, headers: corsHeaders });

      const sources = (await env.MUSIC_KV.get("dav_sources", { type: "json" })) || [];
      return new Response(JSON.stringify(sources), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/admin/sources" && request.method === "POST") {
      if (!(await requireAdmin())) return new Response(JSON.stringify({ error: "未授权" }), { status: 403, headers: corsHeaders });

      const { sources, siteTitle, newAdminPass } = await request.json();
      if (newAdminPass && (typeof newAdminPass !== "string" || newAdminPass.length < 8)) return new Response(JSON.stringify({ error: "新密码长度至少 8 位" }), { status: 400, headers: corsHeaders });
      if (sources && !Array.isArray(sources)) return new Response(JSON.stringify({ error: "源配置格式无效" }), { status: 400, headers: corsHeaders });
      if (sources && sources.some(s => !s || typeof s !== "object" || !isValidSourceUrl(s.url))) {
        return new Response(JSON.stringify({ error: "源配置无效：url 必须为 http/https 且格式合法" }), { status: 400, headers: corsHeaders });
      }

      if (siteTitle) await env.MUSIC_KV.put("site_title", siteTitle);

      const listKeys = await env.MUSIC_KV.list({ prefix: "cache_v3_list_" });
      for (const k of listKeys.keys) {
        await env.MUSIC_KV.delete(k.name);
      }

      if (sources) {
        const oldSources = (await env.MUSIC_KV.get("dav_sources", { type: "json" })) || [];
        await env.MUSIC_KV.put("dav_sources", JSON.stringify(sources));
        const keptIds = new Set(sources.map(s => s && typeof s.id === "string" ? s.id : null));
        for (const oldSrc of oldSources) {
          const oldId = oldSrc && typeof oldSrc.id === "string" ? oldSrc.id : null;
          if (oldId === null) continue;
          const oldKey = shareIndexSourceKey(oldId);
          if (oldKey === null || keptIds.has(oldId)) continue;
          try {
            await env.MUSIC_KV.delete(oldKey);
          } catch (e) {}
        }
      }

      const headers = new Headers(corsHeaders);
      headers.set("Content-Type", "application/json");
      if (newAdminPass) {
        await env.MUSIC_KV.put("admin_pass", await hashAdminPass(newAdminPass));
        const oldSessions = await env.MUSIC_KV.list({ prefix: "session_" });
        for (const k of oldSessions.keys) {
          await env.MUSIC_KV.delete(k.name);
        }
        headers.append("Set-Cookie", sessionCookie(await createSession(env)));
      }

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    if (url.pathname === "/api/admin/logout") {
      const token = getCookieToken();
      if (token) await env.MUSIC_KV.delete("session_" + token);
      const headers = new Headers(corsHeaders);
      headers.set("Content-Type", "application/json");
      headers.append("Set-Cookie", clearedSessionCookie());
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    if (url.pathname === "/api/list") {
      const sources = (await env.MUSIC_KV.get("dav_sources", { type: "json" })) || [];
      if (sources.length === 0) {
        return new Response(JSON.stringify({ items: [], debugs: [] }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const targetSourceId = url.searchParams.get("sourceId") || "all";
      const rawRefresh = url.searchParams.get("refresh") === "true";

      const isAdmin = await requireAdmin();
      const canForceRefresh = isAdmin && rawRefresh;

      const cacheKey = `cache_v3_list_${encodeURIComponent(targetSourceId)}`;
      const lockKey = `lock_sync_${encodeURIComponent(targetSourceId)}`;

      if (!canForceRefresh) {
        const cachedData = await env.MUSIC_KV.get(cacheKey, "json");
        if (cachedData) {
          const out = { ...cachedData, fromCache: true, isAdmin: isAdmin };
          if (!isAdmin) {
            out.debugs = [];
            if (out.diagnostics && out.diagnostics.length > 0 && !out.notice) out.notice = "部分源暂不可用（详情仅管理员可见）";
            out.diagnostics = null;
          }
          return new Response(JSON.stringify(out), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
        }
      } else {
        const lastSync = await env.MUSIC_KV.get(lockKey);
        if (lastSync && Date.now() - parseInt(lastSync) < 30000) {
          const cachedData = await env.MUSIC_KV.get(cacheKey, "json");
          if (cachedData) {
            return new Response(JSON.stringify({
              ...cachedData,
              fromCache: true,
              isAdmin: true,
              notice: "刚刚已完成同步，网盘处于冷却期（请30秒后再试）"
            }), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
          }
        }
        await env.MUSIC_KV.put(lockKey, Date.now().toString(), { expirationTtl: 60 });
      }

      try {
        let finalItems = [];
        let debugLogs = [];
        let diagnosticErrors = [];

        if (targetSourceId === "all") {
          const songMap = new Map();

          for (const src of sources) {
            const res = await fetchWebDavList(src, env);
            debugLogs.push(res.debug);

            if (res.diagnostic) diagnosticErrors.push(res.diagnostic);
            if (res.items) {
              res.items.forEach(item => {
                const normKey = normalizeSongKey(item.name);
                if (!songMap.has(normKey)) {
                  item.id = generateTrackId(item.name);
                  item.availableNodes = [{ sourceId: src.id, href: item.href }];
                  songMap.set(normKey, item);
                } else {
                  const existSong = songMap.get(normKey);
                  if (!existSong.availableNodes.some(n => n.sourceId === src.id && n.href === item.href)) {
                    existSong.availableNodes.push({ sourceId: src.id, href: item.href });
                  }
                }
              });
            }
          }
          finalItems = Array.from(songMap.values());
        } else {
          const src = sources.find(s => String(s.id) === String(targetSourceId));
          if (!src) {
            if (!isAdmin) {
              return new Response(JSON.stringify({ error: "指定的源不存在", items: [] }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({
              error: "指定的源不存在",
              diagnostic: { title: "配置源丢失", cause: `ID ${targetSourceId} 未找到`, solution: "请在设置中检查源配置。" },
              items: []
            }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }

          const res = await fetchWebDavList(src, env);
          const singleMap = new Map();
          (res.items || []).forEach(i => {
            const normKey = normalizeSongKey(i.name);
            if (!singleMap.has(normKey)) {
              i.id = generateTrackId(i.name);
              i.availableNodes = [{ sourceId: src.id, href: i.href }];
              singleMap.set(normKey, i);
            }
          });
          finalItems = Array.from(singleMap.values());

          debugLogs = [res.debug];
          if (res.diagnostic) diagnosticErrors = [res.diagnostic];
        }

        finalItems.sort((a, b) => {
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

        const responsePayload = {
          items: finalItems,
          debugs: debugLogs,
          diagnostics: diagnosticErrors.length > 0 ? diagnosticErrors : null,
          fromCache: false,
          isAdmin: isAdmin
        };

        if (finalItems.length > 0) {
          await env.MUSIC_KV.put(cacheKey, JSON.stringify(responsePayload), { expirationTtl: 1800 });
          try {
            const bySource = {};
            for (const item of finalItems) {
              const nodes = item && Array.isArray(item.availableNodes) ? item.availableNodes : [];
              for (const node of nodes) {
                if (!node || typeof node.sourceId !== "string") continue;
                if (!bySource[node.sourceId]) bySource[node.sourceId] = [];
                bySource[node.sourceId].push(item);
              }
            }
            for (const sourceId of Object.keys(bySource)) {
              const indexKey = shareIndexSourceKey(sourceId);
              if (!indexKey) continue;
              await env.MUSIC_KV.put(indexKey, JSON.stringify(normalizeShareIndexPairs(bySource[sourceId])));
            }
          } catch (e) {}
        }

        const out = { ...responsePayload };
        if (!isAdmin) {
          out.debugs = [];
          if (diagnosticErrors.length > 0 && !out.notice) out.notice = "部分源暂不可用（详情仅管理员可见）";
          out.diagnostics = null;
        }
        return new Response(JSON.stringify(out), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
      } catch (e) {
        const errorPayload = isAdmin
          ? {
              error: e.message,
              diagnostic: { title: "Worker 执行异常", cause: e.stack || e.message, solution: "请检查后台配置。" },
              items: []
            }
          : { error: "服务繁忙，请稍后再试", items: [] };
        return new Response(JSON.stringify(errorPayload), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/api/stream") {
      const sourceId = url.searchParams.get("sourceId");
      const rawFile = url.searchParams.get("file");
      const sources = (await env.MUSIC_KV.get("dav_sources", { type: "json" })) || [];
      const src = sources.find(s => String(s.id) === String(sourceId));

      let streamAdmin = null;
      const requireAdminSafe = async () => {
        if (streamAdmin === null) {
          try {
            streamAdmin = await requireAdmin();
          } catch (e) {
            streamAdmin = false;
          }
        }
        return streamAdmin;
      };

      if (!src || !rawFile) {
        return new Response(JSON.stringify({ error: "缺少源或路径参数" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (/^https?:\/\//i.test(rawFile)) {
        return streamPathReject(rawFile, request.method, src.name, corsHeaders, await requireAdminSafe());
      }

      const targetUrl = resolveWebDavUrl(src.url, rawFile);

      if (!assertStreamPathContained(src.url, targetUrl)) {
        return streamPathReject(targetUrl, request.method, src.name, corsHeaders, await requireAdminSafe());
      }

      if (!/\.(mp3|flac|m4a|ogg|wav|aac|ape|alac|opus|wma|dsd|dsf|dff|mka)$/i.test(rawFile)) {
        return streamPathReject(targetUrl, request.method, src.name, corsHeaders, await requireAdminSafe());
      }

      const isHead = request.method === "HEAD";

      const forwardHeaders = new Headers();
      if (src.user || src.pass) {
        forwardHeaders.set("Authorization", "Basic " + btoa(unescape(encodeURIComponent(`${src.user || ""}:${src.pass || ""}`))));
      }

      const rawClientRange = request.headers.get("Range");
      const clientRange = parseSingleByteRange(rawClientRange);
      if (rawClientRange) {
        forwardHeaders.set("Range", rawClientRange);
        forwardHeaders.set("Accept-Encoding", "identity");
      }

      if (isHead) {
        forwardHeaders.set("Range", "bytes=0-0");
        forwardHeaders.set("Accept-Encoding", "identity");
      }

      const upstreamTimeoutMs = parseUpstreamTimeoutMs(env && env.STREAM_FETCH_TIMEOUT_MS);
      const upstreamAbort = new AbortController();
      try {
        if (request.signal) {
          if (request.signal.aborted) upstreamAbort.abort();
          else request.signal.addEventListener("abort", () => upstreamAbort.abort());
        }
      } catch (sigErr) {}
      const upstreamTimer = setTimeout(() => upstreamAbort.abort(), upstreamTimeoutMs);
      let res;
      try {
        try {
          res = await fetch(targetUrl, {
            method: isHead ? "GET" : request.method,
            headers: forwardHeaders,
            signal: upstreamAbort.signal
          });
        } finally {
          clearTimeout(upstreamTimer);
        }

        if (isHead && (res.ok || res.status === 206 || res.status === 416)) {
          let headTotal = parseContentRangeTotal(res.headers.get("Content-Range"));
          if (headTotal === null && res.status === 200) {
            const headLength = res.headers.get("Content-Length");
            headTotal = headLength && /^\d+$/.test(headLength) ? parseInt(headLength, 10) : null;
          }
          const headHeaders = new Headers();
          headHeaders.set("Access-Control-Allow-Origin", "*");
          headHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
          headHeaders.set("Access-Control-Allow-Headers", "*");
          headHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
          headHeaders.set("Accept-Ranges", "bytes");
          const headType = res.headers.get("Content-Type") || audioContentTypeFor(rawFile);
          if (headType) headHeaders.set("Content-Type", headType);
          if (headTotal !== null) headHeaders.set("Content-Length", String(headTotal));
          const headLastModified = res.headers.get("Last-Modified");
          if (headLastModified) headHeaders.set("Last-Modified", headLastModified);
          const headEtag = res.headers.get("ETag");
          if (headEtag) headHeaders.set("ETag", headEtag);
          try { if (res.body) res.body.cancel(); } catch (cancelErr) {}
          return new Response(null, { status: 200, statusText: "OK", headers: headHeaders });
        }

        if (res.status === 416) {
          const rangeRejectHeaders = new Headers(res.headers);
          rangeRejectHeaders.set("Access-Control-Allow-Origin", "*");
          rangeRejectHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
          rangeRejectHeaders.set("Access-Control-Allow-Headers", "*");
          rangeRejectHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
          if (!rangeRejectHeaders.get("Content-Range")) {
            const rejectLength = res.headers.get("Content-Length");
            if (rejectLength && /^\d+$/.test(rejectLength)) {
              rangeRejectHeaders.set("Content-Range", "bytes */" + rejectLength);
            }
          }
          rangeRejectHeaders.delete("Content-Length");
          rangeRejectHeaders.delete("Accept-Ranges");
          return new Response(null, {
            status: 416,
            statusText: res.statusText || "Range Not Satisfiable",
            headers: rangeRejectHeaders
          });
        }

        if (!res.ok && res.status !== 206) {
          const bodyText = await res.text().catch(() => "");
          const diag = generateDiagnostic(res.status, res.statusText, targetUrl, request.method, src.name, bodyText);
          if (await requireAdminSafe()) {
            return new Response(JSON.stringify({ error: diag.title, diagnostic: diag }), {
              status: res.status,
              headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
            });
          }
          return new Response(JSON.stringify({ error: "源站响应异常", diagnostic: null }), {
            status: res.status,
            headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
          });
        }

        const respHeaders = new Headers(res.headers);
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
        respHeaders.set("Access-Control-Allow-Headers", "*");
        respHeaders.set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
        if (!respHeaders.get("Content-Type")) {
          const fallbackType = audioContentTypeFor(rawFile);
          if (fallbackType) respHeaders.set("Content-Type", fallbackType);
        }

        const upstreamLengthRaw = res.headers.get("Content-Length");
        const upstreamTotal = upstreamLengthRaw && /^\d+$/.test(upstreamLengthRaw) ? parseInt(upstreamLengthRaw, 10) : null;

        if (clientRange && res.status === 200 && upstreamTotal !== null && !res.headers.get("Content-Encoding")) {
          const clientStart = clientRange.suffix !== null ? Math.max(0, upstreamTotal - clientRange.suffix) : clientRange.start;
          if (clientStart >= upstreamTotal) {
            respHeaders.set("Content-Range", "bytes */" + upstreamTotal);
            respHeaders.delete("Content-Length");
            respHeaders.delete("Accept-Ranges");
            return new Response(null, { status: 416, statusText: "Range Not Satisfiable", headers: respHeaders });
          }
          const rangeEnd = clientRange.end !== null ? Math.min(clientRange.end, upstreamTotal - 1) : upstreamTotal - 1;
          const rangeCount = rangeEnd - clientStart + 1;
          const segConcurrency = parseSegmentConcurrency(env && env.STREAM_SEGMENT_CONCURRENCY);
          let segPartSize = parseSegmentPartSize(env && env.STREAM_SEGMENT_PART_SIZE);
          const segMaxSegments = parseSegmentMaxSegments(env && env.STREAM_SEGMENT_MAX_SEGMENTS);
          const segMergeBytes = parseSegmentMergeBytes(env && env.STREAM_SEGMENT_MERGE_BYTES);
          if (rangeCount > segPartSize) {
            let segCount = Math.ceil(rangeCount / segPartSize);
            if (segCount > segMaxSegments) {
              segCount = segMaxSegments;
              segPartSize = Math.ceil(rangeCount / segCount);
            }
            const firstRangeStart = clientStart;
            const fanoutAbort = new AbortController();
            try {
              if (request.signal) {
                if (request.signal.aborted) fanoutAbort.abort();
                else request.signal.addEventListener("abort", () => fanoutAbort.abort());
              }
            } catch (sigErr) {}
            const firstSegEnd = Math.min(firstRangeStart + segPartSize - 1, rangeEnd);
            const firstSegHeaders = new Headers(forwardHeaders);
            firstSegHeaders.set("Range", "bytes=" + firstRangeStart + "-" + firstSegEnd);
            let firstSegRes = null;
            let probeErr = null;
            for (let probeAttempt = 0; probeAttempt < 3; probeAttempt++) {
              const probeAbort = new AbortController();
              try {
                if (request.signal) {
                  if (request.signal.aborted) probeAbort.abort();
                  else request.signal.addEventListener("abort", () => probeAbort.abort());
                }
              } catch (probeSigErr) {}
              const probeTimer = setTimeout(() => probeAbort.abort(), upstreamTimeoutMs);
              try {
                firstSegRes = await fetch(targetUrl, {
                  method: "GET",
                  headers: firstSegHeaders,
                  signal: probeAbort.signal
                });
                if (firstSegRes.status === 206 && firstSegRes.body) break;
                if (firstSegRes.status !== 206) {
                  const retryableProbe = firstSegRes.status === 429 || firstSegRes.status >= 500;
                  if (!retryableProbe || fanoutAbort.signal.aborted) break;
                  try { if (firstSegRes.body) firstSegRes.body.cancel(); } catch (cancelErr) {}
                  firstSegRes = null;
                }
              } catch (probeFetchErr) {
                if (fanoutAbort.signal.aborted) { probeErr = probeFetchErr; break; }
                if (probeAttempt === 2) break;
                firstSegRes = null;
              } finally {
                clearTimeout(probeTimer);
              }
            }
            if (probeErr) {
              try { if (res.body) res.body.cancel(); } catch (cancelErr) {}
              throw probeErr;
            }
            if (firstSegRes && firstSegRes.status === 206 && !probeContentRangeOk(firstSegRes.headers.get("Content-Range"), firstRangeStart, firstSegEnd)) {
              try { if (firstSegRes.body) firstSegRes.body.cancel(); } catch (cancelErr) {}
              firstSegRes = null;
            }
            if (!firstSegRes || firstSegRes.status !== 206 || !firstSegRes.body || res.headers.get("Content-Encoding")) {
              if (firstSegRes) {
                try { if (firstSegRes.body) firstSegRes.body.cancel(); } catch (cancelErr) {}
              }
              const reSliced = sliceReadableStream(res.body, clientStart, rangeCount);
              if (reSliced) {
                respHeaders.set("Content-Range", "bytes " + clientStart + "-" + rangeEnd + "/" + upstreamTotal);
                respHeaders.set("Content-Length", String(rangeCount));
                respHeaders.set("Accept-Ranges", "bytes");
                return new Response(reSliced, { status: 206, statusText: "Partial Content", headers: respHeaders });
              }
              respHeaders.delete("Accept-Ranges");
              return new Response(res.body, { status: res.status, statusText: res.statusText, headers: respHeaders });
            }
            const planned = [];
            let segStart = firstRangeStart + segPartSize;
            while (segStart <= rangeEnd) {
              const segEnd = Math.min(segStart + segPartSize - 1, rangeEnd);
              planned.push({ start: segStart, end: segEnd });
              segStart = segEnd + 1;
            }
            const segFetch = async (idx) => {
              const spec = planned[idx];
              const segHeaders = new Headers(forwardHeaders);
              segHeaders.set("Range", "bytes=" + spec.start + "-" + spec.end);
              const segAbort = new AbortController();
              let segTimer = null;
              try {
                if (request.signal) {
                  if (request.signal.aborted) segAbort.abort();
                  else request.signal.addEventListener("abort", () => segAbort.abort());
                }
              } catch (sigErr) {}
              let segRes;
              try {
                try {
                  segTimer = setTimeout(() => segAbort.abort(), upstreamTimeoutMs);
                  segRes = await fetch(targetUrl, { method: "GET", headers: segHeaders, signal: segAbort.signal });
                } finally {
                  clearTimeout(segTimer);
                }
              } catch (segErr) {
                return { status: 0, stream: null };
              }
              return { status: segRes.status, stream: segRes.body };
            };
            const segments = planned.map((spec) => spec.end - spec.start + 1);
            const agg = aggregateSegmentedStream(segFetch, segments, {
              concurrency: segConcurrency,
              mergeBytes: segMergeBytes,
              signal: fanoutAbort.signal
            });
            if (!agg) {
              const reSliced = sliceReadableStream(res.body, clientStart, rangeCount);
              if (reSliced) {
                respHeaders.set("Content-Range", "bytes " + clientStart + "-" + rangeEnd + "/" + upstreamTotal);
                respHeaders.set("Content-Length", String(rangeCount));
                respHeaders.set("Accept-Ranges", "bytes");
                return new Response(reSliced, { status: 206, statusText: "Partial Content", headers: respHeaders });
              }
              respHeaders.delete("Accept-Ranges");
              return new Response(res.body, { status: res.status, statusText: res.statusText, headers: respHeaders });
            }
            try { if (res.body) res.body.cancel(); } catch (cancelErr) {}
            const firstBodyLen = Math.min(segPartSize, rangeCount);
            const bridged = new ReadableStream({
              start(c) {
                const reader = firstSegRes.body.getReader();
                let sent = 0;
                const pump = async () => {
                  try {
                    for (;;) {
                      const chunk = await reader.read();
                      if (chunk.done) {
                        if (sent < firstBodyLen) {
                          c.error(new Error("first segment body ended after " + sent + " of " + firstBodyLen + " bytes"));
                          return;
                        }
                        c.close();
                        return;
                      }
                      if (sent + chunk.value.byteLength > firstBodyLen) {
                        const remain = firstBodyLen - sent;
                        if (remain > 0) c.enqueue(chunk.value.subarray(0, remain));
                        sent = firstBodyLen;
                        try { await reader.cancel(); } catch (cancelErr) {}
                        c.close();
                        return;
                      }
                      sent += chunk.value.byteLength;
                      c.enqueue(chunk.value);
                      if (sent >= firstBodyLen) {
                        try { await reader.cancel(); } catch (cancelErr) {}
                        c.close();
                        return;
                      }
                    }
                  } catch (e) {
                    c.error(e);
                  }
                };
                pump();
              }
            });
            const joined = new ReadableStream({
              async pull(controller) {
                try {
                  const chunk = await bridgeReader.read();
                  if (!chunk.done) {
                    controller.enqueue(chunk.value);
                    return;
                  }
                  const achunk = await aggReader.read();
                  if (!achunk.done) {
                    controller.enqueue(achunk.value);
                    return;
                  }
                  controller.close();
                } catch (e) {
                  controller.error(e);
                }
              },
              cancel(reason) {
                try { bridgeReader.cancel(reason); } catch (cErr) {}
                try { aggReader.cancel(reason); } catch (cErr) {}
              }
            });
            const bridgeReader = bridged.getReader();
            const aggReader = agg.getReader();
            respHeaders.delete("Content-Range");
            respHeaders.delete("Content-Length");
            respHeaders.set("Content-Range", "bytes " + clientStart + "-" + rangeEnd + "/" + upstreamTotal);
            respHeaders.set("Content-Length", String(rangeCount));
            respHeaders.set("Accept-Ranges", "bytes");
            return new Response(joined, { status: 206, statusText: "Partial Content", headers: respHeaders });
          }
          const sliced = sliceReadableStream(res.body, clientStart, rangeCount);
          if (sliced) {
            respHeaders.set("Content-Range", "bytes " + clientStart + "-" + rangeEnd + "/" + upstreamTotal);
            respHeaders.set("Content-Length", String(rangeCount));
            respHeaders.set("Accept-Ranges", "bytes");
            return new Response(sliced, { status: 206, statusText: "Partial Content", headers: respHeaders });
          }
          respHeaders.delete("Accept-Ranges");
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers: respHeaders });
        }

        if (res.status === 206) {
          respHeaders.set("Accept-Ranges", "bytes");
        }

        if (clientRange && res.status === 200 && res.headers.get("Content-Encoding")) {
          respHeaders.delete("Accept-Ranges");
        }

        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: respHeaders
        });
      } catch (networkErr) {
        const isAbort = networkErr && networkErr.name === "AbortError";
        const diag = generateDiagnostic(isAbort ? 504 : 0, networkErr.message, targetUrl, request.method, src.name, "");
        if (await requireAdminSafe()) {
          return new Response(JSON.stringify({ error: diag.title, diagnostic: diag }), {
            status: isAbort ? 504 : 502,
            headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
          });
        }
        return new Response(JSON.stringify({ error: isAbort ? "源站响应超时" : "无法连通源站", diagnostic: null }), {
          status: isAbort ? 504 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
        });
      }
    }

    const pageHeaders = new Headers({ "Content-Type": "text/html; charset=utf-8" });
    pageHeaders.set("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src-elem * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * https: http: data: blob:; media-src * data: blob: https: http:; img-src * data: blob: https: http:; style-src * 'unsafe-inline'; font-src * data: blob:;");
    pageHeaders.set("Cache-Control", "no-store");

    const playId = url.searchParams.get("play") || url.searchParams.get("v") || url.searchParams.get("id");
    let siteTitle = "";
    try {
      siteTitle = (await env.MUSIC_KV.get("site_title")) || "";
    } catch (e) {
      siteTitle = "";
    }
    const sharedSongName = await resolveSharedSongName(env, playId);
    let html = renderHTML();
    const coverId = playId && /^[0-9a-f]{8}$/i.test(playId) ? playId.toLowerCase() : null;
    html = html.replace("<!--SHARE_HEAD-->", () => buildShareHeadHtml(url.href, sharedSongName, siteTitle, coverId));
    if (sharedSongName) {
      const sharedTitle = escapeHtmlText(shareTitleText(sharedSongName, siteTitle || "Cloud Music Hub"));
      html = html.replace("<title>Cloud Music Hub</title>", () => "<title>" + sharedTitle + "</title>");
    }
    return new Response(html, { headers: pageHeaders });
  }
};

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

const OG_ICON_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAANHElEQVR42u3d3XGcSBSAUYUwEagIgRAIgRAIgRDIgBAmhAmBEHjVGyEQgmy5esoqlUvWDwi673k4L1u71loSdT+gu+fh8al7AABi8U0AAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAMAOngnNNSAAAAGAAEAAAAIAAYAAAAQAAgABAAgABAACABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAAABgABAAAACAAGAAAAEAAIAAQAIAAQAAgAQAAgABAAgABAACABAACAAEACAAEAAIAAAAYDffwEACAAEAAIAEAAIAAQAIAAQAAgAQAAgABAAgABAACAAAAGAAEAAAAIAAYAAAAQAAgABAAgABAACABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAAABgABAAAACAAGAAAAEAAIAAQAIAASAAPBNAAGAAEAAAAIAAYAAAAQAAgABAAgABAACABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAAABgABAAAACAAGAAAAEAAIAAQAIAAQAAgAQAAgABAAgABAACABAACAAEACAAEAAIAAAAYAAQACAAEAAIAAAAYAAQAAAAgABgAAABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAQAAgABAAgABAACAAAAGAAEAAAAIAAYAAAAQAAgABAAgABAACABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAABDUAAgAAABgABAAAACAAGAAAAEAAIAAQAIAAQAAgAQAAgABAAgABAACABAACAAEACAAEAAIAAAAYAAQAAAAgABgAAABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAQAAgABAAQMYBMD8+dQ2bcw0IAEAAnNrkZwUCABAAgAAABAAgAAABAAgAQAAAAgAQAIAAAAEgAEAAAAJAAIAAAASAAAABAAgAAQACABAAAgAEACAABAAIAEAACAAQAIAAEAAgAAABIABAAAACQACAAAAEgAAAAQAIAAEAAgAQAIAAAAQAIAAAAQAIAEAAAAIAEACAAAAEAAgAQAAIABAAgAAQACAAAAEgAEAAAAJAAIAAAASAAAABAAgAAQACABAAAgAEACAABAAIAEAACAAQAIAAEAAgAAABIABAAAACABAAgAAABAAgAAABAAgAQAAAAgAQAIAAAAEACAABAAIAEAACAAQAIAAEAAgAQAAIABAAgAAQACAAAAEgAEAAAAJAAIAAAASAAAABAAgAAQACABAAAgAEACAABAAIAEAAAAIAEACAAAAEACAAAAEACABAAAACABAAIAB8E0AACAAQAIAAEAAgAAABIABAAAACQACAAAAEgAAAAQAIAAEAAgAQAAIABAAgAAQACABAAAgAEACAABAAIAAAASAAQAAAAsDPCwQAIAAAAQAIAEAAAAIAEACAAAAEACAAAN8EEAACAAQAIAAEAAgAQAAIABAAgAAQACAAAAEgAEAAAAJAAIAAAASAAAABAAgAAQACABAAAgAEACAABAAIAEAACAAQAIAA8LMCAQAIAEAAAAIAEACAAAAEACAAAAEACABAAIAAEAAgAAABIABAAAACQACAAAAEgAAAAQAIAAEAAgAQAAIABAAgAAQACABAAAgAEACAABAAIAAAASAAQAAAAkAAgAAABIAAAAEACABAAAACABAAgAAABAAgAAABAAgAQAAAAgAEACAABAAIAEAACAAQAIAAEAAgAAABIABAAAACQACAAAAEgAAAAQAIAAEAAgAQAAIABAAgAAQACABAAAgAEACAABAAIAAAAQAIAEAAAAIAEACAAAAEACAAAAEACABAAIAAAD7i8vjUNUn3+58Nb0z/8PbfadN/XwsAAQACAM6lfjXgXwbPvONgW9PXuKav16TQEAACAAQA7HxX/3JXPqYhc5aBt6Qo6Hd+WiAAQABAGE0a+HNGA/AeBN3GTwgEAAgAKFqbBuia0dB7z22jGBAAIACgyDv9kob+/2JAAAACgNDv9If0yPw5mDUFTy0AAAFApJX714BD/72B2QkAQABQ8mP+ycB/d/FgJwAAAYDBLwQEACAAMPiDh4AAAAEAp1Z5x795CDQCAAQAnNkQYCsfAgAEALx63L8YfggAEADE2cs/GnoIABAAuOtHALg+QABQ8Lt+ww4BAAKAQCv8Z0MOAQACgFiP/K3wRwCAACCQ3mBDAIAAIBaH+iAAQAAQbIuf9/0IABAAGP4gAEAAUKra8EcAgAAg3vC30h8BAAIAwx8EAAgADH8QACAAKGbBnzP9EQAgALDaHwQACABKZvgjAEAA4IQ/EAAgACiZj/NFAIAAIJjWkEIAgAAglsp2PwQACACs+AcBAAKAwo2GEwIABADe+4MAAAFA4Y/+vfdHAIAAIJiboYQAAAGAR/8gAEAA4NE/CAAQAFj1DwIABADZqg0iBAAIAOKZDCIEAAgALPwDAQACgMIthhACAAQAsXQGEAIABADu/kEAgADA3T8IABAAuPsHAQACAHf/IABAAGDfPwgAEAA49Q8EAAgAzuRq6CAAQAAQi0/8QwCAAMDiPxAAIACIYDZwEAAgAIilMmwQACAAiKc3bBAAIADw+B8EAAgAPP4HAQACAKv/QQCAACB7N4MGAQACgHgc/oMAAAFAMI0hgwAAAUA8gyGDAAABQDw++hcBAAIA7/9BAIAAwP5/EAAgAChOa8AgAEAAYAEgCAAQAFgACAIABAAlWgwYBAAIAOIxYBAAIAAIpjZcEAAgAHAEMAgAEAAE4COAEQAgALAFEAQACAAEAAgAEAA4AwAEAAgABAAIABAACAAQACAAEAAgAEAAIABAAIAAQACAAAABgAAAAQACAAEAAgAEAAIAAeBaBQGAAEAAAAIAAYAAAAQAAgABAAgABABFGFyrIADY1mi4IABAABCPjwNGAIAAQADAKbWuVRAAbKsxXMhA41oFAYAAIJ7KtQoCgO0ZMJyd6xQEADtYDRhObHaNggDAWQDEc3ONggDAWQDYAggIADbSGzLYAggCADsBwA4AEADYCQCHWV2bIACwEBALAAEBgIWAWAAICAC+qzVscAQwCADiuRg2eP8PAoCYZkMH7/9BABCPjwbmTHrXJAgAfkZt6GD/PwgAYloMHnwAEAgAbAcEj/9BAOA1AHj8DwIArwHA438QANgNAB7/gwAgX5UhxIEurkEQABzHhwNxhKtrDwQAx+oMI5z9DwIAiwFhb4trDgQAFgMST+eaAwHAOVzSJ7IZTrj7BwGApwCwucG1BgIATwGIZbX1DwQAngLg7h8QAHgKgLt/QADgKQBW/gMCgB9/CuBcAKz8BwGA0wHBqX8gAIjCZwSwhZtrCQQAeakNLzZY+Fe5lkAAYEEgtv0BAgALAinY7PoBAUDeGsOML6hdOyAA8CqAWHrXDAgAyjEbbHzA5FoBAUBZKscE47hfEAA4IAgc+AMCgEBGgw5b/kAA4JRAcNofCAACnQ9gUSD3/f7e+4MAIJDaokCL/gx/EACIAOINf4f9gADAzgAMf0AAIAIoWed3HgQAiADDHxAAiABD0vAHBAAiAMMfEACIACz4AwQAtghi+AMCgEIjYDFIsz3hr/I7DAIAvsqxwXme7e+EPxAAsImrwepT/QABQNzFgdYFnPd9f+t3FAQA7LkuwCsB7/sBAUDQdQGjweuRPyAAiKmxS+Awiy1+IADA0wB3/YAAgMOeBlgbsK/JXT8IADir3k6BXVb4O8sfBABk8VpgMLg3GfyDQ31AAEBuKgcIfdlo8AMCACEQ547/ak8/IAAoMQQGawQ86gcEAHHXCHR2Dfz5+1vcBwgAQqrTY+810N3+aDsfIADgr7bQGLi/2/dhPYAAgA/GwJLxUb2joQ8IAPje4sH+5EGwpP+/zip+QADAfkHQppXz0wFR8LJ475a+fmP1PiAA4PgFhU0azEO6I5+S+RPn7d9d05/Tpz/Xwj1AAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAABAAPgmAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAABAAAIAABAAAAAAgAAyNYvYmuUqGV56G4AAAAASUVORK5CYII=";

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

function generateDiagnostic(status, statusText, targetUrl, method, srcName, bodyPreview = "", contentType = "") {
  let title = `源【${srcName}】响应异常`;
  let cause = `HTTP ${status}: ${statusText}`;
  let solution = "请检查网盘配置。";

  if (bodyPreview.includes("Access for this IP has been blocked") || bodyPreview.includes("security system")) {
    title = `源【${srcName}】触发了网盘服务端的临时 IP 频控拦截 (403 WAF)`;
    cause = "网盘服务端（如 Koofr 安全策略）侦测到来自当前 Cloudflare 机房节点的短时请求较多，触发了防刷机制。";
    solution = "请勿连续频繁刷新。正常使用时系统已开启 KV 集中缓存保护网盘，通常等待 1~2 分钟即可自动解封恢复。";
  } else if (contentType.toLowerCase().includes("html") || bodyPreview.trim().startsWith("<!DOCTYPE") || bodyPreview.trim().startsWith("<html")) {
    title = `源【${srcName}】端点返回了网页而非 WebDAV`;
    cause = `请求返回了 HTTP ${status}，但响应内容是普通 HTML 网页，并非 WebDAV 数据。`;
    solution = "请确认 WebDAV 地址是否正确，不能填管理面板前端网页网址。";
  } else if (status === 401) {
    title = `源【${srcName}】认证失败 (401 Unauthorized)`;
    cause = "用户名或密码错误，或者 WebDAV 服务端未开放 Basic Auth 模式。";
    solution = "请在管理面板中核对账号和密码。";
  } else if (status === 403) {
    title = `源【${srcName}】访问受限 (403 Forbidden)`;
    cause = "服务端拒绝访问，可能是只读限制、IP 限制或防盗链拦截。";
    solution = "请检查网盘目录读取权限与 IP 安全策略。";
  } else if (status === 404) {
    title = `源【${srcName}】目标不存在 (404 Not Found)`;
    cause = `请求的路径在 WebDAV 服务器上未找到。目标 URL: ${targetUrl}`;
    solution = "请检查 URL 路径大小写（Linux 严格区分大小写）或子路径是否有误。";
  } else if (status === 405) {
    title = `源【${srcName}】方法不被支持 (405 Method Not Allowed)`;
    cause = `服务端拒绝了 ${method} 请求。常见于反代未配置 PROPFIND。`;
    solution = "请确认该存储支持标准 WebDAV 协议。";
  } else if (status === 0 || status === 502 || status >= 500) {
    title = `源【${srcName}】连接失败 (无法连通)`;
    cause = `Cloudflare 机房无法连通目标主机: ${statusText}。`;
    solution = "1. 请确认非 127.0.0.1 纯内网地址；2. 检查 DDNS 或端口映射。";
  }

  return {
    sourceName: srcName,
    status: status || 0,
    statusText: statusText || "Unknown",
    method: method,
    targetUrl: targetUrl,
    contentType: contentType,
    bodyPreview: bodyPreview.slice(0, 300),
    title: title,
    cause: cause,
    solution: solution,
    timestamp: new Date().toLocaleTimeString()
  };
}

async function hashAdminPass(p) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function isValidSourceUrl(u) {
  if (typeof u !== "string" || !/^https?:\/\//i.test(u)) return false;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch (e) {
    return false;
  }
}

async function createSession(env) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  await env.MUSIC_KV.put("session_" + token, JSON.stringify({ created: Date.now() }), { expirationTtl: 2592000 });
  return token;
}

async function isSessionValid(env, token) {
  if (!token) return false;
  return (await env.MUSIC_KV.get("session_" + token)) !== null;
}

function sessionCookie(token) {
  return "admin_token=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000";
}

function clearedSessionCookie() {
  return "admin_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
}

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

function parseSegmentPartSize(raw) {
  const FALLBACK = 1048576;
  const MIN = 65536;
  const MAX = 8388608;
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
  const MERGE_STALL_MS = 40;
  const STALL_DEADLINE_MS = 1500;
  const STALL = Symbol("stall");
  let failed = null;
  let cancelRequested = false;
  const readers = new Map();
  const queues = new Map();
  const pendingSeg = new Map();
  const inFlight = new Set();
  let wake = null;
  let consumeIndex = 0;
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };

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
                continue;
              }
              controller.enqueue(item.value);
              return;
            }
            if (readers.has(i) || inFlight.has(i)) {
              await new Promise((resolve) => { wake = resolve; });
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

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Cloud Music Hub</title>
  <!--SHARE_HEAD-->
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%231ed760'%3E%3Cpath d='M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'/%3E%3C/svg%3E">

  <style>
    :root {
      --bg: #121212;
      --panel: #181818;
      --card: #1f1f1f;
      --card-subtle: #252525;
      --accent: #1ed760;
      --accent-hover: #1db954;
      --text: #ffffff;
      --sub: #b3b3b3;
      --border: #2f333a;
      --danger: #f3727f;
      --danger-fg: #fca5a5;
      --danger-border-soft: rgba(243,114,127,0.4);
      --danger-bg-soft: rgba(243,114,127,0.2);
      --danger-border-mid: rgba(243,114,127,0.5);
      --danger-bg-hover: rgba(243,114,127,0.35);
      --danger-bg-faint: rgba(243,114,127,0.15);
      --warning: #ffa42b;
      --info: #539df5;
      --shadow-card: 0 8px 8px rgba(0, 0, 0, 0.3);
      --shadow-dialog: 0 8px 24px rgba(0, 0, 0, 0.5);
      --radius-control: 8px;
      --radius-card: 8px;
      --radius-pill: 9999px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; display: flex; height: 100vh; overflow: hidden; }

    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.16) transparent;
    }
    *::-webkit-scrollbar { width: 5px; height: 5px; }
    *::-webkit-scrollbar-track { background: transparent; }
    *::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.16); border-radius: 4px; }
    *::-webkit-scrollbar-thumb:hover { background: var(--accent); }

    .md-icon { width: 20px; height: 20px; fill: currentColor; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .md-icon-sm { width: 16px; height: 16px; }
    .md-icon-lg { width: 24px; height: 24px; }

    #sidebar { position: fixed; left: 50%; right: auto; bottom: calc(var(--bar-height, 86px) + 12px + env(safe-area-inset-bottom, 0px)); z-index: 80; width: min(860px, 94vw); height: 460px; max-height: min(480px, calc(100dvh - 120px)); background: rgba(24, 24, 24, 0.94); -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px); border: 1px solid var(--border); border-radius: 16px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; transform: translate(-50%, 20px) scale(0.97); transform-origin: center bottom; visibility: hidden; opacity: 0; will-change: transform, opacity; transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.28s cubic-bezier(0.16, 1, 0.3, 1), visibility 0s linear 0.28s; box-shadow: var(--shadow-dialog); overscroll-behavior: contain; }
    #sidebar.drawer-open { transform: translate(-50%, 0) scale(1); visibility: visible; opacity: 1; transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.28s cubic-bezier(0.16, 1, 0.3, 1); }
    #sidebar-backdrop { position: fixed; inset: 0; z-index: 70; display: none; background: rgba(0,0,0,0.6); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); overscroll-behavior: contain; }
    #sidebar-backdrop.drawer-open { display: block; }
    .side-header { padding: 16px 18px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .brand-group { display: flex; align-items: center; gap: 8px; font-weight: 700; color: #fff; font-size: 1.1rem; }
    
    .source-bar { padding: 10px 18px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
    .select-box { flex: 1; background: var(--card); border: 1px solid var(--border); color: #fff; padding: 7px 10px; border-radius: var(--radius-control); outline: none; font-size: 0.85rem; }

    .playlist-list-wrap { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; position: relative; }
    #track-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; list-style: none; overscroll-behavior: contain; }
    #playlist-current-locate { display: none; position: absolute; right: 12px; bottom: 12px; z-index: 2; align-items: center; gap: 5px; background: rgba(31,31,31,0.76); border: 1px solid var(--accent); color: var(--accent); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); box-shadow: var(--shadow-card); }
    #playlist-current-locate.show { display: inline-flex; }
    #track-list li { padding: 12px 18px; border-bottom: 1px solid rgba(255,255,255,0.02); cursor: pointer; display: flex; align-items: center; justify-content: space-between; font-size: 0.88rem; transition: 0.15s; }
    #track-list li:hover { background: var(--card); }
    #track-list li.active { background: rgba(30,215,96,0.12); border-left: 3px solid var(--accent); color: var(--accent); font-weight: bold; }
    .item-left { display: flex; align-items: center; gap: 10px; overflow: hidden; }
    .item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mirror-badge { font-size: 0.7rem; background: var(--card-subtle); color: var(--info); padding: 2px 8px; border-radius: var(--radius-pill); display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

    #main { flex: 1 1 auto; min-width: 0; min-height: 0; width: 100%; display: flex; flex-direction: column; }
    .stage { flex: 1 1 auto; min-width: 0; min-height: 0; display: grid; grid-template-columns: minmax(0, clamp(220px, 32vw, 420px)) minmax(0, 1fr); align-items: center; justify-content: center; gap: clamp(20px, 4vw, 56px); padding: 64px clamp(20px, 4vw, 48px) clamp(20px, 4vw, 48px); padding-bottom: calc(var(--bar-height, 86px) + 16px + env(safe-area-inset-bottom, 0px)); position: relative; overflow-y: auto; }
    .cover-box { width: min(100%, clamp(220px, 32vw, 420px)); aspect-ratio: 1; height: auto; border-radius: 16px; overflow: hidden; background: var(--card); border: 1px solid var(--border); box-shadow: var(--shadow-dialog); justify-self: center; flex-shrink: 0; }
    .cover-box img { width: 100%; height: 100%; object-fit: cover; }
    #main { position: relative; isolation: isolate; }
    #main::before { content: ""; position: absolute; inset: -12%; z-index: -1; pointer-events: none; background: radial-gradient(circle at 28% 36%, rgba(var(--cover-ambient-rgb, 18,18,18), 0.40), transparent 52%), radial-gradient(circle at 78% 72%, rgba(var(--cover-ambient-rgb, 18,18,18), 0.22), transparent 58%); filter: blur(28px) saturate(1.15); opacity: 0; transition: opacity 0.45s ease; }
    #main.has-cover-ambient::before { opacity: 1; }
    .stage { background: rgba(18,18,18,0.34); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); }
    #bar { background: rgba(24,24,24,0.78); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); }
    
    .lyrics-view { width: 100%; min-width: 0; min-height: 0; height: min(65vh, 480px); display: flex; flex-direction: column; position: relative; }
    .title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .song-title { font-size: clamp(1.2rem, 2.2vw, 1.7rem); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .btn-share { background: none; border: 1px solid var(--border); color: var(--sub); padding: 5px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; }
    .btn-share:hover { color: var(--accent); border-color: var(--accent); }
    .song-artist { font-size: 0.95rem; color: var(--sub); margin-bottom: 12px; }
    
    .lrc-viewport-wrap { flex: 1; position: relative; overflow: hidden; }
    .lrc-box { height: 100%; overflow-y: scroll; overscroll-behavior: contain; scroll-behavior: smooth; -webkit-mask-image: linear-gradient(180deg, transparent 0%, #fff 15%, #fff 85%, transparent 100%); mask-image: linear-gradient(180deg, transparent 0%, #fff 15%, #fff 85%, transparent 100%); }
    .lrc-content { padding: 140px 0; }
    
    .lrc-line { padding: 8px 12px; font-size: 1.05rem; color: var(--sub); transition: 0.2s; border-radius: var(--radius-control); cursor: pointer; display: flex; align-items: center; justify-content: space-between; }
    .lrc-line:hover { background: rgba(255,255,255,0.05); color: #fff; }
    .lrc-line.active { color: var(--accent); font-size: 1.25rem; font-weight: bold; background: rgba(30,215,96,0.08); }
    .lrc-time-hint { font-size: 0.75rem; color: var(--sub); opacity: 0; transition: opacity 0.2s; font-family: monospace; }
    .lrc-line:hover .lrc-time-hint { opacity: 1; color: var(--accent); }

    #resume-scroll-btn {
      display: none;
      position: absolute;
      bottom: 12px;
      right: 12px;
      background: var(--card-subtle);
      border: 1px solid var(--accent);
      color: var(--accent);
      font-size: 0.75rem;
      padding: 5px 10px;
      border-radius: 20px;
      cursor: pointer;
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      align-items: center;
      gap: 5px;
      z-index: 5;
    }
    #resume-scroll-btn:hover { background: var(--accent); color: #000; }

    #toast {
      display: none;
      position: fixed;
      bottom: 100px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--accent);
      color: #000;
      font-weight: 600;
      padding: 8px 18px;
      border-radius: var(--radius-pill);
      font-size: 0.85rem;
      z-index: 2000;
      box-shadow: var(--shadow-dialog);
    }

    #error-banner {
      display: none;
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      right: auto;
      max-width: calc(100vw - 148px);
      background: var(--panel);
      border: 1px solid var(--danger-border-soft);
      color: var(--danger-fg);
      padding: 10px 16px;
      border-radius: var(--radius-control);
      font-size: 0.85rem;
      z-index: 130;
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      box-shadow: var(--shadow-dialog);
    }
    .banner-left { display: flex; align-items: center; gap: 8px; overflow: hidden; min-width: 0; }
    #error-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .banner-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .btn-detail { background: var(--danger-bg-soft); border: 1px solid var(--danger-border-mid); color: #fff; padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; display: flex; align-items: center; gap: 4px; }
    .btn-detail:hover { background: var(--danger-bg-hover); }
    .banner-close { background: none; border: none; color: var(--danger-fg); cursor: pointer; display: flex; align-items: center; }
    .banner-close:hover { background: var(--danger-bg-hover); }
    .banner-close:focus-visible { outline: 2px solid var(--danger); }

    #bar { --bar-height: 86px; position: fixed; inset: auto 0 0 0; z-index: 50; width: 100%; min-height: var(--bar-height); height: auto; background: var(--panel); border-top: 1px solid var(--border); display: grid; grid-template-columns: minmax(130px, 1fr) minmax(280px, 2fr) minmax(130px, 1fr); align-items: center; gap: clamp(10px, 2vw, 24px); padding: 12px clamp(14px, 3vw, 28px); padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }
    #info-node { width: auto !important; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85rem; color: var(--sub); }
    .btn { background: var(--card-subtle); border: 1px solid var(--border); color: #fff; padding: 7px 16px; border-radius: var(--radius-pill); cursor: pointer; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .btn-icon { border-radius: 50%; padding: 8px; text-transform: none; letter-spacing: 0; }
    .btn:hover { border-color: var(--accent); color: var(--accent); }
    .btn-green { background: var(--accent); color: #000; font-weight: bold; border: none; box-shadow: 0 6px 18px rgba(30, 215, 96, 0.28); }
    .btn-green:hover { background: var(--accent-hover); color: #000; }

    .ctrl-group { width: 100%; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .ctrl-buttons { display: flex; align-items: center; gap: 16px; }
    .ctrl-icon-btn { background: none; border: none; color: var(--text); cursor: pointer; border-radius: 50%; padding: 6px; display: flex; align-items: center; justify-content: center; transition: 0.2s; }
    .ctrl-icon-btn:hover { color: var(--accent); background: rgba(255,255,255,0.05); }
    .play-btn-circle { background: var(--accent); color: #000; padding: 12px; border-radius: 50%; box-shadow: 0 6px 18px rgba(30, 215, 96, 0.35); }
    .play-btn-circle:hover { background: var(--accent-hover); color: #000; transform: scale(1.05); }
    
    .timeline-wrap { display: flex; align-items: center; width: 100%; gap: 10px; font-size: 0.75rem; color: var(--sub); }
    .progress-bar { flex: 1 1 auto; width: 100%; height: 5px; background: var(--border); border-radius: 3px; position: relative; cursor: pointer; }
    .progress-buffered { position: absolute; top: 0; height: 100%; background: rgba(255, 255, 255, 0.25); border-radius: 3px; width: 0%; pointer-events: none; }
    .progress-fill { position: relative; height: 100%; background: var(--accent); border-radius: 3px; width: 0%; pointer-events: none; }
    .progress-bar.is-seeking { opacity: 0.5; }

    .source-card { border: 1px solid var(--border); border-radius: var(--radius-card); margin-bottom: 10px; background: var(--card); overflow: hidden; box-shadow: var(--shadow-card); }
    .source-card-header { padding: 10px 14px; background: var(--card-subtle); display: flex; align-items: center; justify-content: space-between; cursor: pointer; -webkit-user-select: none; user-select: none; }
    .source-header-left { display: flex; align-items: center; gap: 8px; flex: 1; overflow: hidden; }
    .source-name-badge { font-weight: 600; font-size: 0.9rem; color: #fff; }
    .source-url-preview { font-size: 0.75rem; color: var(--sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
    .chevron-icon { transition: transform 0.2s ease; }
    .source-card.open .chevron-icon { transform: rotate(180deg); }
    .source-card-body { padding: 14px; border-top: 1px solid var(--border); display: none; }
    .source-card.open .source-card-body { display: block; }

    .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); -webkit-backdrop-filter: blur(5px); backdrop-filter: blur(5px); align-items: center; justify-content: center; z-index: 1000; }
    .modal.show { display: flex; }
    .modal-box { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: clamp(14px, 3vw, 24px); width: min(500px, 92vw); max-height: 85vh; overflow-y: auto; box-shadow: var(--shadow-dialog); }
    .app-dialog-msg { white-space: pre-wrap; line-height: 1.5; color: var(--text); }
    .input-row { margin-bottom: 12px; }
    .input-row label { display: block; font-size: 0.8rem; color: var(--sub); margin-bottom: 4px; }
    .input-row input { width: 100%; background: var(--bg); border: 1px solid var(--border); padding: 8px 10px; border-radius: 6px; color: #fff; outline: none; }
    .del-btn { background: none; border: none; color: var(--danger); cursor: pointer; padding: 4px; border-radius: 4px; display: flex; align-items: center; }
    .del-btn:hover { background: var(--danger-bg-faint); }
    .drag-handle { background: none; border: none; color: var(--sub); cursor: grab; padding: 4px; border-radius: 4px; display: flex; align-items: center; touch-action: none; -webkit-tap-highlight-color: transparent; }
    .drag-handle:hover { color: var(--accent); background: var(--card-subtle); }
    .drag-handle:active { cursor: grabbing; }
    .source-card.dragging { opacity: 0.45; }
    .drag-indicator-line { height: 2px; background: var(--accent); margin: -1px 0; border-radius: 1px; pointer-events: none; }

    #diag-modal .modal-box { width: min(580px, 92vw); }
    .diag-item { margin-bottom: 12px; font-size: 0.88rem; }
    .diag-item label { color: var(--sub); display: block; font-size: 0.78rem; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .diag-box { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; line-height: 1.5; word-break: break-all; }
    .diag-url-box { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-family: monospace; font-size: 0.8rem; }
    .copy-btn { background: var(--card-subtle); border: 1px solid var(--border); color: var(--sub); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 0.75rem; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .copy-btn:hover { color: #fff; border-color: var(--accent); }
    .badge-status { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 0.8rem; }
    .badge-err { background: var(--danger-bg-soft); color: var(--danger); border: 1px solid var(--danger-border-soft); }

    .github-btn {
      position: absolute;
      top: 18px;
      right: 24px;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--sub);
      display: flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      cursor: pointer;
      transition: color 0.2s ease, border-color 0.2s ease, background-color 0.2s ease, transform 0.15s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s ease;
      z-index: 20;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      -webkit-tap-highlight-color: transparent;
    }
    .github-btn:hover {
      color: #fff;
      background: var(--card-subtle);
      border-color: var(--accent);
      transform: translateY(-2px);
      box-shadow: 0 4px 14px rgba(30, 215, 96, 0.25);
    }
    .github-btn:active {
      transform: translateY(0);
    }

    .volume-group {
      width: 100%;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      position: relative;
      -webkit-user-select: none;
      user-select: none;
    }
    .volume-slider-wrap {
      width: 95px;
      display: flex;
      align-items: center;
      position: relative;
    }
    .volume-slider {
      -webkit-appearance: none;
      -moz-appearance: none;
      appearance: none;
      width: 100%;
      height: 5px;
      border-radius: 3px;
      background: linear-gradient(to right, var(--accent) 0%, var(--accent) var(--vol-percent, 100%), var(--border) var(--vol-percent, 100%), var(--border) 100%);
      outline: none;
      border: none;
      cursor: pointer;
      margin: 0;
      padding: 0;
      transition: background 0.05s linear;
      vertical-align: middle;
    }
    .volume-slider::-webkit-slider-runnable-track {
      height: 5px;
      border-radius: 3px;
      background: transparent;
      border: none;
    }
    .volume-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--accent);
      border: 2px solid #ffffff;
      cursor: pointer;
      margin-top: -4.5px;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
      transition: transform 0.15s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.15s ease;
    }
    .volume-slider:hover::-webkit-slider-thumb,
    .volume-slider:active::-webkit-slider-thumb {
      transform: scale(1.2);
      background: var(--accent-hover);
    }
    .volume-slider::-moz-range-track {
      height: 5px;
      border-radius: 3px;
      background: transparent;
      border: none;
    }
    .volume-slider::-moz-range-progress {
      height: 5px;
      border-radius: 3px;
      background: transparent;
    }
    .volume-slider::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--accent);
      border: 2px solid #ffffff;
      cursor: pointer;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
      transition: transform 0.15s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.15s ease;
    }
    .volume-slider:hover::-moz-range-thumb,
    .volume-slider:active::-moz-range-thumb {
      transform: scale(1.2);
      background: var(--accent-hover);
    }
    .volume-val-text {
      font-size: 0.75rem;
      color: var(--sub);
      width: 38px;
      font-variant-numeric: tabular-nums;
      font-family: monospace;
      text-align: right;
      -webkit-user-select: none;
      user-select: none;
    }
    #stage-actions { position: fixed; top: 16px; right: 16px; z-index: 120; display: flex; align-items: center; gap: 10px; }
    #stage-actions .github-btn { position: static; }
    #stage-actions .settings-float-btn { position: static; }
    .bar-left { min-width: 0; display: flex; align-items: center; justify-content: center; }
    .drawer-menu-btn { position: static; flex: 0 0 auto; background: transparent; border: none; color: var(--text); box-shadow: none; }
    .drawer-menu-btn:hover { color: var(--accent); }
    #info-node { display: none !important; }
    .settings-float-btn { position: absolute; top: 18px; right: 72px; width: 38px; height: 38px; border-radius: 50%; background: var(--card); border: 1px solid var(--border); color: var(--sub); display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 20; box-shadow: 0 2px 8px rgba(0,0,0,0.3); transition: color 0.2s, border-color 0.2s, transform 0.15s; -webkit-tap-highlight-color: transparent; }
    .settings-float-btn:hover { color: #fff; border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 4px 14px rgba(30,215,96,0.25); }
    .volume-popover { position: absolute; right: 0; bottom: calc(100% + 12px); width: 32px; height: 120px; border-radius: 12px; background: var(--card); border: 1px solid var(--border); box-shadow: var(--shadow-dialog); display: none; z-index: 90; }
    .volume-popover.show { display: flex; align-items: center; justify-content: center; }
    .volume-popover .volume-slider-wrap { position: absolute; top: 50%; left: 50%; width: 96px; height: 6px; transform: translate(-50%, -50%) rotate(-90deg); display: flex; align-items: center; }
    .volume-popover .volume-slider { width: 100%; }

    .mobile-nav-tabs { display: none !important; }
    .bar-mobile-source { display: none !important; }

    @media (min-width: 769px) and (max-width: 1100px) {
      .stage { grid-template-columns: minmax(180px, 30vw) minmax(0, 1fr); gap: clamp(14px, 2.5vw, 28px); padding: 64px clamp(16px, 3vw, 32px) clamp(16px, 3vw, 32px); }
      #bar { grid-template-columns: minmax(100px, 0.8fr) minmax(240px, 2fr) minmax(100px, 0.8fr); }
      .volume-val-text { display: none; }
    }

    @media (max-width: 768px) {
      body { flex-direction: column; height: 100vh; height: 100dvh; }
      .stage { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 12px; padding: 56px 14px calc(var(--bar-height, 86px) + 12px + env(safe-area-inset-bottom, 0px)); overflow: hidden; }
      .cover-box { width: auto; height: min(72vw, 300px, 42dvh); aspect-ratio: 1; }
      .lyrics-view { flex: 1 1 auto; min-height: 88px; height: auto; }
      #bar { grid-template-columns: 36px minmax(0, 1fr) 36px; gap: 12px; padding: 10px 12px; padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
      .ctrl-group { min-width: 0; }
      .ctrl-buttons { gap: 12px; flex-wrap: nowrap; }
      .timeline-wrap { min-width: 0; }
      .volume-val-text { display: none; }
      #volume-group > .volume-slider-wrap { display: none; }
      .volume-popover { bottom: calc(100% + 8px); }
      #error-banner { top: 12px; max-width: calc(100vw - 48px); font-size: 0.78rem; padding: 6px 10px; }
      #stage-actions { top: 12px; right: 12px; }
      body.drawer-lock .stage, body.drawer-lock .lrc-box { touch-action: none; }
    }

    @media (max-height: 560px) {
      .stage { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 10px; padding: 56px 12px calc(var(--bar-height, 86px) + 10px + env(safe-area-inset-bottom, 0px)); overflow: hidden; }
      .cover-box { width: auto; height: min(48dvh, 40vw, 240px); aspect-ratio: 1; }
      .lyrics-view { flex: 1 1 auto; min-height: 72px; height: auto; }
    }

    @media (max-width: 360px) {
      #stage-actions { top: 10px; right: 10px; gap: 6px; }
      #stage-actions .github-btn, #stage-actions .settings-float-btn { width: 34px; height: 34px; }
      #error-banner { top: 10px; max-width: calc(100vw - 36px); font-size: 0.76rem; }
      #bar { grid-template-columns: 36px minmax(0, 1fr) 36px; gap: 8px; }
      .ctrl-buttons { gap: 8px; flex-wrap: nowrap; }
    }
  </style>
</head>
<body>

  <svg style="display:none;">
    <symbol id="icon-music" viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></symbol>
    <symbol id="icon-settings" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></symbol>
    <symbol id="icon-chevron-down" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></symbol>
    <symbol id="icon-delete" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></symbol>
    <symbol id="icon-layers" viewBox="0 0 24 24"><path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9.07l-9-7-9 7 1.63 1.27L12 16z"/></symbol>
    <symbol id="icon-add" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></symbol>
    <symbol id="icon-warning" viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></symbol>
    <symbol id="icon-info" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></symbol>
    <symbol id="icon-copy" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></symbol>
    <symbol id="icon-content-paste" viewBox="0 0 24 24"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z"/></symbol>
    <symbol id="icon-close" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></symbol>
    <symbol id="icon-download" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></symbol>
    <symbol id="icon-upload" viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></symbol>
    <symbol id="icon-check" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></symbol>
    <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></symbol>
    <symbol id="icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></symbol>
    <symbol id="icon-pause" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></symbol>
    <symbol id="icon-prev" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></symbol>
    <symbol id="icon-next" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></symbol>
    <symbol id="icon-repeat" viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></symbol>
    <symbol id="icon-repeat-one" viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></symbol>
    <symbol id="icon-shuffle" viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></symbol>
    <symbol id="icon-my-location" viewBox="0 0 24 24"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></symbol>
    <symbol id="icon-share" viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92z"/></symbol>
    <symbol id="icon-github" viewBox="0 0 24 24"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></symbol>
    <symbol id="icon-volume-up" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></symbol>
    <symbol id="icon-volume-down" viewBox="0 0 24 24"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></symbol>
    <symbol id="icon-volume-off" viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></symbol>
    <symbol id="icon-menu" viewBox="0 0 24 24"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></symbol>
    <symbol id="icon-queue-music" viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></symbol>
    <symbol id="icon-drag-indicator" viewBox="0 -960 960 960"><path d="M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160ZM360-400q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400ZM360-640q-33 0-56.5-23.5T280-720q0-33 23.5-56.5T360-800q33 0 56.5 23.5T440-720q0 33-23.5 56.5T360-640Zm240 0q-33 0-56.5-23.5T520-720q0-33 23.5-56.5T600-800q33 0 56.5 23.5T680-720q0 33-23.5 56.5T600-640Z"/></symbol>
  </svg>

  <div id="sidebar-backdrop" onclick="closePlaylistDrawer()" aria-hidden="true"></div>

  <div id="sidebar" role="region" aria-label="播放列表抽屉" aria-hidden="true">
    <div class="side-header">
      <div class="brand-group">
        <svg class="md-icon" style="color:var(--accent);"><use href="#icon-queue-music"></use></svg>
        <span id="title-text">我的音乐库</span>
      </div>
      <button class="btn btn-icon" id="drawer-close-btn" onclick="closePlaylistDrawer()" title="关闭播放列表抽屉" aria-label="关闭播放列表抽屉" aria-expanded="false" aria-controls="sidebar">
        <svg class="md-icon"><use href="#icon-close"></use></svg>
      </button>
    </div>
    <div class="source-bar">
      <label style="font-size:0.8rem; color:var(--sub); flex-shrink:0;">源：</label>
      <select id="source-select" class="select-box" onchange="syncSourceChange(this.value)"></select>
      <button class="btn btn-icon" onclick="handleRefreshClick()" id="refresh-btn" title="刷新歌曲列表" aria-label="刷新歌曲列表">
        <svg class="md-icon md-icon-sm"><use href="#icon-refresh"></use></svg>
      </button>
    </div>
    <div class="playlist-list-wrap">
      <ul id="track-list"></ul>
      <button class="btn" id="playlist-current-locate" onclick="scrollPlaylistToCurrent()" title="定位当前播放曲目" aria-label="定位当前播放曲目">
        <svg class="md-icon md-icon-sm"><use href="#icon-my-location"></use></svg>
        <span>当前播放</span>
      </button>
    </div>
  </div>

  <div id="main">
    <div class="stage">
      <div class="cover-box">
        <img id="cover" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100' fill='%231f1f1f'><path fill='%23404040' d='M50 30c-11.05 0-20 8.95-20 20s8.95 20 20 20 20-8.95 20-20-8.95-20-20-20zm0 28c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z'/></svg>">
      </div>

      <div class="lyrics-view">
        <div class="title-row">
          <div class="song-title" id="stitle">未在播放</div>
          <button class="btn-share" onclick="togglePlayMode()" id="mode-btn" title="模式: 列表循环">
            <svg class="md-icon md-icon-sm"><use id="mode-icon" href="#icon-repeat"/></svg>
          </button>
          <button class="btn-share" onclick="copyCurrentSongShareUrl()" title="复制这首歌的 8 位极短分享链接">
            <svg class="md-icon md-icon-sm"><use href="#icon-share"/></svg>
          </button>
        </div>
        <div class="song-artist" id="sartist">-</div>
        
        <div class="lrc-viewport-wrap">
          <div class="lrc-box" id="lrc-viewport">
            <div class="lrc-content" id="lrc-content">
              <div class="lrc-line" style="justify-content:center;">暂无歌词</div>
            </div>
          </div>
          <button id="resume-scroll-btn" onclick="resumeAutoScroll()">
            <svg class="md-icon md-icon-sm"><use href="#icon-my-location"/></svg>
            <span>回到当前进度</span>
          </button>
        </div>
      </div>
    </div>

    <div id="stage-actions">
      <a href="https://github.com/tanmoumou252/webdav_music_player" target="_blank" rel="noopener noreferrer" class="github-btn" title="访问 GitHub 开源仓库" aria-label="GitHub 开源仓库">
        <svg class="md-icon"><use href="#icon-github"/></svg>
      </a>
      <button class="btn btn-icon settings-float-btn" id="admin-settings-btn" onclick="openAdmin()" title="打开管理设置" aria-label="打开管理设置">
        <svg class="md-icon"><use href="#icon-settings"/></svg>
      </button>
    </div>

    <div id="bar">
      <div class="bar-mobile-source" id="bar-mobile-source" style="display:none !important;" aria-hidden="true">
        <select id="bar-source-select" class="select-box" onchange="syncSourceChange(this.value)"></select>
      </div>

      <div class="bar-left">
        <button class="btn btn-icon drawer-menu-btn" id="playlist-toggle-btn" onclick="togglePlaylistDrawer()" title="打开播放列表" aria-label="打开播放列表" aria-expanded="false" aria-controls="sidebar">
          <svg class="md-icon"><use href="#icon-menu"></use></svg>
        </button>
        <div id="info-node">队列就绪</div>
      </div>
      
      <div class="ctrl-group">
        <div class="ctrl-buttons">
          <button class="ctrl-icon-btn" onclick="playPrevSong()" title="上一曲">
            <svg class="md-icon md-icon-lg"><use href="#icon-prev"/></svg>
          </button>
          <button class="ctrl-icon-btn play-btn-circle" onclick="togglePlay()" id="play-btn" title="播放/暂停">
            <svg class="md-icon md-icon-lg"><use id="play-icon" href="#icon-play"/></svg>
          </button>
          <button class="ctrl-icon-btn" onclick="playNextSong()" title="下一曲">
            <svg class="md-icon md-icon-lg"><use href="#icon-next"/></svg>
          </button>
        </div>

        <div class="timeline-wrap">
          <span id="time-current">00:00</span>
          <div class="progress-bar" id="progress-bar" onclick="seekAudio(event)">
            <div class="progress-buffered" id="progress-buffered"></div>
            <div class="progress-fill" id="progress-fill"></div>
          </div>
          <span id="time-duration">00:00</span>
        </div>
      </div>

      <div class="volume-group" id="volume-group" title="滚轮可快捷微调音量">
        <button class="ctrl-icon-btn" onclick="handleVolumeButtonClick(event)" id="volume-btn" title="音量控制" aria-label="音量控制" aria-expanded="false" aria-controls="volume-popover">
          <svg class="md-icon"><use id="volume-icon" href="#icon-volume-up"></use></svg>
        </button>
        <div class="volume-slider-wrap">
          <input type="range" class="volume-slider" id="volume-slider" min="0" max="1" step="0.01" value="1" oninput="handleVolumeInput(this.value)" onchange="handleVolumeChange(this.value)" title="调节音量" aria-label="音量调节" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
        </div>
        <span class="volume-val-text" id="volume-val-text">100%</span>
        <div class="volume-popover" id="volume-popover" role="dialog" aria-label="音量调节" aria-hidden="true">
          <div class="volume-slider-wrap">
            <input type="range" class="volume-slider" id="volume-slider-mobile" min="0" max="1" step="0.01" value="1" oninput="handleVolumeInput(this.value)" onchange="handleVolumeChange(this.value)" title="调节音量" aria-label="音量调节" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="toast">提示信息</div>
  <div id="error-banner">
    <div class="banner-left">
      <svg class="md-icon md-icon-sm" style="color:var(--danger);"><use href="#icon-warning"/></svg>
      <span id="error-text">检测到异常</span>
    </div>
    <div class="banner-actions">
      <button class="btn-detail" onclick="openDiagnosticModal()">
        <svg class="md-icon md-icon-sm"><use href="#icon-info"/></svg>
        <span>诊断详情</span>
      </button>
      <button class="banner-close" onclick="clearError()" aria-label="关闭提示">
        <svg class="md-icon md-icon-sm"><use href="#icon-close"/></svg>
      </button>
    </div>
  </div>
  <audio id="audio" preload="auto"></audio>

  <div class="modal" id="init-modal">
    <div class="modal-box">
      <h3>初始化管理员密码</h3>
      <p style="font-size:0.8rem; color:var(--sub); margin: 6px 0 14px 0;">设置后自动保存登录凭证 (Cookie 30天免密)。</p>
      <div class="input-row"><label>站点标题</label><input type="text" id="init-title" value="我的多源音乐库"></div>
      <div class="input-row"><label>密码</label><input type="password" id="init-pass" placeholder="设置管理员密码"></div>
      <button class="btn btn-green" style="width: 100%; margin-top: 10px; justify-content:center;" onclick="submitInit()">
        <svg class="md-icon md-icon-sm"><use href="#icon-check"/></svg>
        <span>确定</span>
      </button>
    </div>
  </div>

  <div class="modal" id="admin-modal">
    <div class="modal-box">
      <h3>WebDAV 管理设置</h3>
      
      <div id="admin-login-sec" style="margin: 16px 0;">
        <div class="input-row">
          <label>请输入管理员密码</label>
          <input type="password" id="login-admin-pass">
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
          <button class="btn" onclick="closeAdmin()">
            <svg class="md-icon md-icon-sm"><use href="#icon-close"/></svg>
            <span>取消</span>
          </button>
          <button class="btn btn-green" onclick="loginAdmin()">
            <svg class="md-icon md-icon-sm"><use href="#icon-check"/></svg>
            <span>登录验证</span>
          </button>
        </div>
      </div>

      <div id="admin-content-sec" style="display: none;">
        <hr style="border:none; border-top:1px solid var(--border); margin:14px 0;">
        <div style="display:flex; flex-wrap:wrap; gap:6px; margin: 0 0 10px 0;">
          <button class="btn" onclick="exportSourcesJson()" title="导出配置为 JSON">
            <svg class="md-icon md-icon-sm"><use href="#icon-download"/></svg>
            <span>导出</span>
          </button>
          <button class="btn" onclick="copyExportCode()" title="复制单行口令文本">
            <svg class="md-icon md-icon-sm"><use href="#icon-copy"/></svg>
          </button>
          <button class="btn" onclick="triggerImportSources()" title="从 JSON 文件导入配置">
            <svg class="md-icon md-icon-sm"><use href="#icon-upload"/></svg>
            <span>导入</span>
          </button>
          <button class="btn" onclick="pasteImportCode()" title="粘贴单行口令导入配置">
            <svg class="md-icon md-icon-sm"><use href="#icon-content-paste"/></svg>
          </button>
          <input type="file" id="import-file-input" accept=".json" style="display:none;" onchange="handleImportFile(event)">
          <button class="btn" onclick="addNewSourceUI()" title="添加源">
            <svg class="md-icon md-icon-sm"><use href="#icon-add"/></svg>
          </button>
        </div>
        <h4 style="font-size:0.95rem; margin: 0 0 10px 0;">WebDAV 源列表</h4>

        <div id="sources-container"></div>
        
        <div class="input-row">
          <label>站点标题 (留空表示不改)</label>
          <input type="text" id="admin-site-title">
        </div>

        <div class="input-row" style="margin-top: 14px;">
          <label>修改密码 (留空表示不改)</label>
          <input type="password" id="new-admin-pass">
        </div>

        <div style="display:flex; justify-content:space-between; margin-top:16px;">
          <button class="btn" style="color:var(--danger); border-color:var(--danger);" onclick="logoutAdmin()">退出登录</button>
          <div style="display:flex; gap:8px;">
            <button class="btn" onclick="closeAdmin()">
              <svg class="md-icon md-icon-sm"><use href="#icon-close"/></svg>
              <span>关闭</span>
            </button>
            <button class="btn btn-green" onclick="saveAdminData()">
              <svg class="md-icon md-icon-sm"><use href="#icon-check"/></svg>
              <span>保存更改</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="modal" id="diag-modal">
    <div class="modal-box">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h3 style="display:flex; align-items:center; gap:8px;">
          <svg class="md-icon" style="color:var(--danger);"><use href="#icon-warning"/></svg>
          <span>WebDAV 故障诊断分析报告</span>
        </h3>
        <button class="btn" onclick="closeDiagnosticModal()" style="padding:4px;"><svg class="md-icon"><use href="#icon-close"/></svg></button>
      </div>

      <div class="diag-item">
        <label>故障源与状态</label>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="badge-status badge-err" id="diag-badge">HTTP 0</span>
          <span id="diag-sourcename" style="font-weight:600;">-</span>
        </div>
      </div>

      <div class="diag-item">
        <label>目标请求地址 (Target URL)</label>
        <div class="diag-box diag-url-box">
          <span id="diag-url">-</span>
          <button class="copy-btn" onclick="copyDiagnosticUrl()">
            <svg class="md-icon md-icon-sm"><use href="#icon-copy"/></svg>
            <span id="copy-btn-text">复制</span>
          </button>
        </div>
      </div>

      <div class="diag-item">
        <label>原因分析 (Analysis)</label>
        <div class="diag-box" id="diag-cause" style="color:var(--danger-fg);">-</div>
      </div>

      <div class="diag-item">
        <label>建议解决方案 (Recommendation)</label>
        <div class="diag-box" id="diag-solution" style="color:var(--accent);">-</div>
      </div>

      <div class="diag-item">
        <label>服务端原始报文预览 (Raw Response Preview)</label>
        <div class="diag-box" id="diag-raw" style="font-family:monospace; font-size:0.75rem; color:var(--sub); max-height:100px; overflow-y:auto;">-</div>
      </div>

      <div style="display:flex; justify-content:flex-end; margin-top:20px;">
        <button class="btn btn-green" onclick="closeDiagnosticModal()">
          <svg class="md-icon md-icon-sm"><use href="#icon-check"/></svg>
          <span>确认</span>
        </button>
      </div>
    </div>
  </div>

  <div class="modal" id="pass-modal">
    <div class="modal-box">
      <h3 id="pass-modal-title">口令</h3>
      <div class="input-row"><label>口令</label><input type="password" id="pass-input" placeholder="输入口令"></div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
        <button class="btn" onclick="cancelPass()">
          <svg class="md-icon md-icon-sm"><use href="#icon-close"/></svg>
          <span>取消</span>
        </button>
        <button class="btn btn-green" onclick="confirmPass()">
          <svg class="md-icon md-icon-sm"><use href="#icon-check"/></svg>
          <span>确定</span>
        </button>
      </div>
    </div>
  </div>

  <div class="modal" id="app-dialog">
    <div class="modal-box">
      <h3 id="app-dialog-title">提示</h3>
      <div class="app-dialog-msg" id="app-dialog-msg">消息内容</div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
        <button class="btn btn-green" id="app-dialog-ok" onclick="closeAppDialog()">
          <svg class="md-icon md-icon-sm"><use href="#icon-check"/></svg>
          <span>知道了</span>
        </button>
      </div>
    </div>
  </div>

  <div class="modal" id="paste-modal">
    <div class="modal-box">
      <h3 id="paste-modal-title">口令</h3>
      <div class="input-row">
        <label id="paste-modal-label">口令文本</label>
        <textarea id="paste-text" rows="4" spellcheck="false" style="width:100%; box-sizing:border-box; background:var(--card); border:1px solid var(--border); border-radius:8px; color:var(--text,#e6e6e6); padding:8px 10px; font-family:ui-monospace,Consolas,monospace; font-size:0.8rem; outline:none;"></textarea>
      </div>
      <div class="input-row" id="paste-pass-row" style="display:none;">
        <label>解密口令</label>
        <input type="password" id="paste-pass-input" placeholder="输入导出时设置的加密口令">
      </div>
      <div id="paste-error" style="display:none; color:var(--danger-fg); font-size:0.78rem; margin-top:8px;"></div>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:16px;">
        <button class="btn" onclick="closePasteModal()">
          <svg class="md-icon md-icon-sm"><use href="#icon-close"/></svg>
          <span>关闭</span>
        </button>
        <button class="btn btn-green" id="paste-copy-btn" onclick="doCopyPaste()">
          <svg class="md-icon md-icon-sm"><use href="#icon-copy"/></svg>
          <span>复制</span>
        </button>
        <button class="btn btn-green" id="paste-parse-btn" onclick="doParsePaste()" style="display:none;">
          <svg class="md-icon md-icon-sm"><use href="#icon-check"/></svg>
          <span>解析导入</span>
        </button>
      </div>
    </div>
  </div>

  <script>
    const audio = document.getElementById('audio');
    const errBanner = document.getElementById('error-banner');
    const errText = document.getElementById('error-text');
    const lrcViewport = document.getElementById('lrc-viewport');
    const resumeScrollBtn = document.getElementById('resume-scroll-btn');

    let currentPlaylist = [];
    let currentIndex = -1;
    let playToken = 0;
    let playMode = 'repeat';
    let lrcData = [];
    let isAuthed = false;
    let siteTitle = '';
    let latestDiagnostic = null;
    let lastDiagKey = '';
    let lastDiagTs = 0;
    const DIAG_DEDUP_WINDOW_MS = 12000;

    let isUserScrollingLyrics = false;
    let userScrollTimer = null;
    let jmtLoader = null;
    let tagCache = new Map();
    let tagAbort = null;
    let pendingTag = null;
    let progressMemory = new Map();
    let pendingSeek = null;
    let pendingShareSeek = null;
    let stallHeartbeat = null;
    let lastProgressAt = 0;
    let lastProgressTime = 0;
    let stallRetries = 0;
    let userPaused = false;
    let waitingForGesture = false;
    let externallyPaused = false;
    let currentSongRef = null;
    let currentNodeIndex = 0;
    let currentIsAuto = false;
    let lastPersistAt = 0;
    const STALL_TIMEOUT_MS = 15000;
    const STALL_HEARTBEAT_MS = 5000;
    const STALL_MAX_RETRIES = 2;
    const TAG_CACHE_MAX = 24;
    const PROGRESS_STORE_KEY = 'webdav_player_progress_v1';
    const PROGRESS_TTL_MS = 21600000;
    const NODE_HEALTH_STORE_KEY = 'webdav_player_node_health_v1';
    const NODE_HEALTH_TTL_MS = 86400000;
    const NODE_HEALTH_MAX_ENTRIES = 64;

    function readNodeHealth() {
      try {
        const raw = localStorage.getItem(NODE_HEALTH_STORE_KEY);
        if (!raw) return {};
        const rec = JSON.parse(raw);
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return {};
        const now = Date.now();
        const out = {};
        let count = 0;
        for (const k of Object.keys(rec)) {
          const until = rec[k];
          if (typeof until === 'number' && isFinite(until) && until > now && count < NODE_HEALTH_MAX_ENTRIES) {
            out[k] = until;
            count = count + 1;
          }
        }
        return out;
      } catch (e) {
        return {};
      }
    }

    function writeNodeHealth(map) {
      try {
        localStorage.setItem(NODE_HEALTH_STORE_KEY, JSON.stringify(map));
      } catch (e) {}
    }

    function markNodeBad(sourceId) {
      if (!sourceId) return;
      const map = readNodeHealth();
      map[String(sourceId)] = Date.now() + NODE_HEALTH_TTL_MS;
      writeNodeHealth(map);
    }

    function clearNodeBad(sourceId) {
      if (!sourceId) return;
      const map = readNodeHealth();
      if (Object.prototype.hasOwnProperty.call(map, String(sourceId))) {
        delete map[String(sourceId)];
        writeNodeHealth(map);
      }
    }

    function isNodeAvoidable(sourceId) {
      if (!sourceId) return false;
      const map = readNodeHealth();
      const until = map[String(sourceId)];
      return typeof until === 'number' && until > Date.now();
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function getJsMediaTags() {
      if (window.jsmediatags) return window.jsmediatags;
      if (!jmtLoader) {
        jmtLoader = (async () => {
          try {
            const res = await fetch('/js/jsmediatags.min.js');
            if (res.ok) {
              const txt = await res.text();
              const runner = new Function(txt);
              runner.call(window);
            }
          } catch (e) {}
          return window.jsmediatags || null;
        })();
      }
      return jmtLoader;
    }

    let drawerReturnFocus = null;

    function setPlaylistDrawer(open) {
      const sidebar = document.getElementById('sidebar');
      const backdrop = document.getElementById('sidebar-backdrop');
      const menuButton = document.getElementById('playlist-toggle-btn');
      const closeButton = document.getElementById('drawer-close-btn');
      if (!sidebar || !backdrop) return;
      const wasOpen = sidebar.classList.contains('drawer-open');
      sidebar.classList.toggle('drawer-open', open);
      backdrop.classList.toggle('drawer-open', open);
      sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
      backdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
      document.body.classList.toggle('drawer-lock', open);
      if (menuButton) menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (closeButton) closeButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      window.requestAnimationFrame(syncPlaylistCurrentLocate);
      if (open && !wasOpen) {
        drawerReturnFocus = document.activeElement;
        if (closeButton) closeButton.focus();
      } else if (!open && wasOpen) {
        const target = (drawerReturnFocus && drawerReturnFocus !== document.body && document.contains(drawerReturnFocus)) ? drawerReturnFocus : menuButton;
        if (target) target.focus();
        drawerReturnFocus = null;
      }
    }

    function togglePlaylistDrawer() {
      const sidebar = document.getElementById('sidebar');
      setPlaylistDrawer(!sidebar || !sidebar.classList.contains('drawer-open'));
    }

    function closePlaylistDrawer() {
      setPlaylistDrawer(false);
    }

    function switchMobileView(view) {
      if (view === 'list') {
        setPlaylistDrawer(true);
      } else {
        setPlaylistDrawer(false);
      }
    }

    const OVERLAY_MODAL_IDS = ['paste-modal', 'app-dialog', 'pass-modal', 'admin-modal', 'diag-modal', 'init-modal'];

    function handleGlobalKeydown(event) {
      if (event.key === ' ') {
        if (event.repeat) return;
        const ae = document.activeElement;
        const tag = ae && ae.tagName ? ae.tagName : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || (ae && ae.isContentEditable)) return;
        for (let i = 0; i < OVERLAY_MODAL_IDS.length; i++) {
          const m = document.getElementById(OVERLAY_MODAL_IDS[i]);
          if (m && m.classList.contains('show')) return;
        }
        const vp = document.getElementById('volume-popover');
        if (vp && vp.classList.contains('show')) return;
        event.preventDefault();
        togglePlay();
        return;
      }
      if (event.key !== 'Escape') return;
      const modalOrder = OVERLAY_MODAL_IDS;
      for (let i = 0; i < modalOrder.length; i++) {
        const modal = document.getElementById(modalOrder[i]);
        if (modal && modal.classList.contains('show')) {
          if (modalOrder[i] === 'paste-modal') {
            closePasteModal();
          } else if (modalOrder[i] === 'app-dialog') {
            dismissAppDialog();
          } else if (modalOrder[i] === 'pass-modal') {
            closePassModal();
          } else if (modalOrder[i] === 'admin-modal') {
            closeAdmin();
          } else if (modalOrder[i] === 'diag-modal') {
            closeDiagnosticModal();
          } else {
            modal.classList.remove('show');
          }
          return;
        }
      }
      const popover = document.getElementById('volume-popover');
      if (popover && popover.classList.contains('show')) {
        popover.classList.remove('show');
        popover.setAttribute('aria-hidden', 'true');
        const volumeButton = document.getElementById('volume-btn');
        if (volumeButton) {
          volumeButton.setAttribute('aria-expanded', 'false');
          volumeButton.focus();
        }
        return;
      }
      const sidebar = document.getElementById('sidebar');
      if (sidebar && sidebar.classList.contains('drawer-open')) {
        closePlaylistDrawer();
      }
    }
    document.addEventListener('keydown', handleGlobalKeydown);

    function formatTime(sec) {
      if (isNaN(sec)) return "00:00";
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
    }

    function parseShareTime(raw) {
      if (typeof raw !== "string") return null;
      const m = raw.match(/^((?:\\d{1,2})h)?((?:\\d{1,3})m)?((?:\\d{1,2})s)?$/);
      if (!m || (!m[1] && !m[2] && !m[3])) return null;
      const sec = (m[1] ? parseInt(m[1], 10) * 3600 : 0) + (m[2] ? parseInt(m[2], 10) * 60 : 0) + (m[3] ? parseInt(m[3], 10) : 0);
      if (!isFinite(sec) || sec < 3 || sec >= 86400) return null;
      return sec;
    }

    function formatShareTime(sec) {
      if (!isFinite(sec) || sec < 3) return "";
      let rest = Math.floor(sec);
      const h = Math.floor(rest / 3600); rest -= h * 3600;
      const m = Math.floor(rest / 60); rest -= m * 60;
      const s = rest;
      return (h ? h + "h" : "") + (m ? m + "m" : "") + (s ? s + "s" : "");
    }

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 2400);
    }

    lrcViewport.addEventListener('wheel', handleUserScroll, { passive: true });
    lrcViewport.addEventListener('touchstart', handleUserScroll, { passive: true });

    function handleUserScroll() {
      if (!document.querySelector('.lrc-line.active')) {
        resumeScrollBtn.style.display = 'none';
        clearTimeout(userScrollTimer);
        return;
      }
      isUserScrollingLyrics = true;
      resumeScrollBtn.style.display = 'flex';
      clearTimeout(userScrollTimer);
      userScrollTimer = setTimeout(() => { resumeAutoScroll(); }, 4500);
    }

    function resumeAutoScroll() {
      isUserScrollingLyrics = false;
      resumeScrollBtn.style.display = 'none';
      clearTimeout(userScrollTimer);
      scrollToActiveLyric(true);
    }

    function scrollToActiveLyric(smooth = true) {
      const box = document.getElementById('lrc-viewport');
      const activeLine = document.querySelector('.lrc-line.active');
      if (!box || !activeLine) return;
      const target = activeLine.offsetTop - (box.clientHeight - activeLine.offsetHeight) / 2;
      const maxScroll = Math.max(0, box.scrollHeight - box.clientHeight);
      box.scrollTo({ top: Math.max(0, Math.min(maxScroll, target)), behavior: smooth ? 'smooth' : 'auto' });
    }

    function reportDiagnostic(diag, opts) {
      if (!diag) return;
      latestDiagnostic = diag;
      const now = Date.now();
      const key = (diag.sourceName || '') + '|' + (diag.status || '');
      const isDup = (key === lastDiagKey) && (now - lastDiagTs < DIAG_DEDUP_WINDOW_MS);
      if (isDup) {
        console.warn('[WebDAV 诊断抑制 12s 窗口内重复]', diag.title || '', key);
        return;
      }
      lastDiagKey = key;
      lastDiagTs = now;

      console.log('[WebDAV 异常报告] 源: ' + (diag.sourceName || '') + ' | HTTP ' + (diag.status || '') + ' ' + (diag.statusText || '') + ' | ' + (diag.title || ''));

      if ((opts && opts.quiet) || !isAuthed) return;
      errText.textContent = diag.title;
      errBanner.style.display = 'flex';
    }

    function logDebugToConsole(debug) {
      if (!debug) return;
      console.log('[WebDAV 检索调试] 源: ' + (debug.sourceName || debug.sourceId) + ' | 状态: ' + (debug.status || '') + ' ' + (debug.statusText || '') + ' | 条目: ' + (debug.allHrefsCount || 0));
    }

    function clearError() {
      errBanner.style.display = 'none';
      errText.textContent = '';
    }

    function openDiagnosticModal() {
      if (!latestDiagnostic) return;
      document.getElementById('diag-badge').textContent = 'HTTP ' + latestDiagnostic.status;
      document.getElementById('diag-sourcename').textContent = latestDiagnostic.sourceName || '未命名源';
      document.getElementById('diag-url').textContent = latestDiagnostic.targetUrl || '-';
      document.getElementById('diag-cause').textContent = latestDiagnostic.cause || '-';
      document.getElementById('diag-solution').textContent = latestDiagnostic.solution || '-';
      document.getElementById('diag-raw').textContent = latestDiagnostic.bodyPreview || '(无原始报文或为空)';
      document.getElementById('diag-modal').classList.add('show');
    }

    function closeDiagnosticModal() { document.getElementById('diag-modal').classList.remove('show'); clearError(); }

    function fallbackCopyText(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (!document.execCommand('copy')) showToast('复制失败，请手动选取复制');
      } catch (e) {
        showToast('复制失败，请手动选取复制');
      }
      document.body.removeChild(ta);
    }

    function copyDiagnosticUrl() {
      if (!latestDiagnostic || !latestDiagnostic.targetUrl) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(latestDiagnostic.targetUrl).then(() => {
          const btn = document.getElementById('copy-btn-text');
          btn.textContent = '已复制!';
          setTimeout(() => btn.textContent = '复制', 2000);
        }).catch(() => fallbackCopyText(latestDiagnostic.targetUrl));
      } else {
        fallbackCopyText(latestDiagnostic.targetUrl);
      }
    }

    function copyCurrentSongShareUrl() {
      if (currentIndex < 0 || currentIndex >= currentPlaylist.length) {
        return showToast('请先选择一首歌播放');
      }
      const song = currentPlaylist[currentIndex];
      const stamp = formatShareTime(audio.currentTime);
      const shareUrl = window.location.origin + window.location.pathname + '?play=' + song.id + (stamp ? '&t=' + stamp : "");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareUrl).then(() => {
          showToast(stamp ? '已复制链接（从 ' + formatTime(audio.currentTime) + ' 开始播放）' : '已复制 8 位精简直达分享链接！');
        }).catch(() => fallbackCopyText(shareUrl));
      } else {
        fallbackCopyText(shareUrl);
      }
    }

    function handleRefreshClick() {
      if (isAuthed) {
        showToast('管理员模式：正在实时穿透同步 WebDAV 网盘...');
      } else {
        showToast('访客模式：正在从 KV 缓存重新载入最新数据...');
      }
      loadPlaylist(true);
    }

    let lastVolume = 1.0;

    function initVolume() {
      let vol = 1.0;
      try {
        const saved = localStorage.getItem('webdav_player_volume');
        if (saved !== null) {
          const parsed = parseFloat(saved);
          if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
            vol = parsed;
          }
        }
      } catch (e) {}

      lastVolume = vol > 0 ? vol : 0.8;
      applyVolume(vol, false);

      const volGroup = document.getElementById('volume-group');
      if (volGroup) {
        volGroup.addEventListener('wheel', (e) => {
          if (window.matchMedia('(max-width: 768px)').matches || window.matchMedia('(pointer: coarse)').matches) return;
          e.preventDefault();
          const step = 0.05;
          const current = (typeof audio.volume === 'number') ? audio.volume : 1;
          const delta = e.deltaY < 0 ? step : -step;
          const target = Math.round((current + delta) * 100) / 100;
          applyVolume(target, true);
        }, { passive: false });
      }
    }

    function applyVolume(val, save = true) {
      let v = parseFloat(val);
      if (isNaN(v)) v = 1;
      v = Math.max(0, Math.min(1, v));

      try {
        audio.volume = v;
        audio.muted = (v === 0);
      } catch (e) {}

      if (v > 0) {
        lastVolume = v;
      }

      updateVolumeUI(v);

      if (save) {
        try {
          localStorage.setItem('webdav_player_volume', v.toString());
        } catch (e) {}
      }
    }

    function updateVolumeUI(v) {
      const sliders = [document.getElementById('volume-slider'), document.getElementById('volume-slider-mobile')];
      const icon = document.getElementById('volume-icon');
      const text = document.getElementById('volume-val-text');
      const btn = document.getElementById('volume-btn');
      const percent = Math.round(v * 100);

      sliders.forEach((slider) => {
        if (!slider) return;
        slider.value = v;
        slider.style.setProperty('--vol-percent', percent + '%');
        slider.setAttribute('aria-valuenow', percent);
      });

      if (text) {
        text.textContent = percent + '%';
      }

      if (icon) {
        if (v === 0) {
          icon.setAttribute('href', '#icon-volume-off');
          if (btn) btn.title = '取消静音';
        } else if (v < 0.5) {
          icon.setAttribute('href', '#icon-volume-down');
          if (btn) btn.title = '静音 (当前 ' + percent + '%)';
        } else {
          icon.setAttribute('href', '#icon-volume-up');
          if (btn) btn.title = '静音 (当前 ' + percent + '%)';
        }
      }
    }

    function handleVolumeButtonClick(event) {
      if (window.matchMedia('(max-width: 768px)').matches) {
        toggleVolumePopover(event);
      } else {
        toggleMute();
      }
    }

    function toggleVolumePopover(event) {
      if (event) event.stopPropagation();
      const popover = document.getElementById('volume-popover');
      const button = document.getElementById('volume-btn');
      if (!popover) return;
      const open = !popover.classList.contains('show');
      popover.classList.toggle('show', open);
      popover.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        const sliderMobile = document.getElementById('volume-slider-mobile');
        if (sliderMobile) sliderMobile.focus();
      }
    }

    document.addEventListener('click', (event) => {
      const group = document.getElementById('volume-group');
      const popover = document.getElementById('volume-popover');
      const button = document.getElementById('volume-btn');
      if (!group || !popover || group.contains(event.target)) return;
      popover.classList.remove('show');
      popover.setAttribute('aria-hidden', 'true');
      if (button) button.setAttribute('aria-expanded', 'false');
    });

    function toggleMute() {
      const current = (typeof audio.volume === 'number') ? audio.volume : 1;
      if (current > 0 && !audio.muted) {
        lastVolume = current;
        applyVolume(0, true);
      } else {
        const target = (lastVolume > 0) ? lastVolume : 0.8;
        applyVolume(target, true);
      }
    }

    function handleVolumeInput(val) {
      applyVolume(val, false);
    }

    function handleVolumeChange(val) {
      applyVolume(val, true);
    }

    function syncSourceChange(val) {
      const s1 = document.getElementById('source-select');
      const s2 = document.getElementById('bar-source-select');
      if (s1 && s1.value !== val) s1.value = val;
      if (s2 && s2.value !== val) s2.value = val;
      loadPlaylist();
    }

    async function init() {
      initVolume();
      const playlistScroll = document.getElementById('track-list');
      if (playlistScroll) playlistScroll.addEventListener('scroll', syncPlaylistCurrentLocate, { passive: true });
      getJsMediaTags().catch(() => {});
      const res = await fetch('/api/status');
      const data = await res.json();
      const statusParams = new URLSearchParams(window.location.search);
      const isSharePage = !!(statusParams.get('play') || statusParams.get('v') || statusParams.get('id'));
      if (data.title) { siteTitle = data.title; document.getElementById('title-text').textContent = data.title; if (!isSharePage) document.title = data.title; }
      isAuthed = data.isAdmin;

      const refreshBtn = document.getElementById('refresh-btn');
      if (isAuthed) {
        refreshBtn.title = '管理员特权：穿透并从远端 WebDAV 重新扫描更新';
      } else {
        refreshBtn.title = '从 KV 缓存重新载入歌曲列表';
      }

      if (!data.isInitialized) {
        document.getElementById('init-modal').classList.add('show');
        return;
      }

      updateSourceDropdown(data.sources);

      const urlParams = new URLSearchParams(window.location.search);
      const targetPlayId = urlParams.get('play') || urlParams.get('v') || urlParams.get('id');
      const legacySongName = urlParams.get('song');
      if (targetPlayId || legacySongName) pendingShareSeek = parseShareTime(urlParams.get('t'));

      await loadPlaylist(false, targetPlayId, legacySongName);
    }

    function updateSourceDropdown(sources) {
      const selects = [document.getElementById('source-select'), document.getElementById('bar-source-select')];
      selects.forEach(select => {
        if (!select) return;
        const current = select.value || 'all';
        select.innerHTML = '<option value="all">全部合并 (自动去重)</option>';
        sources.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name;
          select.appendChild(opt);
        });
        select.value = current;
      });
    }

    async function loadPlaylist(forceRefresh = false, targetPlayId = null, legacySongName = null) {
      clearError();
      const sourceId = (document.getElementById('bar-source-select') && document.getElementById('bar-source-select').value) || (document.getElementById('source-select') && document.getElementById('source-select').value) || 'all';
      const listEl = document.getElementById('track-list');
      listEl.innerHTML = '<li style="color:#666;">加载中...</li>';

      let apiUrl = '/api/list?sourceId=' + encodeURIComponent(sourceId);
      if (forceRefresh) apiUrl += '&refresh=true';

      const res = await fetch(apiUrl);
      const data = await res.json();
      listEl.innerHTML = '';
      currentPlaylist = [];

      if (data.notice) {
        showToast(data.notice);
      }

      if (data.debugs && Array.isArray(data.debugs)) {
        data.debugs.forEach(d => logDebugToConsole(d));
      }

      if (data.diagnostics && Array.isArray(data.diagnostics)) {
        data.diagnostics.forEach(d => reportDiagnostic(d));
      }

      if (!data.items || data.items.length === 0) {
        listEl.innerHTML = '<li style="color:#666;">暂无歌曲单曲，请在设置中检查源配置</li>';
        syncPlaylistCurrentLocate();
        return;
      }

      let matchedIndex = -1;

      data.items.forEach((item, idx) => {
        currentPlaylist.push(item);

        if (targetPlayId && item.id === targetPlayId) {
          matchedIndex = idx;
        } else if (!targetPlayId && legacySongName && item.name === legacySongName) {
          matchedIndex = idx;
        }

        const li = document.createElement('li');
        const mirrorCount = item.availableNodes ? item.availableNodes.length : 1;
        const mirrorBadge = mirrorCount > 1 ? '<span class="mirror-badge"><svg class="md-icon md-icon-sm"><use href="#icon-layers"/></svg>' + mirrorCount + ' 线路</span>' : '';
        
        li.innerHTML = '<div class="item-left"><svg class="md-icon md-icon-sm" style="color:var(--sub);"><use href="#icon-music"/></svg><span class="item-name">' + escapeHtml(item.name) + '</span></div>' + mirrorBadge;
        li.addEventListener('click', () => {
          playTrackByIndex(idx);
          closePlaylistDrawer();
        });
        listEl.appendChild(li);
      });

      syncPlaylistCurrentLocate();

      if (matchedIndex !== -1) {
        playTrackByIndex(matchedIndex, true, true);
      }
    }

    function syncPlaylistCurrentLocate() {
      const list = document.getElementById('track-list');
      const sidebar = document.getElementById('sidebar');
      const locateButton = document.getElementById('playlist-current-locate');
      const active = document.querySelector('#track-list li.active');
      if (!list || !sidebar || !locateButton || !active || !sidebar.classList.contains('drawer-open')) {
        if (locateButton) locateButton.classList.remove('show');
        return;
      }
      const listRect = list.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const fullyVisible = activeRect.top >= listRect.top && activeRect.bottom <= listRect.bottom;
      locateButton.classList.toggle('show', !fullyVisible);
    }

    function scrollPlaylistToCurrent() {
      const active = document.querySelector('#track-list li.active');
      if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(syncPlaylistCurrentLocate, 350);
    }

    function updateSidebarActive(idx) {
      const lis = document.querySelectorAll('#track-list li');
      lis.forEach((el, i) => el.classList.toggle('active', i === idx));
      syncPlaylistCurrentLocate();
    }

    function playTrackByIndex(idx, isAuto = false, resume = false) {
      if (idx < 0 || idx >= currentPlaylist.length) return;
      clearError();
      currentIndex = idx;
      updateSidebarActive(idx);
      const song = currentPlaylist[idx];
      startPlayback(song, 0, true, isAuto, resume);
    }

    function startPlayback(song, nodeIndex = 0, syncUrl = true, isAuto = false, resume = false) {
      playToken = playToken + 1;
      resetCoverAmbient();
      if (tagAbort) tagAbort.abort();
      tagAbort = new AbortController();
      pendingTag = null;
      startStallHeartbeat();
      stallRetries = 0;
      userPaused = false;
      waitingForGesture = false;
      externallyPaused = false;
      currentSongRef = song;
      document.getElementById('stitle').textContent = song.name.replace(/\.[^/.]+$/, "");
      document.getElementById('sartist').textContent = "正在解析内嵌标签...";
      const fallbackTitle = song.name.replace(/\.[^/.]+$/, "");
      document.title = fallbackTitle + " | " + (siteTitle || "Cloud Music Hub");
      if (navigator.mediaSession && window.MediaMetadata) {
        try {
          navigator.mediaSession.metadata = new window.MediaMetadata({ title: fallbackTitle, artist: '', artwork: [] });
        } catch (e) {}
      }
      document.getElementById('cover').src = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100' fill='%231f1f1f'><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='%237c7c7c' font-size='12'>读取中</text></svg>";
      if (resume) {
        if (pendingShareSeek !== null) {
          pendingSeek = pendingShareSeek;
          pendingShareSeek = null;
        } else {
          pendingSeek = lastKnownProgress(song);
        }
      } else {
        pendingShareSeek = null;
        forgetProgress(song);
        pendingSeek = null;
      }

      resumeAutoScroll();

      if (syncUrl && song.id) {
        const u = new URL(window.location);
        u.search = '?play=' + song.id;
        window.history.replaceState(null, '', u.toString());
      }

      retrySkippedNodes = null;
      retryBypassOnce = false;
      playingFromRetryQueue = false;
      tryPlayFromNode(song, nodeIndex, isAuto);
    }

    var retrySkippedNodes = null;
    var retryBypassOnce = false;
    var playingFromRetryQueue = false;

    async function tryPlayFromNode(song, nodeIndex, isAuto = false) {
      const token = ++playToken;

      if (song && song.availableNodes && nodeIndex >= song.availableNodes.length && retrySkippedNodes && retrySkippedNodes.length > 0) {
        const nextRetryIdx = retrySkippedNodes.shift();
        retryBypassOnce = true;
        playingFromRetryQueue = true;
        tryPlayFromNode(song, nextRetryIdx, isAuto);
        return;
      }

      if (!song.availableNodes || nodeIndex >= song.availableNodes.length) {
        if (token !== playToken) return;
        stopStallHeartbeat();
        stallRetries = 0;
        pendingSeek = null;
        playingFromRetryQueue = false;
        reportDiagnostic({
          title: "所有 WebDAV 线路均尝试失败",
          sourceName: "全局容灾",
          status: 504,
          statusText: "All Nodes Failed",
          targetUrl: "N/A",
          cause: "该歌曲关联的所有 WebDAV 镜像节点均无法响应或返回错误。",
          solution: "请检查源配置。"
        }, { quiet: isAuto ? true : false });
        return;
      }

      let effectiveIndex = nodeIndex;
      const bypassThisHop = retryBypassOnce;
      retryBypassOnce = false;
      if (!bypassThisHop && effectiveIndex < song.availableNodes.length - 1 && isNodeAvoidable(song.availableNodes[effectiveIndex].sourceId)) {
        let probe = effectiveIndex;
        if (!retrySkippedNodes) retrySkippedNodes = [];
        while (probe < song.availableNodes.length - 1 && isNodeAvoidable(song.availableNodes[probe].sourceId)) {
          if (retrySkippedNodes.indexOf(probe) === -1) retrySkippedNodes.push(probe);
          probe = probe + 1;
        }
        effectiveIndex = probe;
      }
      const node = song.availableNodes[effectiveIndex];
      const totalInQueue = currentPlaylist.length > 0 ? (' (' + (currentIndex + 1) + '/' + currentPlaylist.length + ')') : '';
      document.getElementById('info-node').textContent = '线路: ' + (effectiveIndex + 1) + '/' + song.availableNodes.length + totalInQueue;

      const streamUrl = '/api/stream?sourceId=' + encodeURIComponent(node.sourceId) + '&file=' + encodeURIComponent(node.href);

      currentNodeIndex = effectiveIndex;
      currentIsAuto = isAuto;
      if (pendingSeek === null) pendingSeek = lastKnownProgress(song);

      audio.src = streamUrl;
      resetStallMarks();
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.then(() => {
          if (token !== playToken) return;
          waitingForGesture = false;
          document.getElementById('play-icon').setAttribute('href', '#icon-pause');
        }).catch(err => {
          if (token !== playToken) return;
          waitingForGesture = true;
          console.warn("等待缓冲或交互触发:", err);
        });
      }

      audio.onerror = async () => {
        if (token !== playToken) return;
        try {
          const check = await fetch(streamUrl, { headers: { 'Range': 'bytes=0-65535' } });
          if (token !== playToken) return;
          if (!check.ok) {
            const errJson = await check.json().catch(() => ({}));
            if (errJson.diagnostic) reportDiagnostic(errJson.diagnostic, { quiet: isAuto ? true : false });
          }
        } catch(e) {
          if (token !== playToken) return;
        }
        if (token !== playToken) return;
        console.warn('节点 ' + (effectiveIndex + 1) + ' 失败，尝试下一镜像...');
        markNodeBad(node.sourceId);
        pendingSeek = lastKnownProgress(song) || pendingSeek;
        tryPlayFromNode(song, playingFromRetryQueue ? song.availableNodes.length : effectiveIndex + 1, isAuto);
      };

      const cachedTags = tagCache.get(songKey(song));
      if (cachedTags) {
        renderTags(cachedTags, song.name);
      } else {
        renderLrc('');
        pendingTag = { song: song, url: streamUrl, token: playToken };
      }
    }

    function togglePlay() {
      if (audio.paused) {
        if (currentIndex === -1 && currentPlaylist.length > 0) {
          playTrackByIndex(0);
          return;
        }
        userPaused = false;
        waitingForGesture = false;
        externallyPaused = false;
        startStallHeartbeat();
        if (currentSongRef && (audio.error !== null || (audio.readyState === 0 && audio.currentTime === 0))) {
          const restored = lastKnownProgress(currentSongRef);
          if (restored !== null) {
            pendingSeek = restored;
            retrySkippedNodes = null;
            playingFromRetryQueue = false;
            tryPlayFromNode(currentSongRef, currentNodeIndex, currentIsAuto);
            return;
          }
        }
        const resumePlay = audio.play();
        if (resumePlay && typeof resumePlay.then === "function") {
          resumePlay.then(function () {
            document.getElementById('play-icon').setAttribute('href', '#icon-pause');
          }).catch(function () {});
        } else {
          document.getElementById('play-icon').setAttribute('href', '#icon-pause');
        }
      } else {
        userPaused = true;
        stopStallHeartbeat();
        audio.pause();
        document.getElementById('play-icon').setAttribute('href', '#icon-play');
      }
    }

    function playPrevSong() {
      if (currentPlaylist.length === 0) return;
      if (playMode === 'shuffle') {
        playTrackByIndex(Math.floor(Math.random() * currentPlaylist.length));
      } else {
        let prev = currentIndex - 1;
        if (prev < 0) prev = currentPlaylist.length - 1;
        playTrackByIndex(prev);
      }
    }

    function playNextSong(isAuto = false) {
      if (currentPlaylist.length === 0) return;
      if (playMode === 'shuffle') {
        playTrackByIndex(Math.floor(Math.random() * currentPlaylist.length), isAuto);
      } else {
        let next = currentIndex + 1;
        if (next >= currentPlaylist.length) next = 0;
        playTrackByIndex(next, isAuto);
      }
    }

    function togglePlayMode() {
      const modeBtn = document.getElementById('mode-btn');
      const modeIcon = document.getElementById('mode-icon');

      if (playMode === 'repeat') {
        playMode = 'repeat-one';
        modeBtn.title = '模式: 单曲循环';
        modeIcon.setAttribute('href', '#icon-repeat-one');
      } else if (playMode === 'repeat-one') {
        playMode = 'shuffle';
        modeBtn.title = '模式: 随机播放';
        modeIcon.setAttribute('href', '#icon-shuffle');
      } else {
        playMode = 'repeat';
        modeBtn.title = '模式: 列表循环';
        modeIcon.setAttribute('href', '#icon-repeat');
      }
    }

    audio.onended = () => {
      if (playMode === 'repeat-one') {
        audio.currentTime = 0;
        audio.play();
      } else {
        playNextSong(true);
      }
    };

    function renderBufferedRanges() {
      const el = document.getElementById('progress-buffered');
      if (!el) return;
      let left = 0;
      let width = 0;
      try {
        if (audio.buffered && audio.buffered.length && audio.duration && isFinite(audio.duration) && audio.duration > 0) {
          for (let i = 0; i < audio.buffered.length; i++) {
            const s = audio.buffered.start(i);
            const e2 = audio.buffered.end(i);
            if (s <= audio.currentTime + 0.5 && e2 > audio.currentTime) {
              left = (s / audio.duration) * 100;
              width = ((e2 - s) / audio.duration) * 100;
              break;
            }
          }
          if (width === 0) {
            const s = audio.buffered.start(0);
            const e2 = audio.buffered.end(0);
            left = (s / audio.duration) * 100;
            width = ((e2 - s) / audio.duration) * 100;
          }
        }
      } catch (rangeErr) { left = 0; width = 0; }
      el.style.left = left + '%';
      el.style.width = width + '%';
    }

    audio.onprogress = renderBufferedRanges;

    audio.onseeked = () => {
      const seekingBar = document.getElementById('progress-bar');
      if (seekingBar) seekingBar.classList.remove('is-seeking');
    };

    function seekAudio(e) {
      const bar = document.getElementById('progress-bar');
      if (!bar || typeof bar.getBoundingClientRect !== 'function') return;
      const rect = bar.getBoundingClientRect();
      if (!rect || !rect.width) return;
      const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      if (audio.duration && isFinite(audio.duration)) {
        audio.currentTime = pct * audio.duration;
        bar.classList.add('is-seeking');
      }
    }

    audio.ontimeupdate = () => {
      if (!audio.paused && pendingSeek === null && audio.readyState >= 3 && audio.currentTime > lastProgressTime) {
        lastProgressAt = Date.now();
        stallRetries = 0;
      }
      lastProgressTime = audio.currentTime;
      const rememberingKey = songKey(currentSongRef);
      if (pendingSeek === null && isFinite(audio.currentTime)) {
        if (rememberingKey !== null) progressMemory.set(rememberingKey, audio.currentTime);
        persistProgress(rememberingKey, audio.currentTime);
      }
      document.getElementById('time-current').textContent = formatTime(audio.currentTime);
      if (audio.duration) {
        const pct = (audio.currentTime / audio.duration) * 100;
        document.getElementById('progress-fill').style.width = pct + '%';
      }
      renderBufferedRanges();

      if (lrcData.length === 0) return;

      let active = -1;
      for (let i = 0; i < lrcData.length; i++) {
        if (audio.currentTime >= lrcData[i].time) active = i;
        else break;
      }

      if (active !== -1) {
        const lines = document.querySelectorAll('.lrc-line');
        lines.forEach(el => el.classList.remove('active'));
        const target = document.getElementById('lrc-' + active);
        if (target) {
          target.classList.add('active');
          if (!isUserScrollingLyrics) {
            const box = document.getElementById('lrc-viewport');
            if (box) {
              const targetTop = target.offsetTop - (box.clientHeight - target.offsetHeight) / 2;
              const maxScroll = Math.max(0, box.scrollHeight - box.clientHeight);
              box.scrollTo({ top: Math.max(0, Math.min(maxScroll, targetTop)), behavior: 'smooth' });
            }
          }
        }
      }
    };

    audio.onloadedmetadata = () => {
      document.getElementById('time-duration').textContent = formatTime(audio.duration);
      if (pendingSeek !== null && isFinite(audio.duration) && pendingSeek > 3 && pendingSeek < audio.duration - 10) {
        try { audio.currentTime = pendingSeek; } catch (e) {}
      }
      pendingSeek = null;
      resetStallMarks();
      startStallHeartbeat();
      const metaBar = document.getElementById('progress-bar');
      if (metaBar) metaBar.classList.remove('is-seeking');
      if (pendingTag && pendingTag.token === playToken) {
        const job = pendingTag;
        pendingTag = null;
        parseAndCacheTags(job.song, job.url, job.token);
      }
    };

    function resetCoverAmbient() {
      const cover = document.getElementById('cover');
      if (cover) {
        cover.onload = null;
        cover.onerror = null;
      }
      const main = document.getElementById('main');
      if (!main) return;
      main.classList.remove('has-cover-ambient');
      main.style.removeProperty('--cover-ambient-rgb');
    }

    function applyCoverAmbient(image) {
      const main = document.getElementById('main');
      if (!main || !image || !image.naturalWidth || !image.naturalHeight) return resetCoverAmbient();
      const canvas = document.createElement('canvas');
      const size = 48;
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return resetCoverAmbient();
      try {
        context.drawImage(image, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        let red = 0;
        let green = 0;
        let blue = 0;
        let weightTotal = 0;
        let saturationWeight = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3] / 255;
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const lightness = (max + min) / 510;
          const saturation = max === min ? 0 : (max - min) / max;
          if (alpha < 0.8 || max < 30 || lightness < 0.10 || saturation < 0.10) continue;
          const weight = alpha * saturation * Math.min(1, lightness * 1.8);
          red += r * weight;
          green += g * weight;
          blue += b * weight;
          saturationWeight += saturation * weight;
          weightTotal += weight;
        }
        if (weightTotal < 12 || saturationWeight / weightTotal < 0.16) return resetCoverAmbient();
        const result = [Math.round(red / weightTotal), Math.round(green / weightTotal), Math.round(blue / weightTotal)];
        main.style.setProperty('--cover-ambient-rgb', result.join(','));
        main.classList.add('has-cover-ambient');
      } catch (e) {
        resetCoverAmbient();
      }
    }

    function songKey(song) {
      if (!song) return null;
      return song.id || song.name || null;
    }

    function lastKnownProgress(song) {
      const key = songKey(song);
      if (key === null) return null;
      if (progressMemory.has(key)) return progressMemory.get(key);
      try {
        const raw = sessionStorage.getItem(PROGRESS_STORE_KEY);
        if (!raw) return null;
        const rec = JSON.parse(raw);
        if (!rec || rec.key !== key || typeof rec.time !== 'number') return null;
        if (Date.now() - rec.at > PROGRESS_TTL_MS) return null;
        if (rec.time < 3) return null;
        progressMemory.set(key, rec.time);
        return rec.time;
      } catch (e) {
        return null;
      }
    }

    function persistProgress(key, time) {
      if (key === null || !isFinite(time) || time < 3) return;
      const now = Date.now();
      if (now - lastPersistAt < 5000) return;
      lastPersistAt = now;
      try {
        sessionStorage.setItem(PROGRESS_STORE_KEY, JSON.stringify({ key: key, time: time, at: now }));
      } catch (e) {}
    }

    function forgetProgress(song) {
      const key = songKey(song);
      if (key === null) return;
      progressMemory.delete(key);
      try {
        const raw = sessionStorage.getItem(PROGRESS_STORE_KEY);
        if (raw) {
          const rec = JSON.parse(raw);
          if (rec && rec.key === key) sessionStorage.removeItem(PROGRESS_STORE_KEY);
        }
      } catch (e) {}
    }

    function resetStallMarks() {
      lastProgressTime = audio.currentTime;
      lastProgressAt = Date.now();
    }

    function startStallHeartbeat() {
      stopStallHeartbeat();
      resetStallMarks();
      stallHeartbeat = window.setInterval(stallHeartbeatTick, STALL_HEARTBEAT_MS);
    }

    function stopStallHeartbeat() {
      if (stallHeartbeat !== null) {
        window.clearInterval(stallHeartbeat);
        stallHeartbeat = null;
      }
    }

    function stallHeartbeatTick() {
      if (!currentSongRef || userPaused || externallyPaused) return;
      if (waitingForGesture) { tryResumeGesture(); return; }
      if (audio.currentTime > lastProgressTime + 0.1) {
        lastProgressTime = audio.currentTime;
        lastProgressAt = Date.now();
        return;
      }
      if (audio.readyState >= 3) {
        lastProgressAt = Date.now();
        return;
      }
      if (Date.now() - lastProgressAt < STALL_TIMEOUT_MS) return;
      recoverPlayback();
    }

    function recoverPlayback() {
      const song = currentSongRef;
      if (!song) return;
      if (stallRetries < STALL_MAX_RETRIES) {
        stallRetries = stallRetries + 1;
        console.warn('播放停滞，就地重连并回到上次进度（第 ' + stallRetries + ' 次）');
        showToast('网络抖动，正在恢复播放位置…');
        if (pendingSeek === null) {
          const livePos = audio.currentTime;
          pendingSeek = (isFinite(livePos) && livePos >= 3) ? livePos : lastKnownProgress(song);
        }
        resetStallMarks();
        tryPlayFromNode(song, currentNodeIndex, currentIsAuto);
        return;
      }
      stallRetries = 0;
      console.warn('就地重连无效，切换下一镜像线路');
      const abandoned = currentSongRef && currentSongRef.availableNodes ? currentSongRef.availableNodes[currentNodeIndex] : null;
      if (abandoned) markNodeBad(abandoned.sourceId);
      resetStallMarks();
      tryPlayFromNode(song, playingFromRetryQueue ? song.availableNodes.length : currentNodeIndex + 1, currentIsAuto);
    }

    function normalizeTags(t) {
      const out = { title: null, artist: null, coverUrl: null, lrc: '' };
      if (!t) return out;
      out.title = t.title || null;
      out.artist = t.artist || null;
      if (t.picture && t.picture.data) {
        try {
          const byteArr = new Uint8Array(t.picture.data);
          out.coverUrl = URL.createObjectURL(new Blob([byteArr], { type: t.picture.format }));
        } catch (e) {
          out.coverUrl = null;
        }
      }
      if (t.lyrics) {
        if (typeof t.lyrics === 'string') out.lrc = t.lyrics;
        else if (t.lyrics.lyrics) out.lrc = t.lyrics.lyrics;
        else if (t.lyrics.data && t.lyrics.data.lyrics) out.lrc = t.lyrics.data.lyrics;
      } else if (t.USLT && t.USLT.data) {
        out.lrc = t.USLT.data.lyrics || t.USLT.data || '';
      }
      return out;
    }

    async function readEmbeddedTags(url) {
      try {
        const jmt = await getJsMediaTags();
        if (!jmt) return null;
        const tagUrl = new URL(url, window.location.href).href;
        return await new Promise((resolve) => {
          let settled = false;
          const done = (value) => { if (!settled) { settled = true; resolve(value); } };
          const reader = jmt.read(tagUrl, {
            onSuccess: (tag) => done(normalizeTags(tag.tags)),
            onError: () => done(null)
          });
          if (tagAbort) {
            const cancelTagRead = () => { done(null); if (reader && typeof reader.abort === 'function') { try { reader.abort(); } catch (e) {} } };
            if (tagAbort.signal.aborted) {
              cancelTagRead();
            } else {
              tagAbort.signal.addEventListener('abort', cancelTagRead);
            }
          }
        });
      } catch (e) {
        return null;
      }
    }

    function trimTagCache(keepKey, shownKey) {
      const snapshot = [...tagCache.keys()];
      for (const tagKey of snapshot) {
        if (tagCache.size <= TAG_CACHE_MAX) break;
        if (tagKey === keepKey || tagKey === shownKey) continue;
        const entry = tagCache.get(tagKey);
        if (entry && entry.coverUrl) URL.revokeObjectURL(entry.coverUrl);
        tagCache.delete(tagKey);
      }
    }

    function renderTags(tags, fallbackTitle) {
      document.getElementById('stitle').textContent = (tags && tags.title) || fallbackTitle;
      document.getElementById('sartist').textContent = (tags && tags.artist) || "未知艺术家";
      const tagTitle = (tags && tags.title) || fallbackTitle;
      document.title = tagTitle + " | " + (siteTitle || "Cloud Music Hub");
      if (navigator.mediaSession && window.MediaMetadata) {
        try {
          const coverUrl = tags && tags.coverUrl ? tags.coverUrl : '';
          navigator.mediaSession.metadata = new window.MediaMetadata({ title: tagTitle, artist: (tags && tags.artist) || '', artwork: coverUrl ? [{ src: coverUrl }] : [] });
        } catch (e) {}
      }
      const cover = document.getElementById('cover');
      resetCoverAmbient();
      if (tags && tags.coverUrl && cover) {
        cover.onload = () => { if (cover.src !== tags.coverUrl) return; applyCoverAmbient(cover); };
        cover.onerror = () => { if (cover.src === tags.coverUrl) resetCoverAmbient(); };
        cover.src = tags.coverUrl;
      }
      renderLrc(tags ? tags.lrc : '');
    }

    async function parseAndCacheTags(song, url, token) {
      const key = songKey(song);
      if (key === null) return;
      const cached = tagCache.get(key);
      if (cached) {
        if (token === playToken) renderTags(cached, song.name);
        return;
      }
      const tags = await readEmbeddedTags(url);
      if (tags) {
        if (tagCache.has(key)) {
          const discardedCoverUrl = tags.coverUrl;
          if (discardedCoverUrl) URL.revokeObjectURL(discardedCoverUrl);
        } else {
          tagCache.set(key, tags);
        }
        trimTagCache(key, songKey(currentSongRef));
      }
      if (token !== playToken) return;
      if (!tags) {
        renderTags(null, song.name);
        return;
      }
      renderTags(tagCache.get(key) || tags, song.name);
    }

    function tryResumeGesture() {
      if (!currentSongRef || userPaused || externallyPaused) return;
      if (!audio.paused) return;
      const resumePromise = audio.play();
      if (resumePromise && typeof resumePromise.then === "function") {
        resumePromise.then(function () {
          if (!userPaused && !externallyPaused) {
            waitingForGesture = false;
            document.getElementById('play-icon').setAttribute('href', '#icon-pause');
          }
        }).catch(function () {});
      }
    }

    audio.onplaying = () => {
      waitingForGesture = false;
      externallyPaused = false;
      const playingNode = currentSongRef && currentSongRef.availableNodes ? currentSongRef.availableNodes[currentNodeIndex] : null;
      if (playingNode) clearNodeBad(playingNode.sourceId);
      resetStallMarks();
      startStallHeartbeat();
      const playingBar = document.getElementById('progress-bar');
      if (playingBar) playingBar.classList.remove('is-seeking');
    };

    audio.oncanplay = () => {
      if (waitingForGesture) tryResumeGesture();
    };
    audio.onpause = () => {
      if (!userPaused) {
        externallyPaused = true;
        stopStallHeartbeat();
      }
    };
    audio.onstalled = stallHeartbeatTick;
    audio.onwaiting = stallHeartbeatTick;
    window.addEventListener('online', () => {
      if (currentSongRef && !userPaused && !waitingForGesture) stallHeartbeatTick();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && currentSongRef && !userPaused && !waitingForGesture) stallHeartbeatTick();
    });
    window.addEventListener('pagehide', () => {
      const key = songKey(currentSongRef);
      if (key === null || !isFinite(audio.currentTime) || audio.currentTime < 3) return;
      try {
        sessionStorage.setItem(PROGRESS_STORE_KEY, JSON.stringify({ key: key, time: audio.currentTime, at: Date.now() }));
      } catch (e) {}
    });

    function renderLrc(lrcText) {
      const container = document.getElementById('lrc-content');
      lrcData = [];
      if (!lrcText) return container.innerHTML = '<div class="lrc-line" style="justify-content:center;">暂无内嵌歌词</div>';

      const lines = lrcText.split('\\n');
      const timeRegex = /\\[(\\d{2}):(\\d{2})(?:\\.(\\d{2,3}))?\\]/g;
      lines.forEach(l => {
        let m;
        while ((m = timeRegex.exec(l)) !== null) {
          const t = parseInt(m[1]) * 60 + parseInt(m[2]) + (m[3] ? parseInt(m[3]) / 1000 : 0);
          lrcData.push({ time: t, text: l.replace(/\\[\\d{2}:\\d{2}(?:\\.\\d{2,3})?\\]/g, '').trim() });
        }
      });

      container.innerHTML = '';
      lrcData.sort((a, b) => a.time - b.time);
      if (lrcData.length > 0) {
        lrcData.forEach((item, i) => {
          const div = document.createElement('div');
          div.className = 'lrc-line';
          div.id = 'lrc-' + i;
          div.innerHTML = '<span>' + escapeHtml(item.text) + '</span><span class="lrc-time-hint">' + formatTime(item.time) + ' ▶</span>';
          div.addEventListener('click', () => {
            audio.currentTime = item.time;
            audio.play();
            resumeAutoScroll();
          });
          container.appendChild(div);
        });
      } else {
        container.innerHTML = '<div class="lrc-line" style="white-space:pre-wrap; justify-content:center;">' + escapeHtml(lrcText) + '</div>';
      }
    }

    async function openAdmin() {
      document.getElementById('admin-modal').classList.add('show');
      if (isAuthed) {
        showAdminContent();
      } else {
        document.getElementById('admin-login-sec').style.display = 'block';
        document.getElementById('admin-content-sec').style.display = 'none';
      }
    }

    function closeAdmin() { document.getElementById('admin-modal').classList.remove('show'); }

    async function submitInit() {
      const pass = document.getElementById('init-pass').value;
      const title = document.getElementById('init-title').value;
      if (!pass) return showAppDialog('密码必填');

      const res = await fetch('/api/admin/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPass: pass, siteTitle: title })
      });
      if (res.ok) {
        document.getElementById('init-modal').classList.remove('show');
        isAuthed = true;
        init();
      } else {
        let msg = '初始化失败';
        try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
        showAppDialog(msg);
      }
    }

    let adminLoggingIn = false;

    async function loginAdmin() {
      if (adminLoggingIn) return;
      adminLoggingIn = true;
      try {
        const pass = document.getElementById('login-admin-pass').value;
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adminPass: pass })
        });
        if (res.ok) {
          isAuthed = true;
          showAdminContent();
        } else {
          let msg = '密码错误';
          try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
          showAppDialog(msg);
        }
      } finally {
        adminLoggingIn = false;
      }
    }

    function handleLoginKeydown(e) {
      if (e.key === 'Enter') loginAdmin();
    }

    document.getElementById('login-admin-pass').addEventListener('keydown', handleLoginKeydown);

    async function showAdminContent() {
      document.getElementById('admin-login-sec').style.display = 'none';
      document.getElementById('admin-content-sec').style.display = 'block';
      const res = await fetch('/api/admin/sources');
      const sources = await res.json();
      renderSourcesEditor(sources);
    }

    function renderSourcesEditor(sources) {
      const container = document.getElementById('sources-container');
      container.innerHTML = '';
      sources.forEach((s, idx) => container.appendChild(createSourceCard(s, idx, false)));
      bindDragHandles();
    }

    function createSourceCard(s = {}, idx = Date.now(), isOpen = false) {
      const div = document.createElement('div');
      div.className = 'source-card' + (isOpen ? ' open' : '');
      const sourceName = s.name || '未命名源';
      const sourceUrl = s.url || '';

      div.innerHTML = \`
        <div class="source-card-header" onclick="toggleCard(this)">
          <div class="source-header-left">
            <svg class="md-icon md-icon-sm chevron-icon"><use href="#icon-chevron-down"/></svg>
            <span class="source-name-badge">\${escapeHtml(sourceName)}</span>
            <span class="source-url-preview">\${escapeHtml(sourceUrl)}</span>
          </div>
          <button type="button" class="drag-handle" title="拖拽排序" aria-label="拖拽排序">
            <svg class="md-icon md-icon-sm"><use href="#icon-drag-indicator"/></svg>
          </button>
          <button class="del-btn" onclick="event.stopPropagation(); deleteCard(this)" title="删除源">
            <svg class="md-icon md-icon-sm"><use href="#icon-delete"/></svg>
          </button>
        </div>
        <div class="source-card-body">
          <div class="input-row"><label>源别名</label><input class="s-name" value="\${escapeHtml(s.name || '')}" placeholder="例如：Koofr / 备用NAS" oninput="updateCardTitle(this)"></div>
          <div class="input-row"><label>WebDAV 地址 (URL)</label><input class="s-url" value="\${escapeHtml(s.url || '')}" placeholder="https://app.koofr.net/dav/Koofr/music" oninput="updateCardUrl(this)"></div>
          <div class="input-row"><label>账号 (无则留空)</label><input class="s-user" value="\${escapeHtml(s.user || '')}"></div>
          <div class="input-row"><label>密码 (无则留空)</label><input type="password" class="s-pass" value="\${escapeHtml(s.pass || '')}"></div>
          <input type="hidden" class="s-id" value="\${escapeHtml(s.id || ('s_' + Date.now() + Math.random().toString(36).substr(2,4)))}">
        </div>
      \`;
      return div;
    }

    function toggleCard(headerEl) {
      const card = headerEl.closest('.source-card');
      card.classList.toggle('open');
    }

    function deleteCard(btnEl) {
      btnEl.closest('.source-card').remove();
    }

    var dragState = null;

    function getDragCardFromEvent(e) {
      var handle = e.target && e.target.closest ? e.target.closest('.drag-handle') : null;
      if (!handle) return null;
      return handle.closest('.source-card');
    }

    function beginDrag(e) {
      if (dragState) return;
      var card = getDragCardFromEvent(e);
      if (!card) return;
      e.preventDefault();
      e.stopPropagation();
      var st = { pointerId: e.pointerId, card: card, started: false };
      try {
        e.target.setPointerCapture(e.pointerId);
      } catch (err) {}
      dragState = st;
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragEnd);
      window.addEventListener('pointercancel', onDragCancel);
    }

    function resolveDropIndex(e) {
      var container = document.getElementById('sources-container');
      if (!container) return -1;
      var cards = container.querySelectorAll('.source-card');
      for (var i = 0; i < cards.length; i++) {
        var r = cards[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) return i;
      }
      return cards.length;
    }

    function onDragMove(e) {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      if (!dragState.started) {
        dragState.started = true;
        dragState.card.classList.add('dragging');
      }
      var container = document.getElementById('sources-container');
      if (!container) return;
      var idx = resolveDropIndex(e);
      var line = container.querySelector('.drag-indicator-line');
      if (idx < 0) {
        if (line) line.remove();
        return;
      }
      if (!line) {
        line = document.createElement('div');
        line.className = 'drag-indicator-line';
      }
      var cards = container.querySelectorAll('.source-card');
      if (idx >= cards.length) {
        container.appendChild(line);
      } else {
        container.insertBefore(line, cards[idx]);
      }
    }

    function onDragEnd(e) {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      finishDrag(e);
    }

    function onDragCancel(e) {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      finishDrag(e);
    }

    function finishDrag(e) {
      var st = dragState;
      if (!st) return;
      dragState = null;
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
      window.removeEventListener('pointercancel', onDragCancel);
      st.card.classList.remove('dragging');
      var container = document.getElementById('sources-container');
      var line = container ? container.querySelector('.drag-indicator-line') : null;
      if (line) line.remove();
      if (!e || !st.started || !container) return;
      var idx = resolveDropIndex(e);
      if (idx < 0) return;
      var cards = container.querySelectorAll('.source-card');
      var from = Array.prototype.indexOf.call(cards, st.card);
      if (from === -1) return;
      var target = st.card;
      if (idx >= cards.length) {
        var last = cards[cards.length - 1];
        if (last !== st.card) target = null;
      } else {
        target = cards[idx];
      }
      if (target === st.card) return;
      if (idx >= cards.length) {
        container.appendChild(st.card);
      } else {
        container.insertBefore(st.card, target);
      }
    }

    function bindDragHandles() {
      var container = document.getElementById('sources-container');
      if (!container || container.dataset.dragBound === '1') return;
      container.dataset.dragBound = '1';
      container.addEventListener('pointerdown', beginDrag);
    }

    window.addEventListener('blur', () => { if (dragState) finishDrag(null); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && dragState) finishDrag(null); });

    function updateCardTitle(inputEl) {
      const badge = inputEl.closest('.source-card').querySelector('.source-name-badge');
      badge.textContent = inputEl.value || '未命名源';
    }

    function updateCardUrl(inputEl) {
      const preview = inputEl.closest('.source-card').querySelector('.source-url-preview');
      preview.textContent = inputEl.value || '';
    }

    function addNewSourceUI() {
      const container = document.getElementById('sources-container');
      const newCard = createSourceCard({}, Date.now(), true);
      container.appendChild(newCard);
    }

    let passOkCb = null;

    function askPassphrase(title, onOk) {
      passOkCb = onOk;
      document.getElementById('pass-modal-title').textContent = title;
      const inp = document.getElementById('pass-input');
      inp.value = '';
      document.getElementById('pass-modal').classList.add('show');
      inp.focus();
    }

    function closePassModal() {
      document.getElementById('pass-modal').classList.remove('show');
      passOkCb = null;
    }

    function confirmPass() {
      const v = document.getElementById('pass-input').value;
      const cb = passOkCb;
      closePassModal();
      if (cb) cb(v);
    }

    function cancelPass() { closePassModal(); }

    document.getElementById('pass-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmPass();
    });

    let appDialogOk = null;

    function showAppDialog(msg, onOk) {
      appDialogOk = (typeof onOk === 'function') ? onOk : null;
      document.getElementById('app-dialog-msg').textContent = msg;
      const modal = document.getElementById('app-dialog');
      modal.classList.add('show');
      const ok = document.getElementById('app-dialog-ok');
      if (ok) ok.focus();
    }

    function closeAppDialog() {
      const cb = appDialogOk;
      appDialogOk = null;
      document.getElementById('app-dialog').classList.remove('show');
      if (cb) cb();
    }

    function dismissAppDialog() {
      appDialogOk = null;
      document.getElementById('app-dialog').classList.remove('show');
    }

    function openPasteModal(mode, text) {
      const title = document.getElementById('paste-modal-title');
      const label = document.getElementById('paste-modal-label');
      const ta = document.getElementById('paste-text');
      const passRow = document.getElementById('paste-pass-row');
      const passInput = document.getElementById('paste-pass-input');
      const copyBtn = document.getElementById('paste-copy-btn');
      const parseBtn = document.getElementById('paste-parse-btn');
      if (mode === 'export') {
        title.textContent = '导出口令';
        label.textContent = '已生成单行口令，复制保存；在别处粘贴即可还原源配置';
        ta.value = text || '';
        ta.readOnly = true;
        passRow.style.display = 'none';
        passInput.value = '';
        copyBtn.style.display = '';
        parseBtn.style.display = 'none';
      } else {
        title.textContent = '粘贴口令导入';
        label.textContent = '粘贴 WMP1. 开头的单行口令文本';
        ta.value = text || '';
        ta.readOnly = false;
        passRow.style.display = '';
        passInput.value = '';
        copyBtn.style.display = 'none';
        parseBtn.style.display = '';
      }
      showPasteError('');
      document.getElementById('paste-modal').classList.add('show');
      try { ta.focus(); } catch (e) {}
    }

    function showPasteError(msg) {
      const el = document.getElementById('paste-error');
      if (!el) return;
      el.textContent = msg;
      el.style.display = msg ? 'block' : 'none';
    }

    function closePasteModal() {
      document.getElementById('paste-modal').classList.remove('show');
    }

    function copyExportCode() {
      const sources = collectEditorSources();

      if (sources.length === 0) return showAppDialog('当前没有可导出的源配置！');

      if (!window.crypto || !window.crypto.subtle) {
        return showToast('当前环境不支持 WebCrypto，无法加密导出（请使用 HTTPS 或 localhost 访问）');
      }
      askPassphrase('设置导出加密口令', (pass) => {
        if (!pass) return showToast('口令不能为空');
        encryptSourcesJson(sources, pass).then((envelope) => {
          const text = 'WMP1.' + btoa(JSON.stringify(envelope));
          openPasteModal('export', text);
        }).catch((err) => {
          showToast('加密失败: ' + err.message);
        });
      });
    }

    function pasteImportCode() {
      openPasteModal('import', '');
    }

    function doCopyPaste() {
      const ta = document.getElementById('paste-text');
      const text = ta.value || '';
      if (!text) return showToast('口令为空');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast('口令已复制')).catch(() => fallbackCopyText(text));
      } else {
        fallbackCopyText(text);
      }
    }

    function finishPasteImport(list) {
      closePasteModal();
      applyImportedSources(list);
    }

    function doParsePaste() {
      const raw = (document.getElementById('paste-text').value || '').trim();
      showPasteError('');
      if (!raw) {
        showPasteError('口令文本为空');
        return;
      }
      if (raw.slice(0, 5) !== 'WMP1.') {
        showPasteError('口令格式无效（应为 WMP1. 开头的单行口令）');
        return;
      }
      let envelope;
      try {
        envelope = JSON.parse(atob(raw.slice(5)));
      } catch (e) {
        showPasteError('口令格式无效（base64 或 JSON 解析失败）');
        return;
      }
      if (!envelope || envelope.v !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.cipher !== 'AES-GCM') {
        showPasteError('无法识别的口令版本（应为 PBKDF2-SHA256 + AES-GCM 信封）');
        return;
      }
      if (!window.crypto || !window.crypto.subtle) {
        showPasteError('当前环境不支持 WebCrypto，无法解密导入（请使用 HTTPS 或 localhost 访问）');
        return;
      }
      const pass = document.getElementById('paste-pass-input').value;
      if (!pass) {
        showPasteError('请输入导出时设置的解密口令');
        return;
      }
      decryptSourcesJson(envelope, pass).then(function (dec) {
        finishPasteImport(Array.isArray(dec) ? dec : []);
      }).catch(function () {
        showPasteError('解密失败：口令错误或口令内容已损坏');
      });
    }

    document.getElementById('paste-pass-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doParsePaste();
    });

    function toB64(bytes) {
      let bin = '';
      bytes.forEach(b => { bin += String.fromCharCode(b); });
      return btoa(bin);
    }

    function fromB64(b64) {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    async function deriveAesKey(pass, salt, usage) {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt, iterations: 210000, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        [usage]
      );
    }

    async function encryptSourcesJson(sources, pass) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveAesKey(pass, salt, 'encrypt');
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(sources)));
      return {
        app: "webdav_music_player",
        v: 1,
        kdf: "PBKDF2-SHA256",
        iter: 210000,
        cipher: "AES-GCM",
        salt: toB64(salt),
        iv: toB64(iv),
        ct: toB64(new Uint8Array(ct))
      };
    }

    async function decryptSourcesJson(envelope, pass) {
      const key = await deriveAesKey(pass, fromB64(envelope.salt), 'decrypt');
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.ct));
      return JSON.parse(new TextDecoder().decode(plain));
    }

    function collectEditorSources() {
      const cards = document.querySelectorAll('.source-card');
      const out = [];
      cards.forEach(c => {
        out.push({
          id: c.querySelector('.s-id').value,
          name: c.querySelector('.s-name').value || '未命名源',
          url: c.querySelector('.s-url').value,
          user: c.querySelector('.s-user').value,
          pass: c.querySelector('.s-pass').value
        });
      });
      return out;
    }

    function exportSourcesJson() {
      const sources = collectEditorSources();

      if (sources.length === 0) return showAppDialog('当前没有可导出的源配置！');

      if (!window.crypto || !window.crypto.subtle) {
        return showToast('当前环境不支持 WebCrypto，无法加密导出（请使用 HTTPS 或 localhost 访问）');
      }

      askPassphrase('设置导出加密口令', (pass) => {
        if (!pass) return showToast('口令不能为空');
        encryptSourcesJson(sources, pass).then((envelope) => {
          const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'webdav_sources_' + new Date().toISOString().slice(0, 10) + '.enc.json';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1500);
        }).catch((err) => {
          showToast('加密失败: ' + err.message);
        });
      });
    }

    function triggerImportSources() { document.getElementById('import-file-input').click(); }

    function applyImportedSources(list) {
      const container = document.getElementById('sources-container');
      let addedCount = 0;
      let updatedCount = 0;

      const existingCards = Array.from(container.querySelectorAll('.source-card'));

      list.forEach(incoming => {
        if (!incoming.url) return;
        const normUrl = incoming.url.trim().replace(/\\/+$/, '').toLowerCase();

        const matchedCard = existingCards.find(card => {
          const currentUrl = card.querySelector('.s-url').value.trim().replace(/\\/+$/, '').toLowerCase();
          return currentUrl === normUrl;
        });

        if (matchedCard) {
          matchedCard.querySelector('.s-name').value = incoming.name || matchedCard.querySelector('.s-name').value;
          matchedCard.querySelector('.s-user').value = incoming.user || '';
          matchedCard.querySelector('.s-pass').value = incoming.pass || '';
          updateCardTitle(matchedCard.querySelector('.s-name'));
          updateCardUrl(matchedCard.querySelector('.s-url'));
          updatedCount++;
        } else {
          container.appendChild(createSourceCard(incoming, Date.now() + Math.random(), false));
          addedCount++;
        }
      });

      showAppDialog(\`导入完成！新增 \${addedCount} 个源，更新 \${updatedCount} 个已有源。请点击底部的“保存更改”写入 KV。\`);
    }

    function handleImportFile(event) {
      const file = event.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const parsed = JSON.parse(e.target.result);
          if (Array.isArray(parsed)) {
            showToast('检测到旧版明文配置，建议尽快重新加密导出');
            applyImportedSources(parsed);
            return;
          }
          if (!parsed || parsed.v !== 1 || parsed.kdf !== 'PBKDF2-SHA256' || parsed.cipher !== 'AES-GCM') {
            throw new Error('无法识别的备份文件格式（应为数组或加密信封）');
          }
          askPassphrase('输入该备份文件的加密口令', (pass) => {
            if (!pass) return showToast('口令不能为空');
            decryptSourcesJson(parsed, pass).then((dec) => {
              applyImportedSources(Array.isArray(dec) ? dec : []);
            }).catch(() => {
              showToast('口令错误或文件已损坏');
            });
          });
        } catch (err) {
          showAppDialog('导入失败: ' + err.message);
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    }

    async function saveAdminData() {
      const sources = collectEditorSources();

      const newPass = document.getElementById('new-admin-pass').value;
      const newTitle = document.getElementById('admin-site-title').value.trim();
      const res = await fetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources, siteTitle: newTitle || undefined, newAdminPass: newPass || undefined })
      });

      if (res.ok) {
        showAppDialog('配置已成功写入 KV 并刷新缓存！', function () { closeAdmin(); location.reload(); });
      } else {
        let msg = '保存失败，请检查源配置';
        try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
        showAppDialog(msg);
      }
    }

    async function logoutAdmin() {
      await fetch('/api/admin/logout');
      isAuthed = false;
      closeAdmin();
      location.reload();
    }

    init();
  </script>
</body>
</html>`;
}