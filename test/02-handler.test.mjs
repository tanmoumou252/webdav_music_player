import { test } from "node:test";
import assert from "node:assert/strict";
import { scenarios, runOne } from "./helper/scenarios.mjs";
import { comparable } from "./helper/harness.mjs";
import worker from "../build/out/worker.check.mjs";

// Tier-2 全路由特征化测试：golden 钉死现状行为。
// import 目标为构建产物 build/out/worker.check.mjs，仍绿即证明切片与拼接零行为回归。
export const GOLDEN = {
 "options": {
  "status": 204,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges"
  },
  "body": "",
  "stubCalls": [],
  "post": {}
 },
 "nokv": {
  "status": 500,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "text/plain; charset=utf-8"
  },
  "body": "请在 Worker 设置中绑定变量名为 MUSIC_KV 的 KV 命名空间！",
  "stubCalls": [],
  "post": {}
 },
 "jsmediatags-ok": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "cache-control": "public, max-age=604800",
   "content-type": "application/javascript; charset=utf-8"
  },
  "body": "/* jsmediatags 3.9.5 fake payload */",
  "stubCalls": [
   {
    "url": "https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js",
    "method": "GET",
    "headers": {}
   }
  ],
  "post": {}
 },
 "jsmediatags-down": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/javascript"
  },
  "body": "// jsmediatags unavailable",
  "stubCalls": [
   {
    "url": "https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js",
    "method": "GET",
    "headers": {}
   }
  ],
  "post": {}
 },
 "status-uninit": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json"
  },
  "body": "{\"isInitialized\":false,\"isAdmin\":false,\"title\":\"我的多源音乐库\",\"sources\":[]}",
  "stubCalls": [],
  "post": {}
 },
 "status-init-guest": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json"
  },
  "body": "{\"isInitialized\":false,\"isAdmin\":false,\"title\":\"我的多源音乐库\",\"sources\":[{\"id\":\"a\",\"name\":\"源A\"}]}",
  "stubCalls": [],
  "post": {}
 },
 "status-admin-cookie": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json"
  },
  "body": "{\"isInitialized\":true,\"isAdmin\":true,\"title\":\"我的多源音乐库\",\"sources\":[{\"id\":\"a\",\"name\":\"源A\"}]}",
  "stubCalls": [],
  "post": {}
 },
 "init-first": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json",
   "set-cookie": "admin_token=<TOKEN>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
   "set-cookie[]": [
    "admin_token=<TOKEN>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000"
   ]
  },
  "body": "{\"success\":true}",
  "stubCalls": [],
  "post": {
   "adminPassCount1": true,
   "siteTitle": "我的站"
  }
 },
 "init-twice": {
  "status": 400,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "text/plain;charset=UTF-8"
  },
  "body": "{\"error\":\"已初始化\"}",
  "stubCalls": [],
  "post": {}
 },
 "init-short-pass": {
  "status": 400,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "text/plain;charset=UTF-8"
  },
  "body": "{\"error\":\"密码长度至少 8 位\"}",
  "stubCalls": [],
  "post": {}
 },
 "init-no-pass": {
  "status": 400,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "text/plain;charset=UTF-8"
  },
  "body": "{\"error\":\"密码必填\"}",
  "stubCalls": [],
  "post": {}
 },
 "login-ok": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json",
   "set-cookie": "admin_token=<TOKEN>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
   "set-cookie[]": [
    "admin_token=<TOKEN>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000"
   ]
  },
  "body": "{\"success\":true}",
  "stubCalls": [],
  "post": {
   "rl": null,
   "sessionCount": 2
  }
 },
 "login-bad": {
  "status": 403,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "text/plain;charset=UTF-8"
  },
  "body": "{\"error\":\"密码错误\"}",
  "stubCalls": [],
  "post": {
   "rl": "1"
  }
 },
 "login-lockout": {
  "status": 429,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "text/plain;charset=UTF-8",
   "retry-after": "600"
  },
  "body": "{\"error\":\"尝试过于频繁，请 10 分钟后再试\"}",
  "stubCalls": [],
  "post": {}
 },
 "login-plaintext-upgrade": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json",
   "set-cookie": "admin_token=<TOKEN>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
   "set-cookie[]": [
    "admin_token=<TOKEN>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000"
   ]
  },
  "body": "{\"success\":true}",
  "stubCalls": [],
  "post": {
   "upgradedHashLen": 64,
   "upgradedIsHex64": true
  }
 },
 "sources-get-guest": {
  "status": 403,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "text/plain;charset=UTF-8"
  },
  "body": "{\"error\":\"未授权\"}",
  "stubCalls": [],
  "post": {}
 },
 "sources-get-admin": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json"
  },
  "body": "[{\"id\":\"a\",\"name\":\"源A\",\"url\":\"https://dav.example.com/dav/\",\"user\":\"u1\",\"pass\":\"p1\"},{\"id\":\"b\",\"name\":\"源B\",\"url\":\"https://dav.example.net/dav\",\"user\":\"u2\",\"pass\":\"päss\"}]",
  "stubCalls": [],
  "post": {}
 },
 "sources-post-invalid-url": {
  "status": 400,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "text/plain;charset=UTF-8"
  },
  "body": "{\"error\":\"源配置无效：url 必须为 http/https 且格式合法\"}",
  "stubCalls": [],
  "post": {}
 },
 "sources-post-valid": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json"
  },
  "body": "{\"success\":true}",
  "stubCalls": [],
  "post": {
   "cacheKeys": 0,
   "sourcesLen": 2,
   "siteTitle": "新标题"
  }
 },
 "sources-post-newpass": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json",
   "set-cookie": "admin_token=<TOKEN>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
   "set-cookie[]": [
    "admin_token=<TOKEN>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000"
   ]
  },
  "body": "{\"success\":true}",
  "stubCalls": [],
  "post": {
   "sessionCount": 1,
   "passIsNewHex": true,
   "passIsOld": false,
   "cacheKeys": 0
  }
 },
 "sources-post-newpass-short": {
  "status": 400,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "text/plain;charset=UTF-8"
  },
  "body": "{\"error\":\"新密码长度至少 8 位\"}",
  "stubCalls": [],
  "post": {}
 },
 "logout": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json",
   "set-cookie": "admin_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
   "set-cookie[]": [
    "admin_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
   ]
  },
  "body": "{\"success\":true}",
  "stubCalls": [],
  "post": {
   "sessionCount": 0
  }
 },
 "list-empty": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json"
  },
  "body": "{\"items\":[],\"debugs\":[]}",
  "stubCalls": [],
  "post": {}
 },
 "list-single-admin": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"items\":[{\"name\":\"Alpha - One.mp3\",\"href\":\"/dav/Alpha%20-%20One.mp3\",\"id\":\"93f8adb4\",\"availableNodes\":[{\"sourceId\":\"a\",\"href\":\"/dav/Alpha%20-%20One.mp3\"}]},{\"name\":\"Beta & Band - Two.flac\",\"href\":\"/dav/Beta%20&%20Band%20-%20Two.flac\",\"id\":\"d0bc3107\",\"availableNodes\":[{\"sourceId\":\"a\",\"href\":\"/dav/Beta%20&%20Band%20-%20Two.flac\"}]}],\"debugs\":[{\"sourceId\":\"a\",\"sourceName\":\"源A\",\"targetUrl\":\"https://dav.example.com/dav/\",\"status\":207,\"statusText\":\"Multi-Status\",\"contentType\":\"application/xml\",\"allHrefs\":[\"/dav/\",\"/dav/Alpha%20-%20One.mp3\",\"/dav/Beta%20&amp;%20Band%20-%20Two.flac\"],\"allHrefsCount\":3,\"rawPreview\":\"<?xml version=\\\"1.0\\\" encoding=\\\"utf-8\\\"?>\\n<d:multistatus xmlns:d=\\\"DAV:\\\">\\n<d:response>\\n<d:href>/dav/</d:href>\\n<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:displayname>Music</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>\\n</d:response>\\n<d:response>\\n<d:h\",\"rawLength\":747}],\"diagnostics\":null,\"fromCache\":false,\"isAdmin\":true}",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/",
    "method": "PROPFIND",
    "headers": {
     "authorization": "Basic dTE6cDE=",
     "depth": "1"
    }
   }
  ],
  "post": {
   "cached": true
  }
 },
 "list-single-guest": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"items\":[{\"name\":\"Alpha - One.mp3\",\"href\":\"/dav/Alpha%20-%20One.mp3\",\"id\":\"93f8adb4\",\"availableNodes\":[{\"sourceId\":\"a\",\"href\":\"/dav/Alpha%20-%20One.mp3\"}]},{\"name\":\"Beta & Band - Two.flac\",\"href\":\"/dav/Beta%20&%20Band%20-%20Two.flac\",\"id\":\"d0bc3107\",\"availableNodes\":[{\"sourceId\":\"a\",\"href\":\"/dav/Beta%20&%20Band%20-%20Two.flac\"}]}],\"debugs\":[],\"diagnostics\":null,\"fromCache\":false,\"isAdmin\":false}",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/",
    "method": "PROPFIND",
    "headers": {
     "authorization": "Basic dTE6cDE=",
     "depth": "1"
    }
   }
  ],
  "post": {
   "cached": true
  }
 },
 "list-all-merge": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"items\":[{\"name\":\"Alpha - One.mp3\",\"href\":\"/dav/Alpha%20-%20One.mp3\",\"id\":\"93f8adb4\",\"availableNodes\":[{\"sourceId\":\"a\",\"href\":\"/dav/Alpha%20-%20One.mp3\"},{\"sourceId\":\"b\",\"href\":\"/dwb/Alpha - One.mp3\"}]},{\"name\":\"Beta & Band - Two.flac\",\"href\":\"/dav/Beta%20&%20Band%20-%20Two.flac\",\"id\":\"d0bc3107\",\"availableNodes\":[{\"sourceId\":\"a\",\"href\":\"/dav/Beta%20&%20Band%20-%20Two.flac\"}]},{\"name\":\"Gamma <live>.m4a\",\"href\":\"/dwb/Gamma%20<live>.m4a\",\"id\":\"17e2b518\",\"availableNodes\":[{\"sourceId\":\"b\",\"href\":\"/dwb/Gamma%20<live>.m4a\"}]}],\"debugs\":[{\"sourceId\":\"a\",\"sourceName\":\"源A\",\"targetUrl\":\"https://dav.example.com/dav/\",\"status\":207,\"statusText\":\"Multi-Status\",\"contentType\":\"application/xml\",\"allHrefs\":[\"/dav/\",\"/dav/Alpha%20-%20One.mp3\",\"/dav/Beta%20&amp;%20Band%20-%20Two.flac\"],\"allHrefsCount\":3,\"rawPreview\":\"<?xml version=\\\"1.0\\\" encoding=\\\"utf-8\\\"?>\\n<d:multistatus xmlns:d=\\\"DAV:\\\">\\n<d:response>\\n<d:href>/dav/</d:href>\\n<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:displayname>Music</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>\\n</d:response>\\n<d:response>\\n<d:h\",\"rawLength\":747},{\"sourceId\":\"b\",\"sourceName\":\"源B\",\"targetUrl\":\"https://dav.example.net/dav/\",\"status\":207,\"statusText\":\"Multi-Status\",\"contentType\":\"application/xml\",\"allHrefs\":[\"/dwb/\",\"/dwb/Alpha - One.mp3\",\"/dwb/Gamma%20&lt;live&gt;.m4a\",\"/dwb/readme.txt\"],\"allHrefsCount\":4,\"rawPreview\":\"<?xml version=\\\"1.0\\\" encoding=\\\"utf-8\\\"?>\\n<D:multistatus xmlns:D=\\\"DAV:\\\">\\n<D:response>\\n<D:href>/dwb/</D:href>\\n<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>\\n</D:response>\\n<D:response>\\n<D:href>/dwb/Alpha - One.mp3</D:href>\\n<D\",\"rawLength\":849}],\"diagnostics\":null,\"fromCache\":false,\"isAdmin\":true}",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/",
    "method": "PROPFIND",
    "headers": {
     "authorization": "Basic dTE6cDE=",
     "depth": "1"
    }
   },
   {
    "url": "https://dav.example.net/dav/",
    "method": "PROPFIND",
    "headers": {
     "authorization": "Basic dTI6cMOkc3M=",
     "depth": "1"
    }
   }
  ],
  "post": {
   "cachedAll": true
  }
 },
 "list-cache-hit-guest": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"items\":[{\"id\":\"a1b2c3d4\",\"name\":\"Alpha - One.mp3\",\"href\":\"/da/Alpha%20-%20One.mp3\",\"availableNodes\":[{\"sourceId\":\"a\",\"href\":\"/da/x.mp3\"}]}],\"debugs\":[],\"diagnostics\":null,\"fromCache\":true,\"isAdmin\":false,\"notice\":\"部分源暂不可用（详情仅管理员可见）\"}",
  "stubCalls": [],
  "post": {}
 },
 "list-cache-hit-admin": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"items\":[{\"id\":\"a1b2c3d4\",\"name\":\"Beta & Band - Two.flac\",\"href\":\"/da/b.flac\",\"availableNodes\":[{\"sourceId\":\"b\",\"href\":\"/da/b.flac\"}]}],\"debugs\":[\"dbg1\"],\"diagnostics\":[{\"title\":\"x\",\"timestamp\":\"<TS>\"}],\"fromCache\":true,\"isAdmin\":true}",
  "stubCalls": [],
  "post": {}
 },
 "list-refresh-cooldown": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"items\":[{\"id\":\"a1b2c3d4\",\"name\":\"Z - Z.mp3\",\"href\":\"/z.mp3\"}],\"debugs\":[],\"diagnostics\":null,\"fromCache\":true,\"isAdmin\":true,\"notice\":\"刚刚已完成同步，网盘处于冷却期（请30秒后再试）\"}",
  "stubCalls": [],
  "post": {}
 },
 "list-no-source-admin": {
  "status": 404,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json"
  },
  "body": "{\"error\":\"指定的源不存在\",\"diagnostic\":{\"title\":\"配置源丢失\",\"cause\":\"ID zzz 未找到\",\"solution\":\"请在设置中检查源配置。\"},\"items\":[]}",
  "stubCalls": [],
  "post": {}
 },
 "list-waf-admin": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"items\":[],\"debugs\":[{\"sourceId\":\"e\",\"sourceName\":\"坏源\",\"targetUrl\":\"https://err.example.com/dav/\",\"status\":403,\"statusText\":\"Forbidden\",\"contentType\":\"text/plain\",\"allHrefs\":[],\"allHrefsCount\":0,\"rawPreview\":\"Access for this IP has been blocked by the security system\",\"rawLength\":58}],\"diagnostics\":[{\"sourceName\":\"坏源\",\"status\":403,\"statusText\":\"Forbidden\",\"method\":\"PROPFIND\",\"targetUrl\":\"https://err.example.com/dav/\",\"contentType\":\"text/plain\",\"bodyPreview\":\"Access for this IP has been blocked by the security system\",\"title\":\"源【坏源】触发了网盘服务端的临时 IP 频控拦截 (403 WAF)\",\"cause\":\"网盘服务端（如 Koofr 安全策略）侦测到来自当前 Cloudflare 机房节点的短时请求较多，触发了防刷机制。\",\"solution\":\"请勿连续频繁刷新。正常使用时系统已开启 KV 集中缓存保护网盘，通常等待 1~2 分钟即可自动解封恢复。\",\"timestamp\":\"<TS>\"}],\"fromCache\":false,\"isAdmin\":true}",
  "stubCalls": [
   {
    "url": "https://err.example.com/dav/",
    "method": "PROPFIND",
    "headers": {
     "depth": "1"
    }
   }
  ],
  "post": {}
 },
 "list-html-page": {
  "status": 200,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"items\":[],\"debugs\":[{\"sourceId\":\"a\",\"sourceName\":\"源A\",\"targetUrl\":\"https://dav.example.com/dav/\",\"status\":200,\"statusText\":\"OK\",\"contentType\":\"text/html; charset=utf-8\",\"allHrefs\":[],\"allHrefsCount\":0,\"rawPreview\":\"<!DOCTYPE html>\\n<html><head><title>Login</title></head><body>Please sign in</body></html>\",\"rawLength\":89}],\"diagnostics\":[{\"sourceName\":\"源A\",\"status\":200,\"statusText\":\"OK\",\"method\":\"PROPFIND\",\"targetUrl\":\"https://dav.example.com/dav/\",\"contentType\":\"text/html; charset=utf-8\",\"bodyPreview\":\"<!DOCTYPE html>\\n<html><head><title>Login</title></head><body>Please sign in</body></html>\",\"title\":\"源【源A】端点返回了网页而非 WebDAV\",\"cause\":\"请求返回了 HTTP 200，但响应内容是普通 HTML 网页，并非 WebDAV 数据。\",\"solution\":\"请确认 WebDAV 地址是否正确，不能填管理面板前端网页网址。\",\"timestamp\":\"<TS>\"}],\"fromCache\":false,\"isAdmin\":true}",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/",
    "method": "PROPFIND",
    "headers": {
     "authorization": "Basic dTE6cDE=",
     "depth": "1"
    }
   }
  ],
  "post": {}
 },
 "list-crash-admin": {
  "status": 500,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json"
  },
  "body": "{\"error\":\"broken response body\",\"diagnostic\":{\"title\":\"Worker 执行异常\",\"cause\":\"<STACK>\",\"solution\":\"请检查后台配置。\"},\"items\":[]}",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/",
    "method": "PROPFIND",
    "headers": {
     "authorization": "Basic dTE6cDE=",
     "depth": "1"
    }
   }
  ],
  "post": {}
 },
 "list-crash-guest": {
  "status": 500,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json"
  },
  "body": "{\"error\":\"服务繁忙，请稍后再试\",\"items\":[]}",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/",
    "method": "PROPFIND",
    "headers": {
     "authorization": "Basic dTE6cDE=",
     "depth": "1"
    }
   }
  ],
  "post": {}
 },
 "stream-missing-params": {
  "status": 400,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json"
  },
  "body": "{\"error\":\"缺少源或路径参数\"}",
  "stubCalls": [],
  "post": {}
 },
 "stream-absolute-url-guest": {
  "status": 403,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"error\":\"访问被拒绝\",\"diagnostic\":null}",
  "stubCalls": [],
  "post": {}
 },
 "stream-path-escape-admin": {
  "status": 403,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"error\":\"访问被拒绝：路径校验未通过\",\"diagnostic\":{\"sourceName\":\"源A\",\"status\":403,\"statusText\":\"Path validation rejected\",\"method\":\"GET\",\"targetUrl\":\"https://dav.example.com/dav/../secret.mp3\",\"contentType\":\"\",\"bodyPreview\":\"\",\"title\":\"访问被拒绝：路径校验未通过\",\"cause\":\"file 参数必须是所配置源目录内的相对路径；绝对 URL 与目录逃逸一律拒绝。\",\"solution\":\"请从正常歌曲列表播放；手动构造链接时使用列表返回的相对 href。\",\"timestamp\":\"<TS>\"}}",
  "stubCalls": [],
  "post": {}
 },
 "stream-not-audio": {
  "status": 403,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"error\":\"访问被拒绝\",\"diagnostic\":null}",
  "stubCalls": [],
  "post": {}
 },
 "stream-ok": {
  "status": 206,
  "statusText": "Partial Content",
  "headers": {
   "accept-ranges": "bytes",
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-length": "100",
   "content-range": "bytes 0-99/100",
   "content-type": "audio/mpeg"
  },
  "body": "AUDIODATA",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/Alpha%20-%20One.mp3",
    "method": "GET",
    "headers": {
     "authorization": "Basic dTE6cDE=",
     "range": "bytes=0-99"
    }
   }
  ],
  "post": {}
 },
 "stream-ok-norange": {
  "status": 200,
  "statusText": "OK",
  "headers": {
   "accept-ranges": "bytes",
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-length": "9",
   "content-type": "audio/mpeg"
  },
  "body": "AUDIODATA",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/Alpha%20-%20One.mp3",
    "method": "GET",
    "headers": {
     "authorization": "Basic dTE6cDE="
    }
   }
  ],
  "post": {}
 },
 "stream-upstream-err-admin": {
  "status": 404,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"error\":\"源【源A】目标不存在 (404 Not Found)\",\"diagnostic\":{\"sourceName\":\"源A\",\"status\":404,\"statusText\":\"Not Found\",\"method\":\"GET\",\"targetUrl\":\"https://dav.example.com/dav/Alpha%20-%20One.mp3\",\"contentType\":\"\",\"bodyPreview\":\"Not Found\",\"title\":\"源【源A】目标不存在 (404 Not Found)\",\"cause\":\"请求的路径在 WebDAV 服务器上未找到。目标 URL: https://dav.example.com/dav/Alpha%20-%20One.mp3\",\"solution\":\"请检查 URL 路径大小写（Linux 严格区分大小写）或子路径是否有误。\",\"timestamp\":\"<TS>\"}}",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/Alpha%20-%20One.mp3",
    "method": "GET",
    "headers": {
     "authorization": "Basic dTE6cDE="
    }
   }
  ],
  "post": {}
 },
 "stream-upstream-err-guest": {
  "status": 404,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"error\":\"源站响应异常\",\"diagnostic\":null}",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/Alpha%20-%20One.mp3",
    "method": "GET",
    "headers": {
     "authorization": "Basic dTE6cDE="
    }
   }
  ],
  "post": {}
 },
 "stream-network-admin": {
  "status": 502,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"error\":\"源【源A】连接失败 (无法连通)\",\"diagnostic\":{\"sourceName\":\"源A\",\"status\":0,\"statusText\":\"connection refused\",\"method\":\"GET\",\"targetUrl\":\"https://dav.example.com/dav/Alpha%20-%20One.mp3\",\"contentType\":\"\",\"bodyPreview\":\"\",\"title\":\"源【源A】连接失败 (无法连通)\",\"cause\":\"Cloudflare 机房无法连通目标主机: connection refused。\",\"solution\":\"1. 请确认非 127.0.0.1 纯内网地址；2. 检查 DDNS 或端口映射。\",\"timestamp\":\"<TS>\"}}",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/Alpha%20-%20One.mp3",
    "method": "GET",
    "headers": {
     "authorization": "Basic dTE6cDE="
    }
   }
  ],
  "post": {}
 },
 "stream-network-guest": {
  "status": 502,
  "statusText": "",
  "headers": {
   "access-control-allow-headers": "*",
   "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
   "access-control-allow-origin": "*",
   "access-control-expose-headers": "Content-Range, Content-Length, Accept-Ranges",
   "content-type": "application/json; charset=utf-8"
  },
  "body": "{\"error\":\"无法连通源站\",\"diagnostic\":null}",
  "stubCalls": [
   {
    "url": "https://dav.example.com/dav/Alpha%20-%20One.mp3",
    "method": "GET",
    "headers": {
     "authorization": "Basic dTE6cDE="
    }
   }
  ],
  "post": {}
 },
 "html-root": {
  "status": 200,
  "statusText": "",
  "headers": {
   "cache-control": "no-store",
   "content-security-policy": "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src-elem * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * https: http: data: blob:; media-src * data: blob: https: http:; img-src * data: blob: https: http:; style-src * 'unsafe-inline'; font-src * data: blob:;",
   "content-type": "text/html; charset=utf-8"
  },
  "body": {
   "htmlLen": 96415,
   "sha256": "7d323f5a84861bd185c6a43123ffd590b0de11047e112350180b1d68ca518f7c"
  },
  "stubCalls": [],
  "post": {}
 },
 "play-hit": {
  "status": 200,
  "statusText": "",
  "headers": {
   "cache-control": "no-store",
   "content-security-policy": "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src-elem * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * https: http: data: blob:; media-src * data: blob: https: http:; img-src * data: blob: https: http:; style-src * 'unsafe-inline'; font-src * data: blob:;",
   "content-type": "text/html; charset=utf-8"
  },
  "body": {
   "htmlLen": 96925,
   "sha256": "7b7919297d63209b1d4398c3e7e9981557471be5c8da8d44f132cf208cf6401f"
  },
  "stubCalls": [],
  "post": {}
 },
 "play-uppercase": {
  "status": 200,
  "statusText": "",
  "headers": {
   "cache-control": "no-store",
   "content-security-policy": "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src-elem * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * https: http: data: blob:; media-src * data: blob: https: http:; img-src * data: blob: https: http:; style-src * 'unsafe-inline'; font-src * data: blob:;",
   "content-type": "text/html; charset=utf-8"
  },
  "body": {
   "htmlLen": 96925,
   "sha256": "3b547b0b891b487044d74995fb68913fb9a7824fc2da012bd668123362710a26"
  },
  "stubCalls": [],
  "post": {}
 },
 "play-miss": {
  "status": 200,
  "statusText": "",
  "headers": {
   "cache-control": "no-store",
   "content-security-policy": "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src-elem * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * https: http: data: blob:; media-src * data: blob: https: http:; img-src * data: blob: https: http:; style-src * 'unsafe-inline'; font-src * data: blob:;",
   "content-type": "text/html; charset=utf-8"
  },
  "body": {
   "htmlLen": 96415,
   "sha256": "7d323f5a84861bd185c6a43123ffd590b0de11047e112350180b1d68ca518f7c"
  },
  "stubCalls": [],
  "post": {}
 },
 "play-invalid-id": {
  "status": 200,
  "statusText": "",
  "headers": {
   "cache-control": "no-store",
   "content-security-policy": "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src-elem * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src * https: http: data: blob:; media-src * data: blob: https: http:; img-src * data: blob: https: http:; style-src * 'unsafe-inline'; font-src * data: blob:;",
   "content-type": "text/html; charset=utf-8"
  },
  "body": {
   "htmlLen": 96415,
   "sha256": "7d323f5a84861bd185c6a43123ffd590b0de11047e112350180b1d68ca518f7c"
  },
  "stubCalls": [],
  "post": {}
 }
};


for (const s of scenarios()) {
  test("handler:" + s.name, async () => {
    const rec = await comparable(await runOne(s, worker));
    assert.deepEqual(rec, GOLDEN[s.name], "scenario " + s.name);
  });
}

test("coverage: every scenario has a golden record", () => {
  for (const s of scenarios()) {
    assert.ok(GOLDEN[s.name], "missing golden for " + s.name);
  }
});
