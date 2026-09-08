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
4. 点击浏览器工具栏中的扩展，再点“一键连接桌面管理器”。首次只需这一次显式操作，之后会自动连接。
5. 保持一个已登录的 `chatgpt.com` 标签页打开，即可读取和管理会话。扩展升级后无需手动刷新旧标签页，管理器会在首次读取时自动恢复桥接。

完全没有 ChatGPT 登录状态时无法读取云端会话。桥接断开后仍可查看缓存，但归档和删除会被禁用。

### Codex

OpenAI 的 Windows 桌面客户端虽然以 `ChatGPT.exe` 运行，并在同一应用中提供 ChatGPT 与 Codex，但公开的 `codex app-server` 只提供 Codex 任务接口，不提供 ChatGPT 云端聊天列表或管理接口。Conversation Manager 会自动查找并连接这个内置后端，不要求再次登录，也不读取 `auth.json`、会话 JSONL 或状态数据库。

只有自动检测失败时，设置页才显示手动选择 `codex.exe`、`codex.cmd` 或 `codex.bat` 的兜底入口。Codex 任务按工作目录归入可折叠的项目文件夹；没有工作目录的任务单独归入“非项目任务”。ChatGPT 普通云端聊天仍通过浏览器桥接读取。

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

- `v0.2.2` 支持 Windows x64、Chrome 和 Edge。
- 配套扩展暂通过 Release ZIP 分发，尚未上架浏览器商店。
- macOS、Firefox，以及直接读取 ChatGPT 桌面客户端的私有聊天数据库暂不支持。

## License

MIT
