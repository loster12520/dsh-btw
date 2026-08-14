# dsh-btw

> ⚠️ **仍在开发中（WIP）**
>
> 本项目处于**活跃开发阶段**，尚未发布稳定版本（v0.1.0 以下）。API、命令行为、RPC 契约与
> 面板 UI 均可能随时变化；可能存在未修复的缺陷或未验证的边界情况。**请勿用于生产环境**，
> 升级前请阅读提交记录与 README 变更。欢迎提交 Issue 与 Pull Request 参与共建。

![开发状态](https://img.shields.io/badge/开发状态-仍在开发中-orange)
![版本](https://img.shields.io/badge/版本-v0.1.0--wip-blue)
![License](https://img.shields.io/badge/license-MIT-green)

DSH 旁路问答插件：`/btw <问题>` 命令 + 左侧面板。在**独立会话分支**中回答你的问题——分支可以查看主对话历史（创建时 seed + 每次提问注入增量），但**只有只读 + web 搜索权限**（write/edit/bash/pwsh/ssh_* 等写类工具全部下掉），问答内容**不进入主对话上下文**。对齐 Claude Code `/btw` 的旁路问答语义，并扩展了多轮对话、主对话增量同步、一键清空与可开关的左侧面板。

## 功能

- **`/btw <问题>` 命令**：输入框直接旁路提问，命令系统消化（log-only 记录），不触发主模型；答案进入左侧 BTW 面板。
- **左侧面板**：会话标题栏的 `BTW` 按钮开关。多轮对话、问题/答案气泡、`Ctrl+Shift+K` 或「清空」按钮一键重置分支。
- **只读分支**：分支通过 `agents.create` 创建为「裸 agent」，**不注册进 subagent registry**（GUI 不显示为子代理，不出现在子代理目录）；工具白名单 `read / glob / grep / read_image / web_search`，其余全局工具（写文件、执行命令、SSH 等）全部不可见。
- **查看主对话历史**：分支创建时以主对话已完成 turn 为 seed；每次提问注入主对话增量（自上次同步水位之后的新消息），所以主对话的进展会持续同步到分支。
- **复用单分支**：所有提问（命令路径与面板路径）重定向到同一个分支，除非清空或插件重启。
- **统一问答历史**：Host 维护 `{id, role, text}` 历史，面板轮询 `btw/state` 增量同步——命令路径的问答也会出现在面板，主对话命令卡片只显示一行提示。
- **不污染主上下文**：分支是独立 Session，主对话的 LLM 上下文不含任何 btw 问答。

## 目录结构

```text
dsh-btw/
├── package.json           # 包声明（含 dsh.client 预留）
├── src/
│   ├── host.js            # Host 半区：命令、分支创建/复用、历史、RPC
│   └── client.js          # Client 半区：头部开关按钮 + 左侧面板 + 轮询同步
├── scripts/
│   └── to-dynamic.mjs     # 装配脚本：ESM 源码 → 动态插件 code.host/code.client
├── dist/                  # 装配产物（运行 node scripts/to-dynamic.mjs 生成）
├── cordis.yml             # 静态挂载示例（agent preset 插件行）
├── README.md
└── LICENSE
```

## 安装与使用

### 方式一：动态插件（当前推荐，已在 DSH 会话内验证）

1. 生成装配产物：

   ```bash
   node scripts/to-dynamic.mjs
   ```

2. 在 DSH 会话中用 `cordis_define` 定义插件：
   - `code.host` ← `dist/dynamic-host.js` 的内容
   - `code.client` ← `dist/dynamic-client.js` 的内容
   - 插件名 `btw`（idPrefix 语义），然后 `cordis_run` 激活（Client 半区需在 UI 批准）。

3. 使用：
   - 点会话标题栏 `BTW` 按钮打开左侧面板，输入问题回车；
   - 或主输入框直接输入 `/btw <问题>`；
   - `Ctrl+Shift+K` / 面板「清空」按钮重置分支。

### 方式二：静态挂载（agent preset 插件行）

本仓库保留了标准 DSH 插件包外形（`dsh.client` 声明、`exports["./client"]`）。将本仓库安装为本地包（如 `npm install file:../dsh-btw` 或放入 Loader 可解析的路径），并在 agent preset 的 `cordis.yml` 中挂载：

```yaml
# agent.cordis.yml（示例，Host 半区为普通插件行，Client 半区走 dsh.client 扫描）
- id: dsh-btw
  name: dsh-btw
```

> 注意：静态方式需要 client 半区经 client-modules 构建管线打包（`dsh.client` 扫描 + bundle route）。当前源码为纯 JS（无 TS/JSX），与动态方式同源；如静态挂载遇到 bundle 构建问题，请回退到方式一。

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
| 答案以紧凑形式展示 | 左侧面板气泡展示，可关闭 |
| 主对话零 token 消耗 | 分支问答完全独立于主会话 LLM 上下文 |
| —（扩展）多轮对话 | followup 复用同一分支 |
| —（扩展）主对话更新同步 | 每次提问注入主对话增量 |
| —（扩展）清空记录 | `Ctrl+Shift+K` / 清空按钮重建分支 |

## 开发

```bash
node --check src/host.js    # 语法检查
node --check src/client.js
node scripts/to-dynamic.mjs # 重新生成动态装配产物
```

## License

MIT
