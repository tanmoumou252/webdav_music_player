# EdgeOne Pages 部署说明

本仓库除 `worker.js`（Cloudflare Workers 部署件）外，还携带一套 EdgeOne Pages 可部署产物与一套 Cloudflare Pages 入口，全部由 `node build.mjs` 从同一份 `src/` 切片与 `edgeone/` 适配源件确定性生成。

## 产物说明

- `edge-functions/index.js`（路由 `/`）与 `edge-functions/[[default]].js`（根级多段 catch-all）：EdgeOne Pages 边缘函数产物，两文件字节相同、各自自包含、互不 import。官方文档未明示根级 `[[default]].js` 是否捕获 `/`，故用双文件兜底。
- `functions/[[path]].js` 与 `functions/index.js`：Cloudflare Pages Functions 入口，两文件字节相同；CF Pages 原生支持 Workers 形态的 KV 绑定，无需适配层。

## 部署步骤（EdgeOne）

1. 连接仓库：EdgeOne 控制台「创建项目」选择本 GitHub 仓库，或直接点击 README 中的「使用 EdgeOne Makers 部署」按钮。
2. 构建配置：仓库零依赖，构建命令与安装命令留空即可——提交进仓库的 `edge-functions/` 文件即部署物；输出目录保持默认（仓库根）。
3. KV 存储：控制台「存储 - KV」开通账户并创建命名空间，然后在项目详情「KV 存储」中绑定，**绑定变量名必须为 `MUSIC_KV`**（大小写完全一致）。未绑定时访问站点会返回 500 提示（worker 自带文案）。
4. 部署完成后按 Worker 版同样的流程初始化站点（设置标题与管理员密码、添加 WebDAV 源）。

## 可选环境变量

在「项目设置 - 环境管理」中配置（变量值 ≤1000 字节）：

- `STREAM_FETCH_TIMEOUT_MS`：上游 fetch 超时毫秒数。缺省 8000；`/api/stream` 调用点在未配置时单独回退 12000ms。**不建议设为 >15000**——会破坏"服务端先于客户端 15s 看门狗报错"的次序。
- `STREAM_SEGMENT_CONCURRENCY` / `STREAM_SEGMENT_PART_SIZE` / `STREAM_SEGMENT_MAX_SEGMENTS` / `STREAM_SEGMENT_MERGE_BYTES` / `STREAM_SEGMENT_RETRY_BASE_MS`：分段抓取参数。

## 限制与注意事项（免费版）

- CPU 200ms/次（不含 I/O 等待）；请求 body 1MB；单函数代码包 5MB（当前产物约 200KB，余量充足）。
- KV 单值 1MB（`limits-and-quotas` 口径，从严采信）：曲目列表缓存与分享索引在曲库很大时注意体积；TTL 信封会带来 JSON 转义膨胀与约 30 字节固定开销，使该上限略微前移。
- KV 仅 Edge Functions 可用；最终一致性——边缘节点缓存最长 60s（登录限流计数、会话删除跨节点最长延迟 60s 生效）。
- KV key 仅允许数字/字母/下划线：产物内置 `_xHH_` 双射改写层，业务层无感；`rl_login_<ip>` 等含点号键自动改写存储。
- EO `list` 单页上限 256：改密吊销已按游标翻页直至 `list_complete`，不受单页上限影响；适配器透传 `cursor` 供任何需要续页的调用方使用。
- 超时与看门狗：首段探针（×3 + 指数退避）与分段抓取（×3/段）的计时器共用同一超时值，重试乘数使首字节前最长静默可达 3×超时+750ms——超过客户端 15s 看门狗时，客户端会自动换线路重试，这是既定行为。

## 文档未明示项（以实测为准）

以下能力在官方文档中无明文，产物已内置兜底，若实测不符按实际形态修正：

- `setTimeout` / `clearTimeout` 等定时器可用性（业务逻辑大量依赖）。
- `unescape`（Annex B）可用性（WebDAV Basic 鉴权头构造使用）。
- 平台 fetch 对 `AbortSignal` 的原生尊重程度（产物内置 Promise.race 兜底包装，使超时语义不依赖平台实现）。
- KV 绑定注入形态：适配层按 `context.env.MUSIC_KV` 与 `globalThis.MUSIC_KV` 双取、任一来源都过适配包装。
- 平台客户端 IP 注入形态（文档仅明示 `request.eo` 携带 GEO 信息）：登录限流取 IP 的次序为 Cloudflare 平台标记 `request.cf` 在场时用边缘注入的 `cf-connecting-ip`，其次 `request.eo.clientIp`（存在即用），两者皆无时收敛共享 `unknown` 桶——裸 `x-forwarded-for` 与无平台标记的 `cf-connecting-ip` 视为客户端可伪造，一律不信任。

## Cloudflare Pages 部署

`functions/[[path]].js`（多段 catch-all）与 `functions/index.js`（根路由）随仓库提交即构成 Cloudflare Pages Functions 项目：与 EdgeOne 产物共享同一 `handleRequest` 核心，Pages Functions 运行时与 Workers 同为 workerd，无需适配层。KV 在 Pages 项目设置中以 KV 命名空间绑定、变量名 `MUSIC_KV`（生产与预览环境各配一份）。

注意 **Pages 静态资产优先于 Functions**：若把仓库根直接设为输出目录，`src/`、`worker.js`、`wrangler.toml` 等会作为静态文件被公开访问。推荐配置：

- 构建命令：`mkdir -p pages-out && cp -r functions pages-out/functions`
- 输出目录：`pages-out`

这样输出目录内只有 Functions、零静态资产；`[[path]].js` 与 `index.js` 双文件兜底根路由与深层路径（与 EdgeOne 侧同构）。Pages 部署与仓库既有 Workers CI 部署相互独立，并存不冲突。
