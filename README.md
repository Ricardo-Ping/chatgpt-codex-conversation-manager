# ChatGPT/Codex 会话导航桌面版

**简体中文** | [English](README.en.md)

`CGN Desktop` 是一个独立的 Electron 桌面客户端，用于整理和导航 ChatGPT 长对话，并管理本机 Codex 任务。

本项目是浏览器扩展 [ChatGPT Conversation Navigator](https://github.com/Ricardo-Ping/chatgpt-conversation-navigator) 的桌面版本。当前预览版内置上游 `v0.2.3`（`2b10a7d`）运行时，并将其加载到隔离的 ChatGPT 网页视图中；Codex 任务管理使用官方 [Codex App Server](https://developers.openai.com/codex/app-server)。

## 功能

- 在独立且持久化的 Electron 会话中登录 ChatGPT。
- 扫描长对话，并支持搜索、跳转、收口与恢复。
- 将关键回复标记为节点，快速创建和管理对话分支。
- 管理 ChatGPT 未归档、已归档和已安排会话，支持时间筛选、批量归档、恢复及安全删除。
- 查看和搜索本机 Codex 任务，支持分支、归档、恢复和带二次确认的永久删除。
- 默认检查 GitHub Releases 更新，也可在设置页关闭自动检查或手动检查。
- 使用上下文隔离、沙箱渲染、来源校验 IPC 和外部链接限制保护桌面环境。

ChatGPT 会话管理依赖 ChatGPT 网页的内部接口。当接口兼容性验证失败时，应用会停止写操作，不会降级为自动点击网页删除。

## 下载与安装

普通用户不需要安装 Node.js 或 pnpm。请从 [GitHub Releases](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-navigator-desktop/releases) 下载：

- `setup-x64.exe`：推荐使用的 Windows 安装版，支持自动下载和安装更新。
- `portable-x64.exe`：免安装便携版，可以自动检查更新，但需要手动下载新版替换。

安装版默认在启动 10 秒后检查更新，并每 4 小时再次检查；发现新版后自动下载，可点击“重启并安装”，也会在退出应用时安装。预览版尚未正式签名，Windows SmartScreen 可能显示提醒。

使用 ChatGPT 功能时，直接在应用内登录。使用 Codex 任务功能时，需要提前安装并登录 Codex CLI。

## 本地开发

开发环境要求 Node.js 22.12 或更高版本、pnpm 11；Codex 页面还需要 Codex CLI。

```bash
pnpm install
pnpm build
pnpm start
```

测试与 Windows 打包：

```bash
pnpm typecheck
pnpm test
pnpm package:win
```

## 项目结构

```text
apps/desktop/                      Electron 主进程和 React 界面
packages/conversation-domain/      通用筛选和选择规则
packages/chatgpt-web-adapter/      ChatGPT 运行时注入
packages/codex-app-server-adapter/ Codex JSON-RPC 客户端
companion-plugin/                   Codex 伴侣插件和 MCP 服务
docs/                               架构与实施计划
```

## 隐私与安全

应用不会持久化 ChatGPT 访问令牌、复制浏览器 Cookie、读取 Codex `auth.json` 或上传会话内容。ChatGPT Cookie 只保存在 Electron 的 `persist:cgn-chatgpt` 独立会话中；Codex 登录状态由本机 Codex CLI 管理。

## 当前状态

`v0.1.0-preview.3` 仍是技术预览版。ChatGPT OAuth 兼容性、macOS 签名与公证、伴侣插件安装流程以及真实账号破坏性操作仍需要在稳定版前继续验证。
