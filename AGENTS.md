# AGENTS.md — webdav_music_player 协作约束

> 修改本文件须维护者明示。

给在本仓库工作的 AI 编码代理与协作者的约定，与 `README.md` 互补。

## 项目形态（先读）

- 单文件 Cloudflare Worker：`worker.js`，前后端全部逻辑都在这个文件里。
  - 顶层 JS：handler 与工具函数，正常 JS 语法。
  - 页面由 `renderHTML()` 返回的一个巨型模板字符串组成，内联全部 HTML/CSS/JS（该区在 `src/07-render.part.js`）。模板区起点锚点为 `function renderHTML`，终点为 ``</html>`;`` 闭合行；**一律按锚点文本定位，不要用行号**（行号会随改动漂移）。
- 源码按可回归测试的切片组织：`src/01..07.part.js` 是 `worker.js` 的连续字节切片，`node build.mjs` 按文件名顺序拼回 `worker.js`，并与 `git show HEAD:worker.js` 做**逐字节相等棘轮**——不一致即 exit 1 且不写产物。`golden/worker.head.mjs` 是 `worker.js` 的冻结基线副本。
- 有测试套件、无包管理器：`test/` 用 Node 内建 `node:test` + `node:assert`，零依赖、无 `package.json`。机器门 = `node build.mjs` → `node --test "test/*.test.mjs"`（Tier-1 单元 / Tier-2 集成 / Tier-3 快照 / Tier-4 对拍）；`node --check` 用于单文件语法门。
- 运行时版本锁：`runtime-lock.mjs` 只锁 Node **主版本**，当前运行时 major 与 `.node-version` 的 baseline major 一致即放行（同主版本内任意 minor/patch 均可），跨主版本抛错并按其 procedure 更新锁文件与 golden。不得篡改比较逻辑绕过；`.nvmrc` 保留精确 baseline 供 `nvm use` 对齐。
- 部署方式见 README。本地运行时（`wrangler dev`）是维护者自建环境，代理不得代为运行。

## 验证方法论（代理必须遵守）

**教训：失败路径/异常加固类改动，通常没有任何人工可复现的验证手段。** 例如"KV 故障兜底""错误响应脱敏"只在依赖服务故障时触发，正常使用与故意构造的输入都不会走到那条路。把这类验证派给人工，等于让人测根本无法复现的东西。

因此：

1. **失败路径/加固类改动 → 以机器门 + 读码为准**：`node build.mjs`（字节相等棘轮）、`node --test "test/*.test.mjs"`（四层回归门）、`node --check`、针对性 grep 断言（数量/位置/可达性）、改动前后语义逐处读码核对。交付说明中标注"无手工验证通道，以机器门 + 读码为准"，不派人工测试项。
2. **只有肉眼可见差异的行为改动 → 才写进人工验证清单**：给出具体操作与预期差异（例：浏览器地址栏打开某 URL，对照返回体文本；管理员登录态与无痕窗口各开一次看差异）。
3. 交付报告里两类不得混排；不得用"请按表逐项执行"把不可执行的条目推给维护者。

## 硬性禁令（违反即任务失败）

1. **下载默认禁止**：不下载任何 npm/tgz/zip/图标包/字体包/仓库克隆；不运行任何含 `fetch` 的脚本。
2. **授权通道（唯一出口）**：确需外部数据核验时，先停下向维护者申请，写明"取什么、从哪个官方源、多大"。获批后仅限：最小官方数据集 → 用完即删并留清单 → 绝不进入工作区。
3. **禁止包管理器与 wrangler**：npm/pnpm/yarn/npx/wrangler 一律不执行。`node` 不在禁止之列且必须实际执行——`node build.mjs`、`node --test "test/*.test.mjs"`、`node --check` 是本项目唯一的机器门，只写不跑等于没验证。第 1 条"不运行任何含 `fetch` 的脚本"指代理自行新写的取数/下载脚本；`test/` 里的 `fetch` 已由 `test/helper/harness.mjs` 替换为桩实现、运行后还原，跑回归测试不联网，不落入第 1 条。
4. **禁止 Git 写操作**：不 commit/push/branch/checkout/stash；只读 git 子命令可用。
5. **用户自建验证环境不可触碰**：`wrangler.toml`、`.wrangler/` 原样保留。
6. **代码编辑纪律（改动落 `src/*.part.js`，不手改 `worker.js` 产物）**：
   - 全文件零注释（jsmediatags 的 `"// jsmediatags unavailable"` 是响应体字符串、不是注释，不得删）；
   - 模板字符串区域内不得出现裸反引号与裸 `${`；正则反斜杠需双写（如 `\\d`）；嵌套模板一律用带反斜杠转义的反引号与 `\${`（参照 `createSourceCard` 既有写法）；
   - 三内核兼容（Chrome/Firefox/WebKit）：新 CSS 前缀行置于无前缀行之前、值逐字一致；
   - LF 换行、不重排无关代码、改动用锚点文本定位；
   - 每次修改后依次实跑 `node build.mjs` 与 `node --test "test/*.test.mjs"`，两者全绿才算完成；需要单文件语法门时用 `node --check build/out/worker.check.mjs`。
7. **本机杂物不清理、不移动、不提交**：`.kilo/`、`.zcode/`、`build/`、`*.bat` 已被 git 忽略、只存在于维护者本机（`.kilo/plans/` 为本机工作记录），不得删除/归档/改名，也不得写进 README 等对外文档。（`wrangler.toml`、`.wrangler/` 见第 5 条。）

## 风格与图标的事实源

- **唯一事实源 = `src/*.part.js`**（`worker.js` 是它的构建产物、两者字节一致；UI 与模板区在 `src/07-render.part.js`）：
  - 图标：全部为内联 `<symbol id="icon-*">`（统一 `viewBox 0 0 24 24`）+ favicon（`<link rel="icon"` data:URI）。逐字比对用 node 脚本提取 `<path d>`；sprite 类单行大文件禁用行式 grep。
  - 控件/按钮/配色：`<style>` 内 `:root` 变量块（`--bg`/`--panel`/`--card`/`--accent`/`--accent-hover`/`--sub`/`--danger`/`--border` 等）与 `.btn`/`.btn-green`/`.modal`/`.modal-box`/`.input-row`/`.source-card` 等类。
- **官方出处（仅授权通道下核验，默认不联网）**：Google Material 图标 legacy 与现行 Material Symbols（Apache 2.0）、GitHub 徽标 Octicons mark-github（MIT）、组件/样式规范 m3.material.io。
- 运行时 UI 验证归维护者，且按上文"验证方法论"第 2 条：只列肉眼可判的条目。