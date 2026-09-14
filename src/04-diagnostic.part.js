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

