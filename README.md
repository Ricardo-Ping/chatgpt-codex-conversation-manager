# Conversation Manager

Conversation Manager 是一个面向 ChatGPT 与 Codex 的本地桌面会话管理器，专注解决历史记录太多时难以查找、筛选和批量整理的问题。

它不显示聊天正文，也不替代 ChatGPT 或 Codex。选择会话后会交给官方网页或 Codex 终端打开。

## 功能

- 在 ChatGPT 与 Codex 双标签页中查看会话。
- 按标题、未归档/已归档/已安排以及 1 天、1 周、1 个月、半年以前筛选。
- 多选、全选当前结果、归档、恢复和永久删除。
- 默认保护置顶、当前会话和运行中的 Codex 任务。
- 缓存最小会话索引，启动时立即显示；支持后台增量同步和手动完整校准。
- 安装版默认自动检查并安装 GitHub Release 更新；便携版自动检查并提示手动下载。

## 无需在管理器中重复登录

### ChatGPT

ChatGPT 通过配套 Chrome/Edge 扩展复用浏览器中已有的登录状态：

1. 从 [GitHub Releases](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases) 下载并安装 Conversation Manager。
2. 在 Chrome/Edge 的扩展管理页启用“开发者模式”，选择“加载已解压的扩展程序”。
3. 在应用设置中点击“打开扩展目录”，选择该目录。
4. 在应用中生成六位配对码，并在扩展弹窗输入一次。
5. 保持一个已登录的 `chatgpt.com` 标签页打开，即可读取和管理会话。

完全没有 ChatGPT 登录状态时无法读取云端会话。桥接断开后仍可查看缓存，但归档和删除会被禁用。

### Codex

Codex 通过本机 `codex app-server` 读取任务，不要求在 Conversation Manager 中登录，也不读取 `auth.json`、会话 JSONL 或状态数据库。使用前需要安装并能运行 `codex` CLI。

如果 `codex` 不在系统 PATH 中，可在“设置 → Codex 可执行文件”中手动选择本机的 `codex.exe`、`codex.cmd` 或 `codex.bat`。

## 隐私与安全

- 桥接服务只监听 `127.0.0.1`。
- ChatGPT Cookie、访问令牌和原始账号 ID不会离开浏览器扩展。
- 本地只保存会话 ID、标题、时间、状态和必要标记，不保存正文。
- 永久删除需要预览和二次确认；只有服务端确认成功后才更新缓存。
- ChatGPT 会话管理依赖网页内部接口。接口变化时应用会停止写操作，不会用模拟点击降级删除。

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

详细实施与恢复记录见 [docs/conversation-manager-implementation-plan.md](docs/conversation-manager-implementation-plan.md)。英文说明见 [README.en.md](README.en.md)。

## 当前限制

- `v0.2.0-preview.1` 首先支持 Windows x64、Chrome 和 Edge。
- 配套扩展暂通过 Release ZIP 分发，尚未上架浏览器商店。
- macOS、Firefox 和官方 ChatGPT 桌面应用本地会话接口暂不支持。

## License

MIT
