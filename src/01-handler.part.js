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
      try {
        const cdnRes = await fetch("https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js");
        const body = await cdnRes.text();
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
      if (sources) {
        if (sources.some(s => !s || typeof s !== "object" || !isValidSourceUrl(s.url))) {
          return new Response(JSON.stringify({ error: "源配置无效：url 必须为 http/https 且格式合法" }), { status: 400, headers: corsHeaders });
        }
        await env.MUSIC_KV.put("dav_sources", JSON.stringify(sources));
      }
      if (siteTitle) await env.MUSIC_KV.put("site_title", siteTitle);

      const listKeys = await env.MUSIC_KV.list({ prefix: "cache_v3_list_" });
      for (const k of listKeys.keys) {
        await env.MUSIC_KV.delete(k.name);
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
            const res = await fetchWebDavList(src);
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

          const res = await fetchWebDavList(src);
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

      const forwardHeaders = new Headers();
      if (src.user || src.pass) {
        forwardHeaders.set("Authorization", "Basic " + btoa(unescape(encodeURIComponent(`${src.user || ""}:${src.pass || ""}`))));
      }

      if (request.headers.has("Range")) {
        forwardHeaders.set("Range", request.headers.get("Range"));
      }

      try {
        const res = await fetch(targetUrl, {
          method: request.method,
          headers: forwardHeaders
        });

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
        respHeaders.set("Accept-Ranges", "bytes");

        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: respHeaders
        });
      } catch (networkErr) {
        const diag = generateDiagnostic(0, networkErr.message, targetUrl, request.method, src.name, "");
        if (await requireAdminSafe()) {
          return new Response(JSON.stringify({ error: diag.title, diagnostic: diag }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
          });
        }
        return new Response(JSON.stringify({ error: "无法连通源站", diagnostic: null }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
        });
      }
    }

    const pageHeaders = new Headers({ "Content-Type": "text/html; charset=utf-8" });
    pageHeaders.set("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src-elem * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * https: http: data: blob:; media-src * data: blob: https: http:; img-src * data: blob: https: http:; style-src * 'unsafe-inline'; font-src * data: blob:;");
    pageHeaders.set("Cache-Control", "no-store");

    const playId = url.searchParams.get("play") || url.searchParams.get("v") || url.searchParams.get("id");
    let html = renderHTML();
    if (playId && /^[0-9a-f]{8}$/i.test(playId)) {
      try {
        const normPlayId = playId.toLowerCase();
        const siteTitle = (await env.MUSIC_KV.get("site_title")) || "";
        const cachedPlaylist = await env.MUSIC_KV.get("cache_v3_list_all", "json");
        const sharedSong = cachedPlaylist && Array.isArray(cachedPlaylist.items) ? cachedPlaylist.items.find(item => item && item.id === normPlayId) : null;
        if (sharedSong) {
          const metaHtml = buildShareHeadHtml(url.href, sharedSong.name, siteTitle);
          html = html.replace("<title>Cloud Music Hub</title>", () => metaHtml);
        }
      } catch (e) {}
    }
    return new Response(html, { headers: pageHeaders });
  }
};

