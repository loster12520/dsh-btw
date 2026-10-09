# dsh-btw

> **更好的推荐**：[ChenRuoT/dsh-sidebar-qa](https://github.com/ChenRuoT/dsh-sidebar-qa)
> 本项目不再维护，上述项目已经能完全实现本项目的功能且使用起来更方便

> ⚠️ **仍在开发中（WIP）**
>
> 本项目处于**活跃开发阶段**，尚未发布稳定版本（v0.1.0 以下）。API、命令行为、RPC 契约与
> 面板 UI 均可能随时变化；可能存在未修复的缺陷或未验证的边界情况。**请勿用于生产环境**，
> 升级前请阅读提交记录与 README 变更。欢迎提交 Issue 与 Pull Request 参与共建。

![开发状态](https://img.shields.io/badge/开发状态-仍在开发中-orange)
![版本](https://img.shields.io/badge/版本-v0.1.0--wip-blue)
![License](https://img.shields.io/badge/license-MIT-green)

DSH 旁路问答插件：`/btw <问题>` 命令 + 居中弹窗面板。在**独立会话分支**中回答你的问题——分支可以查看主对话历史（创建时 seed + 每次提问注入增量），但**只有只读 + web 搜索权限**（write/edit/bash/pwsh/ssh_* 等写类工具全部下掉），问答内容**不进入主对话上下文**。对齐 Claude Code `/btw` 的旁路问答语义，并扩展了多轮对话、主对话增量同步、一键清空与每会话独立的居中弹窗面板。

## 功能

- **`/btw <问题>` 命令**：输入框直接旁路提问，命令系统消化（log-only 记录），不触发主模型；自动打开居中 BTW 面板并展示回答。
- **`/btw` 无参命令**：仅打开面板并聚焦输入框，不做其他事、不输出提示。
- **居中弹窗面板**：类似 antd Modal，半透明遮罩覆盖右侧内容区（排除左侧侧边栏）；点击遮罩或 `✕` 关闭；多轮对话、问题/答案气泡、`Ctrl+Shift+K` 或「清空」按钮一键重置当前会话分支。
- **无常驻入口**：不再有会话标题栏 `BTW` 按钮，面板只能通过 `/btw` 命令打开。
- **只读分支**：分支通过 `agents.create` 创建为「裸 agent」，**不注册进 subagent registry**（GUI 不显示为子代理，不出现在子代理目录）；工具白名单 `read / glob / grep / read_image / web_search`，其余全局工具（写文件、执行命令、SSH 等）全部不可见。
- **查看主对话历史**：分支创建时以主对话已完成 turn 为 seed；每次提问注入主对话增量（自上次同步水位之后的新消息），所以主对话的进展会持续同步到分支。
- **每会话独立分支**：每个主会话各自维护独立的 btw 分支、历史、同步水位与串行队列；不同对话的 btw 问答完全隔离、互不污染。
- **统一问答历史**：Host 维护 `{id, role, text}` 历史，面板轮询 `btw/state` 增量同步——命令路径的问答也会出现在面板，主对话命令卡片只显示一行提示。
- **不污染主上下文**：分支是独立 Session，主对话的 LLM 上下文不含任何 btw 问答。

## 安装与使用

### 方式一：`dsh plugin` 一键安装（推荐）

前置：本机已安装 dsh CLI（`dsh plugin` 是 pnpm 的薄转发器，需 pnpm 在 PATH 上）。

在**任意目录**执行（路径用你的本仓库路径，绝对/相对均可）：

```bash
dsh plugin --profile web add <本仓库路径>

# 或从 GitHub 安装
dsh plugin --profile web add git+https://github.com/loster12520/dsh-btw.git
```

然后**重启 `dsh web`**（Host 半区改动需要重启；之后仅 Client 改动浏览器硬刷新即可）。

**打包原理**（对本仓库的配置说明）：

- `dsh plugin --profile web add <路径>` 等价于在 `~/.dsh/profiles/web` 里执行 `pnpm add <路径>`，
  随后按「已安装依赖的 package.json 是否声明 `dsh.bundle.patch`」自动把包加入 profile 的
  bundle 层（`dsh.profile.bundles`），**无需手动改任何配置**。
- 本仓库 `package.json` 的声明：
  - `dsh.bundle.patch: "./cordis.patch.yml"` —— bundle 层，挂载插件行 `{id: dsh-btw, name: dsh-btw}`（等价于在 profile 的 cordis.patch.yml 手写该行）；
  - `dsh.client: { platform: "web" }` + `exports["./client"]`（`dist/client.js`）—— Client 半区由 client-modules 扫描并注入浏览器；
  - `main: src/host.js` —— Host 半区，注册 `/btw` 命令与 `/api/dsh-btw/*` HTTP 路由（带浏览器信任围栏）。
- 手动静态挂载（agent preset 插件行）同理可用：`- id: dsh-btw / name: dsh-btw`，详见 `cordis.yml`。

**使用**：

- 主输入框输入 `/btw <问题>`：问答并自动打开居中面板；
- 主输入框输入 `/btw`：打开面板并聚焦输入框；
- `Ctrl+Shift+K` / 面板「清空」按钮重置当前会话分支。

### 方式二：动态插件（开发/调试用，无需安装）

1. 生成装配产物：

   ```bash
   node scripts/to-dynamic.mjs
   ```

2. 在 DSH 会话中用 `cordis_define` 定义插件：
   - `code.host` ← `dist/dynamic-host.js` 的内容
   - `code.client` ← `dist/dynamic-client.js` 的内容
   - 插件名 `btw`（idPrefix 语义），然后 `cordis_run` 激活（Client 半区需在 UI 批准）。

3. 使用同方式一。

> **两种方式共用同一份 `src/client.js`**：动态路径由宿主沙箱以闭包参数注入
> `React` / `host` / `styles`；静态路径由 `scripts/build-static.mjs` 生成的
> `dist/client.js` 在 factory 闭包内提供等价符号（`require("react")` + fetch 到
> `/api/dsh-btw/*`）。改动 `src/client.js` 后需 `npm run build` 重新生成
> `dist/client.js` 并提交（`dist/` 已 gitignore，仅 `dist/client.js` 例外保留跟踪）。

## 目录结构

```text
dsh-btw/
├── package.json           # 包声明：dsh.bundle.patch + dsh.client + exports["./client"]
├── cordis.patch.yml       # bundle 层：挂载插件行 {id: dsh-btw, name: dsh-btw}
├── src/
│   ├── host.js            # Host 半区：每会话状态、命令、分支创建/复用、历史、/api/dsh-btw 路由
│   └── client.js          # Client 半区：隐形会话同步 + 居中弹窗面板 + 轮询同步
├── scripts/
│   ├── to-dynamic.mjs     # 动态插件装配：ESM 源码 → code.host/code.client
│   ├── build-static.mjs   # 静态 Client bundle 装配：src/client.js → dist/client.js
│   └── verify.mjs         # 校验动态产物与静态 bundle
├── dist/                  # 装配产物（dist/client.js 提交跟踪；dynamic-*.js 本地生成）
├── cordis.yml             # 静态挂载说明（与 cordis.patch.yml 的对应关系）
├── README.md
└── LICENSE
```

## 权限模型

分支的工具集在创建窗口内通过 `childCtx.tools.restrict({ allow: [...] })` 白名单限定，只保留：

| 工具 | 用途 |
| --- | --- |
| `read` | 读文件（只读） |
| `glob` / `grep` | 搜索文件（只读） |
| `read_image` | 读图片（只读） |
| `web_search` | 网络搜索 |

其余全局工具（`write`、`edit`、`pwsh`/`bash`、`ssh_*`、子代理、工作流等）对分支**不可见且拒绝执行**（scoped `tools.restrict` 对 inherited 工具生效）。

## 与 Claude Code `/btw` 的对齐

| Claude Code `/btw` | dsh-btw |
| --- | --- |
| 斜杠命令，不进入主对话上下文 | `/btw` 命令由命令系统消化，log-only 记录，不触发主模型 |
| 全新临时上下文回答 | 独立 Session 分支（创建时 seed 主对话历史 + 增量注入） |
| 答案以紧凑形式展示 | 居中弹窗气泡展示，可关闭 |
| 主对话零 token 消耗 | 分支问答完全独立于主会话 LLM 上下文 |
| —（扩展）多轮对话 | followup 复用同一会话分支 |
| —（扩展）主对话更新同步 | 每次提问注入主对话增量 |
| —（扩展）多会话隔离 | 每个主会话独立分支与历史，互不干扰 |
| —（扩展）清空记录 | `Ctrl+Shift+K` / 清空按钮重建当前会话分支 |

## 开发

```bash
npm run check        # to-dynamic + build + verify 全部执行（改源码后建议跑一遍）
node --check src/host.js
node --check src/client.js
node scripts/to-dynamic.mjs   # 重新生成动态装配产物
node scripts/build-static.mjs # 重新生成静态 Client bundle（dist/client.js，需提交）
```

## License

MIT
