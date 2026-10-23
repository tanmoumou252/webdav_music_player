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
          const segRetryBaseMs = parseSegmentRetryBaseMs(env && env.STREAM_SEGMENT_RETRY_BASE_MS);
          let segCount = rangeCount > segPartSize ? Math.ceil(rangeCount / segPartSize) : 0;
          if (segCount > segMaxSegments) {
            segCount = segMaxSegments;
            segPartSize = Math.ceil(rangeCount / segCount);
          }
          if (segCount > 0 && segPartSize <= SEGMENT_PART_SIZE_MAX) {
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
                  if (probeAttempt === 2) break;
                  await new Promise((resolveSleep) => { setTimeout(resolveSleep, segmentRetryDelayMs(probeAttempt, segRetryBaseMs)); });
                  if (fanoutAbort.signal.aborted) break;
                }
              } catch (probeFetchErr) {
                if (fanoutAbort.signal.aborted) { probeErr = probeFetchErr; break; }
                if (probeAttempt === 2) break;
                firstSegRes = null;
                await new Promise((resolveSleep) => { setTimeout(resolveSleep, segmentRetryDelayMs(probeAttempt, segRetryBaseMs)); });
                if (fanoutAbort.signal.aborted) { probeErr = probeFetchErr; break; }
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
              segmentRetryBaseMs: segRetryBaseMs,
              stallDeadlineMs: upstreamTimeoutMs,
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

