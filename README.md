# Conversation Manager

Conversation Manager 是一个面向 ChatGPT 与 Codex 的本地桌面会话管理器，专注解决历史记录太多时难以查找、筛选和批量整理的问题。

它不显示聊天正文，也不替代 ChatGPT 或 Codex。选择会话后会交给官方网页或 Codex 终端打开。

## 功能

- 侧边栏统一导航：ChatGPT 与 Codex 平台切换、未归档/已归档/已安排状态切换（带数量徽标）、桥接与 App Server 连接状态指示。
- ChatGPT 区分“聊天”与“项目工作”：项目相关会话默认从聊天列表隐藏，只在 Codex 页管理；需要时可通过工具栏的“工作”视图查看和管理。
- 按标题、状态以及 1 天、1 周、1 个月、半年以前筛选，分段切换控件带滑动指示动画。
- 单击会话行任意位置选中，双击打开；支持 ↑↓ 移动、空格选中、Enter 打开、`/` 聚焦搜索、Ctrl/Cmd+A 全选、Delete 快捷归档、Esc 清空选择。
- 多选批量归档、恢复和永久删除；删除使用应用内对话框预览确认，超过 20 条需输入数量。
- 默认保护置顶、当前会话和运行中的 Codex 任务。
- 缓存最小会话索引，启动时立即显示；支持后台增量同步和手动完整校准，同步完成会显示当前状态的会话数量。
- 跟随系统深色模式，也可在设置中固定为浅色或深色。
- 安装版自动检查更新，下载完成后 5 秒自动静默安装并重启，全程无需点击；便携版自动检查并提示手动下载。

## 无需在管理器中重复登录

### ChatGPT

ChatGPT 通过配套 Chrome/Edge 扩展复用浏览器中已有的登录状态：

1. 从 [GitHub Releases](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases) 下载并安装 Conversation Manager。
2. 在 Chrome/Edge 的扩展管理页启用“开发者模式”，选择“加载已解压的扩展程序”，目录选择应用设置中“打开扩展目录”指向的目录。
3. 扩展加载后即会自动完成配对：扩展会在后台向桌面端发起连接，无需任何点击；也可以点击浏览器工具栏中的扩展，再点“一键连接桌面管理器”。
4. 保持一个已登录的 `chatgpt.com` 标签页打开，即可读取和管理会话。扩展升级后无需手动刷新旧标签页，管理器会在首次读取时自动恢复桥接。
5. 主程序更新后请重新加载扩展；版本不一致时，侧边栏的“ChatGPT 桥接”会显示黄色“需重载”提示。

完全没有 ChatGPT 登录状态时无法读取云端会话。桥接断开后仍可查看缓存，但归档和删除会被禁用。

### Codex

OpenAI 的 Windows 桌面客户端虽然以 `ChatGPT.exe` 运行，并在同一应用中提供 ChatGPT 与 Codex，但公开的 `codex app-server` 只提供 Codex 任务接口，不提供 ChatGPT 云端聊天列表或管理接口。Conversation Manager 会自动查找并连接这个内置后端，不要求再次登录，也不读取 `auth.json`、会话 JSONL 或状态数据库。

只有自动检测失败时，设置页才显示手动选择 `codex.exe`、`codex.cmd` 或 `codex.bat` 的兜底入口。Codex 任务优先按项目 ID 归入可折叠的项目文件夹；桌面端为未挂项目会话创建的临时目录会被识别并归入“非项目任务”，固定显示在所有项目文件夹之前。ChatGPT 中的项目工作会话默认不出现在聊天列表，可通过工具栏的“工作”视图查看。

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

- `v0.2.7` 支持 Windows x64、Chrome 和 Edge。
- 配套扩展暂通过 Release ZIP 分发，尚未上架浏览器商店。
- macOS、Firefox，以及直接读取 ChatGPT 桌面客户端的私有聊天数据库暂不支持。

## License

MIT
