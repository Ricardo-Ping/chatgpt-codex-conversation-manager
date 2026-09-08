# Conversation Manager 免重复登录重构

## 当前状态

- 目标版本：`v0.2.2`
- 当前阶段：`v0.2.2` 已发布
- 最后验证提交：`31b8f4a`
- 已确认：ChatGPT 使用浏览器桥接；Codex 使用本机 App Server；管理器不提供独立登录。

## 阶段清单

- [x] 产品、包名、README、更新地址迁移为 Conversation Manager
- [x] Node loopback 桥接、配对和最小缓存
- [x] Chrome/Edge MV3 配套扩展
- [x] 移除 WebContentsView、正文、节点和分支
- [x] ChatGPT/Codex 双标签会话管理 UI
- [x] 单元、类型、构建、打包和安全审计
- [x] GitHub 仓库重命名与 `v0.2.0-preview.1` Release

## 实现约束

1. “免登录”指管理器不重复登录。ChatGPT 必须复用浏览器已有登录；Codex 复用本机 Codex 环境。
2. 桥接仅监听 `127.0.0.1`；用户在扩展中显式点击一次完成配对，自动配对端点只接受扩展 Origin，并生成高熵持久密钥。
3. Token、Cookie、原始账号 ID、正文和完整接口响应不得传给桌面端或写入缓存。
4. ChatGPT 接口结构、认证或桥接异常时，只显示缓存并禁用写操作。
5. 批量删除只在服务端明确确认后更新缓存；已安排只读取任务接口。
6. Codex 仅调用 `thread/list/archive/unarchive/delete`，不读取认证文件或会话数据库。

## 目标结构

- `packages/chatgpt-bridge-server`：loopback 协议、配对、命令队列、缓存。
- `packages/chatgpt-browser-bridge-extension`：MV3 background、popup、ChatGPT content adapter。
- `apps/desktop`：本地 React 管理界面、受限 IPC、Codex App Server、自动更新。

## 验证记录

- `pnpm install --lockfile-only`：通过，锁文件已同步。
- `pnpm test`：通过；浏览器桥接 13 项、桥接服务 7 项、会话领域 3 项、Codex Adapter 2 项、桌面端 6 项、配套 MCP 1 项。
- `pnpm typecheck`：通过。
- `pnpm package:win`：通过，已生成 Windows x64 安装版、便携版和浏览器桥接 ZIP。
- `git diff --check`：通过。
- `pnpm audit --audit-level high`：未发现已知漏洞。
- ASAR 清单审计：业务 workspace 包仅包含编译产物和 package metadata；测试、TypeScript 源文件及 tsconfig 未打入应用。
- 敏感信息扫描：未发现 GitHub Token、API Key、私钥、本地用户路径、Cookie 或本地缓存文件。

已执行：在本机统一 ChatGPT/Codex Windows 客户端环境中自动发现内置 `codex.exe`，并通过 `app-server` 只读取得 41 条任务；41 条均包含 `cwd`，可归入 24 个工作目录分组。

尚未执行：`v0.2.1` 扩展的 Chrome/Edge 真实账号只读同步、专用测试会话的归档/恢复/删除、旧安装版原位升级。真实 ChatGPT 写操作仍只允许使用专门测试会话。

## 中断后恢复

1. 进入仓库并运行 `git status --short`。
2. 阅读本文件的“当前状态”“阶段清单”和“验证记录”。
3. 运行 `pnpm test` 与 `pnpm typecheck` 确认现状。
4. 从第一个未勾选阶段继续；真实 ChatGPT 只允许只读验证，破坏性验证必须使用专门测试会话。

## 正式版跟进

- 正式版本：`v0.2.0`
- 卸载能力：NSIS 安装器生成卸载程序，并写入 Windows 卸载注册表；便携版无需卸载。
- 名称核对：当前仓库、远端地址、包名、产品名、更新地址和文档均使用 Conversation Manager；旧 App ID、旧配置目录和 `cgn-desktop-mcp` 仅作为升级兼容保留。
- 正式版验证：单元测试、类型检查、Windows 构建、依赖审计、ASAR 内容检查、Release 文件哈希与敏感信息扫描。

## v0.2.1 现场修复

- 扩展配对改为一次显式点击，不再手工传递六位码。
- ChatGPT 项目会话恢复已验证的 `cursor`、`owned_only` 参数，移除导致 422 的 `is_archived` 项目参数。
- Windows 自动扫描统一桌面客户端生成的 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，PATH 与手动选择保留为兜底。

## v0.2.2 现场修复

- ChatGPT 标签页没有消息接收端时，扩展自动补注入桥接脚本并重试；重复注入由单实例保护拦截。
- 桌面端隐藏 Electron IPC 的内部错误前缀，只显示可执行的错误信息。
- Codex 任务按 `cwd` 归入可折叠项目文件夹；没有 `cwd` 的任务归入“非项目任务”。
- 下载完成的安装版更新使用静默安装，避免再次弹出 NSIS 安装向导。
