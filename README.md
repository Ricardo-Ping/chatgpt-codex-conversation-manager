# Conversation Manager

> English: [README.en.md](README.en.md)

![CI](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/actions/workflows/ci.yml/badge.svg)

Conversation Manager 是一款面向 ChatGPT 与 Codex 的**本地桌面会话管理器**：统一搜索、筛选、阅读与批量整理云端和本机的历史会话，**无需在应用内重复登录**。

双击会话即可在应用内阅读完整正文——支持 Markdown 表格、18 种语言的代码语法高亮与图片；也可以随时交回官方网页，或在 ChatGPT/Codex 桌面客户端中直接打开继续处理。

## 功能

### 查找与筛选

- 侧边栏统一导航：ChatGPT / Codex 平台切换、未归档 / 已归档 / 已安排状态切换（带数量徽标）、桥接与 App Server 连接状态指示。
- 按标题、状态与时间范围（1 天 / 1 周 / 1 个月 / 半年以前）筛选，分段切换控件带滑动指示动画。
- 键盘流：`/` 聚焦搜索、`↑↓` 移动、`空格` 选中、`Enter` 打开、`Ctrl/Cmd+A` 全选、`Delete` 快捷归档、`Esc` 逐层关闭。

### 阅读

- 双击会话滑出阅读面板：渲染 Markdown 表格、代码高亮与图片；支持复制全文或单个代码块；列表保持可交互，双击其他会话直接切换内容。
- 阅读面板支持上一条 / 下一条切换（`←` / `→`），并可在 ChatGPT 网页或桌面客户端中打开原文。

### 整理与项目

- 多选批量归档、恢复与永久删除；删除使用应用内对话框预览确认，超过 20 条需输入数量。
- 默认保护置顶会话、当前会话与运行中的 Codex 任务。
- 项目管理：ChatGPT「工作」视图与 Codex 任务按项目文件夹分组；右键会话即可加入或移出项目，操作实时同步回 ChatGPT / Codex；Codex 按工作目录分组的会话可移入「非项目任务」并可恢复。
- ChatGPT 区分「聊天」与「项目工作」：项目相关会话默认从聊天列表隐藏，只在项目工作视图管理。

### 缓存与同步

- 本地只保存最小会话索引（含项目归属），启动时立即显示；前台每 2 分钟检查增量，最迟每 6 小时自动完整校准；服务端已删除的旧记录会在完整校准时从本地移除。
- 右上角「完整刷新」可随时立即校准。

### 导出与迁移

- 会话导出为 Markdown：ChatGPT 导出会把正文中的图片下载到导出目录、按会话组织并改写为本地相对路径，离线仍可完整查看；Codex 任务导出包含正文与工作目录信息。
- Codex 会话一键打包导出 / 导入（zip），用于换机迁移；凭据与配置文件刻意不参与导出。
- 设置页提供数据备份 / 恢复（缓存索引与偏好设置），方便迁移到其他设备。

### 外观与更新

- 跟随系统深色模式，也可在设置中固定为浅色或深色；界面内置中英双语，随时切换。
- 安装版自动检查更新，下载完成后 5 秒自动静默安装并重启，全程无需点击；便携版自动检查并提示手动下载。macOS 采用下载校验后原地换包的原生升级方案，未签名应用同样可用。

## 无需在管理器中重复登录

### ChatGPT

ChatGPT 通过配套 Chrome/Edge 扩展复用浏览器中已有的登录状态：

1. 从 [GitHub Releases](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases) 下载并安装 Conversation Manager。
2. 在 Chrome/Edge 的扩展管理页启用“开发者模式”，选择“加载已解压的扩展程序”，目录选择应用设置中“打开扩展目录”指向的目录。
3. 扩展加载后即会自动完成配对：扩展会在后台向桌面端发起连接，无需任何点击；也可以点击浏览器工具栏中的扩展，再点“一键连接桌面管理器”。
4. 保持一个已登录的 `chatgpt.com` 标签页打开，即可读取和管理会话。扩展升级后无需手动刷新旧标签页，管理器会在首次读取时自动恢复桥接。
5. 主程序更新后，扩展会通过版本协商自动完成自我重载并升级到新版本；如遇异常，可在 `chrome://extensions` 手动重载，或通过设置页的扩展目录入口操作。

完全没有 ChatGPT 登录状态时无法读取云端会话。桥接断开后仍可查看缓存，但归档和删除会被禁用。

### Codex

OpenAI 的 Windows 桌面客户端虽然以 `ChatGPT.exe` 运行、并在同一应用中提供 ChatGPT 与 Codex，但公开的 `codex app-server` 只提供 Codex 任务接口，不提供 ChatGPT 云端聊天列表或管理接口。Conversation Manager 会自动查找并连接这个内置后端，不要求再次登录，也不读取 `auth.json`、会话 JSONL 或状态数据库。

只有自动检测失败时，设置页才显示手动选择 `codex.exe`、`codex.cmd` 或 `codex.bat` 的兜底入口。Codex 任务优先按项目 ID 归入可折叠的项目文件夹；桌面端为未挂项目会话创建的临时目录会被识别并归入「非项目任务」，固定显示在所有项目文件夹之前。ChatGPT 中的项目工作会话默认不出现在聊天列表，可通过工具栏的「工作」视图查看。

在应用中打开 Codex 会话时，会优先通过桌面客户端注册的 `codex://` 深链在其原生界面中打开；未安装桌面客户端或协议未注册时，自动回退到终端 `codex resume`，仍不可用则复制恢复命令到剪贴板。

## 隐私与安全

- 桥接服务只监听 `127.0.0.1`，仅本机可访问。
- ChatGPT Cookie、访问令牌和原始账号 ID **不会离开浏览器扩展**。
- 本地只保存会话 ID、标题、时间、状态和必要标记，**不保存正文**。
- SHA-256 摘要只用于隔离不同账号的缓存，不代替服务器校验；远端删除通过周期性完整校准识别。
- 永久删除需要预览和二次确认；只有服务端确认成功后才更新缓存。
- ChatGPT 会话管理依赖网页内部接口。接口变化时应用会停止写操作，不会用模拟点击降级删除。

## 工作原理（简）

- **ChatGPT**：浏览器扩展在已登录的 `chatgpt.com` 页面内执行会话请求，桌面端通过回环 HTTP 桥（`127.0.0.1:32147`，带配对密钥与命令过期机制）收发命令，Cookie 与令牌始终留在浏览器。
- **Codex**：桌面端自动发现并连接本机 `codex app-server`（stdio JSON-RPC），通过官方接口读取与管理任务，不解析任何凭据或会话文件。
- **本地索引**：`conversation-index.json` 仅存元数据（ID、标题、时间、状态、项目归属），是显示缓存而非认证存储或消息归档。

详细架构见 [docs/architecture.md](docs/architecture.md)。

## 本地开发

需要 Node.js 22.12+ 与 pnpm 11：

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

构建 Windows 安装版和便携版：

```powershell
pnpm package:win
```

构建 macOS 安装包：

```powershell
pnpm package:mac
```

实现与恢复记录见 [docs/conversation-manager-implementation-plan.md](docs/conversation-manager-implementation-plan.md)。

## macOS 安装说明（Apple Silicon）

> macOS 版现为正式版，支持应用内自动更新。应用仍未做 Apple Developer 签名与公证，首次打开可能被 Gatekeeper 拦截，属正常现象。提供 dmg 与 zip 两种安装包，任选其一。

### 方式一：DMG 安装（推荐）

1. 下载 `Conversation-Manager-x.y.z-dmg-arm64.dmg` 并打开。
2. 在弹出的窗口中将应用拖入「Applications」文件夹。
3. 首次打开：右键点击应用选择「打开」确认；或在「系统设置 → 隐私与安全性」中点击「仍要打开」。

### 方式二：ZIP 解压

下载 `Conversation-Manager-x.y.z-mac-arm64.zip` 解压，右键点击应用选择「打开」确认；或在「系统设置 → 隐私与安全性」中点击「仍要打开」。

### 方式三：命令行下载 zip（不触发 Gatekeeper）

`curl` 下载的文件不携带隔离标记，解压后可直接打开：

```bash
curl -LO "https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases/download/v0.7.9/Conversation-Manager-0.7.9-mac-arm64.zip"
```

- 加载浏览器扩展后 30 秒内自动配对；`thread/read` 内容读取需要在 chatgpt.com 页面打开的状态下使用。

## 已知限制

- `v0.7.9` 支持 Windows x64 与 macOS（Apple Silicon），均支持应用内自动更新；Windows 便携版与 macOS 因未做 Apple 签名，自动更新采用下载校验后原地换包的方式实现。
- 配套扩展暂通过 Release ZIP 分发，尚未上架浏览器商店。
- Firefox，以及直接读取 ChatGPT 桌面客户端的私有聊天数据库暂不支持。

## License

MIT
