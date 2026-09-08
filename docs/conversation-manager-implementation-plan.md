# Conversation Manager 免重复登录重构

## 当前状态

- 目标版本：`v0.2.0-preview.1`
- 当前阶段：`v0.2.0-preview.1` 已发布
- 最后验证提交：`0429d60`
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
2. 桥接仅监听 `127.0.0.1`，使用五分钟配对码、五次失败限制和高熵持久密钥。
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
- `pnpm test`：通过；浏览器桥接 9 项、桥接服务 6 项、会话领域 3 项、Codex Adapter 2 项、更新器 3 项、配套 MCP 1 项。
- `pnpm typecheck`：通过。
- `pnpm package:win`：通过，已生成 Windows x64 安装版、便携版和浏览器桥接 ZIP。
- `git diff --check`：通过。
- `pnpm audit --audit-level high`：未发现已知漏洞。
- ASAR 清单审计：业务 workspace 包仅包含编译产物和 package metadata；测试、TypeScript 源文件及 tsconfig 未打入应用。
- 敏感信息扫描：未发现 GitHub Token、API Key、私钥、本地用户路径、Cookie 或本地缓存文件。

尚未执行：Chrome/Edge 真实账号只读同步、专用测试会话的归档/恢复/删除、旧安装版原位升级。发布预览版后需要在真实环境逐项验证。

## 中断后恢复

1. 进入仓库并运行 `git status --short`。
2. 阅读本文件的“当前状态”“阶段清单”和“验证记录”。
3. 运行 `pnpm test` 与 `pnpm typecheck` 确认现状。
4. 从第一个未勾选阶段继续；真实 ChatGPT 只允许只读验证，破坏性验证必须使用专门测试会话。
