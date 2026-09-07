# ChatGPT/Codex Conversation Navigator 桌面化计划

## 1. 总体结论

可以开发成 Windows `.exe` 和 macOS `.dmg`，但不能把现有代码直接安装进官方 ChatGPT/Codex 桌面窗口。

最终采用已经确认的“双轨方案”：

1. 开发独立的 `CGN Desktop` Electron 客户端。

   - ChatGPT：在隔离的 Electron Chromium 页面中加载 `chatgpt.com`，保留当前扩展的大部分完整能力。
   - Codex：通过官方 `codex app-server` 管理本机 Codex 任务。
   - Windows 先发布公开预览版，macOS 后续发布签名、公证的 DMG。

2. 开发官方桌面应用伴侣插件。

   - 可安装到 ChatGPT/Codex 桌面应用。
   - 管理 Codex 任务，并提供打开 `CGN Desktop` 的入口。
   - 不尝试读取或修改官方 ChatGPT/Codex 窗口的宿主 DOM。

3. 使用新的独立仓库。

   - 建议仓库名：`chatgpt-codex-conversation-navigator-desktop`
   - 现有 Chrome 扩展仓库继续独立维护。
   - 桌面首版不迁移扩展中的节点、布局和缓存数据。

官方文档已经确认：

- ChatGPT/Codex 桌面应用支持 [Plugins](https://learn.chatgpt.com/docs/plugins)、Skills 和 MCP。
- Codex 提供正式的 [App Server](https://developers.openai.com/codex/app-server)，包含任务列表、读取、分叉、归档、恢复和删除接口。
- MCP Apps 可以显示[自定义 iframe 界面](https://developers.openai.com/apps-sdk/build/chatgpt-ui)，但 iframe 不能访问宿主聊天 DOM。

## 2. 三个产品界面的功能分工

| 功能 | CGN Desktop · ChatGPT | CGN Desktop · Codex | 官方伴侣插件 |
|---|---:|---:|---:|
| 查看完整对话 | 内嵌 ChatGPT 网页 | 自定义任务阅读器 | 轻量任务列表 |
| 当前对话扫描与跳转 | 完整支持 | 按轮次导航 | 不支持宿主对话扫描 |
| 长对话收口与恢复 | 完整支持 | 阅读器内折叠 | 不修改宿主界面 |
| 节点标记 | 支持 | 支持 | 只显示已有节点 |
| 分支 | 调用 ChatGPT 原生菜单 | `thread/fork` | 调用 Codex 分叉工具 |
| 标题和时间筛选 | 支持 | 支持 | 支持 |
| 未归档、已归档 | 支持 | 支持 | 支持 Codex |
| 已安排 | 支持 ChatGPT 活动提醒 | 显示 Codex 计划任务运行 | 不作为首版重点 |
| 批量归档、恢复、删除 | 支持 | 支持 | 支持 Codex |
| 全文搜索 | 当前页正文和历史标题 | 用户/助手消息全文 | 通过本地 Codex 索引 |
| 打开官方应用 | 外部链接 | 可启动/恢复 Codex | 可打开 CGN Desktop |

## 3. 桌面端技术架构

### 工程结构

新仓库采用 pnpm workspace：

```text
apps/
  desktop/                 Electron 主程序和桌面界面
packages/
  conversation-domain/     会话、筛选、节点和批处理规则
  chatgpt-web-adapter/      ChatGPT 网页注入与内部接口适配
  codex-app-server-adapter/ Codex JSON-RPC 适配
  local-store/             SQLite、本地索引和迁移
  desktop-ui/              React 会话管理和 Codex 阅读器
companion-plugin/
  plugin/                  官方 ChatGPT/Codex 伴侣插件
  mcp/                     本地 MCP 工具
tests/
```

桌面框架确定为：

- Electron
- TypeScript
- React + Vite
- `electron-builder`
- `better-sqlite3` + FTS5
- Vitest/Node Test
- Playwright Electron
- GitHub Actions

### 深模块与 Interface

按照现有代码的真实依赖，把复杂实现收进三个深模块。

`ConversationProvider` 供统一会话管理器调用：

```ts
interface ConversationProvider {
  capabilities(): ProviderCapabilities;
  list(query: ConversationQuery): Promise<ConversationPage>;
  read(id: string): Promise<ConversationDetail>;
  runBatch(request: BatchRequest): Promise<BatchResult>;
  fork?(request: ForkRequest): Promise<ConversationRef>;
}
```

统一记录：

```ts
type ConversationSource = "chatgpt" | "codex";
type ConversationState = "active" | "archived" | "scheduled";

interface ManagedConversation {
  source: ConversationSource;
  id: string;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
  state: ConversationState;
  projectId?: string;
  cwd?: string;
  pinned: boolean;
  running: boolean;
  current: boolean;
  capabilities: Array<"read" | "archive" | "restore" | "delete" | "fork">;
}
```

`NavigatorRuntime` 管理 ChatGPT 页面注入：

```ts
interface NavigatorRuntime {
  scan(): ConversationOutline;
  jump(anchorId: string): void;
  collapse(options: CollapseOptions): void;
  restore(): void;
  toggleNode(anchorId: string): Promise<void>;
  branch(anchorId: string): Promise<BranchResult>;
}
```

`LocalStore` 管理所有非认证数据：

```ts
interface LocalStore {
  readIndex(source: ConversationSource, namespace: string): Promise<IndexSnapshot>;
  writeIndex(snapshot: IndexSnapshot): Promise<void>;
  applyBatch(result: BatchResult): Promise<void>;
  manageNode(request: NodeMutation): Promise<void>;
  clear(scope: ClearScope): Promise<void>;
}
```

## 4. Electron 主程序

主窗口使用本地 React 页面作为应用外壳，并通过 `WebContentsView` 承载 ChatGPT。

主要区域：

- 左侧产品切换：`ChatGPT / Codex`
- ChatGPT 页面：内嵌登录后的 `chatgpt.com`
- Codex 页面：自定义任务列表、阅读器和节点面板
- 统一设置：缓存、索引、Codex 路径、兼容性和版本信息

安全设置：

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- 远程 ChatGPT 页面只得到极小的 preload Interface
- 不向远程页面暴露文件系统、shell 或任意 IPC
- IPC 必须校验来源窗口、消息结构和允许操作
- 导航仅允许 OpenAI 登录与 ChatGPT 必要域名
- 其他链接交给系统浏览器打开
- 默认拒绝摄像头、位置等不需要的权限
- 文件上传由用户主动选择
- 日志自动过滤访问令牌、Cookie、标题和正文

## 5. ChatGPT 桌面适配

### 页面和登录

使用独立持久化会话分区，例如：

```text
persist:cgn-chatgpt
```

用户直接在内嵌 ChatGPT 页面登录。会话 Cookie 由 Chromium 和操作系统密钥库管理，不复制 Chrome Cookie，不读取官方桌面应用凭据。

首个技术验证必须覆盖：

- 邮箱登录
- Google/Microsoft 登录弹窗
- 多账号切换
- 登录状态跨重启保留
- 退出登录和清理本地会话

如果某类 OAuth 明确拒绝 Electron，不采用导入浏览器 Cookie等危险方式；该登录方式在预览版中标记为不支持，不能假装登录成功。

### 复用和重构

从现有扩展移植：

- 消息扫描
- 问题/回复分组
- 滚动定位与中心高亮
- 搜索
- 轻量和极简模式
- 消息收口与恢复
- 节点和分支图
- ChatGPT 原生“新聊天中的分支”
- 会话管理器
- 本地最小会话索引

不直接复制整个 `content.js` 继续扩张。先拆成：

- 页面识别与 DOM Adapter
- 导航和节点规则
- ChatGPT 注入 UI
- 存储 Adapter
- 内部接口 Adapter

Chrome 专属的 `chrome.storage.local` 改为 Electron IPC 存储 Adapter。

### ChatGPT 会话管理

继续使用当前网页会话中的临时认证信息和内部接口：

- 普通会话
- 项目会话
- 置顶会话
- 已归档会话
- 已安排任务
- 归档、恢复和删除

保持现有保护：

- 默认跳过当前聊天和置顶聊天
- 最多三个并发请求
- 429/5xx 重试
- 删除二次确认
- 只有服务端明确确认后才更新缓存
- 接口结构变化时停止写操作
- 不使用 DOM 自动点击作为删除降级方案

需要明确标注：ChatGPT 会话管理依赖非公开网页接口，未来仍可能因官方改版失效。

## 6. Codex 完整任务体验

### App Server 连接

优先连接官方共享 App Server：

1. 检测 `codex` CLI 和 ChatGPT 桌面应用附带的 Codex 可执行文件。
2. 查询版本并执行初始化握手。
3. 优先通过 `codex app-server proxy` 连接共享 daemon。
4. 无共享 daemon 时启动独立的 stdio App Server。
5. 不直接解析或改写 `sessions/*.jsonl`、SQLite 状态库或 `auth.json`。

未找到 Codex 时，Codex 页面进入只读说明状态，并引导安装或选择官方 Codex 可执行文件。

### 使用的稳定能力

- `thread/list`
- `thread/read`
- `thread/fork`
- `thread/archive`
- `thread/unarchive`
- `thread/delete`
- `thread/status/changed`

运行时进行能力探测。某个方法不可用时，仅禁用对应按钮，不让整个客户端崩溃。

### Codex 阅读器

支持呈现：

- 用户消息
- 助手回复
- 推理摘要
- 命令执行
- 文件变更
- 工具调用
- 审批记录
- 图片和资源引用
- 未识别的新项目类型以折叠兼容卡片显示

首版不负责在 CGN Desktop 中运行新的 Codex 编码任务；它聚焦阅读、检索、节点、分叉和会话管理。

### 搜索与索引

首次进入 Codex 页面：

1. 分页读取任务元数据。
2. 先显示本地缓存列表。
3. 后台读取新增或更新时间变化的任务。
4. 将标题、用户消息和助手消息写入 SQLite FTS5。
5. 命令输出、工具原始载荷和 diff 默认不进入持久化全文索引。
6. 当前打开任务仍可在内存中搜索全部可见文本。

用户可以在设置中：

- 查看索引大小和最后同步时间
- 重新构建索引
- 清除 Codex 全文索引
- 禁止后台全文索引，只保留标题搜索

### Codex 节点和分叉

节点引用使用稳定标识：

```ts
interface ConversationNode {
  source: "chatgpt" | "codex";
  conversationId: string;
  anchorId: string;       // ChatGPT 消息标识或 Codex turn/item ID
  title: string;
  excerpt: string;
  createdAt: number;
}
```

Codex 分叉调用：

```text
thread/fork(threadId, lastTurnId)
```

如果目标轮次已被删除、压缩或不可读取，禁止分叉并显示原因。

### Codex 批量操作

- 未归档：归档、删除
- 已归档：恢复、删除
- 运行中任务默认不可批量操作
- 批处理按顺序执行，避免同时移动本地任务文件
- 失败项保留选中
- 删除前展示任务名称、数量和子任务影响范围

特别处理：`thread/delete` 可能同时删除派生子任务。删除确认框必须展示去重后的任务闭包；超过 20 条时要求输入显示的确认数字。

## 7. 官方 ChatGPT/Codex 伴侣插件

伴侣插件包含：

- `.codex-plugin/plugin.json`
- 本地 MCP 配置
- Codex 会话管理 Skill
- MCP Apps 轻量管理界面
- `打开 CGN Desktop` 工具

MCP 工具：

```text
list_codex_conversations
read_codex_conversation
preview_codex_batch
archive_codex_conversations
restore_codex_conversations
delete_codex_conversations
fork_codex_conversation
open_cgn_desktop
```

危险操作采用两阶段 Interface：

1. `preview_codex_batch` 返回准确数量、标题和派生任务影响。
2. 用户确认后，写操作必须携带短时确认令牌。
3. 确认令牌绑定操作类型和任务 ID，超时或内容变化即失效。

伴侣插件通过安装后的桌面程序进入 MCP 模式，不要求系统单独安装 Node：

```text
CGN Desktop --mcp-stdio
```

桌面程序提供“安装伴侣插件”按钮：

- 写入个人本地 marketplace
- 为当前安装路径生成 MCP 配置
- 修改前备份已有 marketplace
- 卸载时只删除自己添加的条目
- 提示用户重启 ChatGPT 桌面应用

首版通过本地/GitHub marketplace 分发，不直接申请进入 OpenAI 公共插件目录。

## 8. 本地数据与隐私

SQLite 只保存：

- 会话最小索引
- ChatGPT/Codex 节点
- UI 设置
- Codex 用户/助手文本搜索索引
- 同步检查点
- Schema 版本

不保存：

- ChatGPT 访问令牌
- ChatGPT Cookie 副本
- Codex API Key
- Codex `auth.json`
- ChatGPT 完整聊天正文缓存
- 命令原始环境变量
- 完整工具调用载荷

ChatGPT Cookie 保存在 Electron 独立 session 中；Codex 登录由官方 Codex 管理。

数据库需要：

- 原子迁移
- 启动备份
- 损坏恢复
- 一键清空
- 删除成功后同步清理索引和节点
- 日志脱敏

## 9. 实施阶段

### 阶段 0：技术验证

先制作三个最小原型，不开始大规模迁移：

- Electron 内嵌 ChatGPT 登录、持久会话和 DOM 注入
- Codex App Server 列表、读取和分叉
- 官方插件调用本地 MCP，并启动 `cgn://` 深链接

通过条件：

- ChatGPT 至少一种正式登录方式可稳定跨重启保持
- 可扫描真实 ChatGPT 对话 DOM
- 可只读读取真实 Codex 任务
- 可在隔离测试目录完成 Codex 归档、恢复、删除
- 官方桌面插件可以连接本地 MCP

任何一项失败，都先调整架构，不进入正式 UI 开发。

### 阶段 1：新仓库和核心模块

- 创建独立仓库和 TypeScript 工程
- 建立 CI、依赖审计、许可证和安全策略
- 移植纯筛选、时间、合并和批处理规则
- 建立 Provider、NavigatorRuntime 和 LocalStore Interface
- 建立 SQLite Schema 与迁移系统

### 阶段 2：ChatGPT 功能平移

- 完成 Electron ChatGPT 页面
- 迁移扫描、跳转、收口、节点和分支
- 迁移会话管理器与本地缓存
- 增加登录、导航和接口兼容状态页面
- 与 Chrome 扩展建立同一套行为测试，但不共享用户数据

### 阶段 3：Codex 功能实现

- 实现 App Server Adapter
- 完成任务列表和虚拟滚动
- 完成任务全文阅读器
- 完成全文索引、节点和按轮次分叉
- 完成批量归档、恢复和删除
- 处理运行状态、派生任务和协议版本差异

### 阶段 4：官方伴侣插件

- 构建 MCP 工具和 MCP Apps 界面
- 接入同一 Codex Provider
- 实现危险操作预览与确认令牌
- 实现桌面程序打开与本地 marketplace 安装
- 验证 ChatGPT Work 和 Codex 两个入口

### 阶段 5：Windows 公开预览版

首版版本号：

```text
v0.1.0-preview.1
```

产物：

- Windows x64 NSIS 安装版 `.exe`
- Windows x64 便携版 `.exe`
- 伴侣插件 ZIP
- SHA-256 校验文件
- SBOM
- Release Notes

Windows 未签名预览版会明确提示 SmartScreen 风险。首版只检查更新并打开 GitHub Release 页面，不静默自动更新。

### 阶段 6：macOS DMG

首个 macOS 目标：

- Apple Silicon arm64
- Developer ID Application 签名
- Hardened Runtime
- Apple Notarization
- Staple 公证票据
- DMG 安装包

Intel x64 在 arm64 稳定后再决定是否增加。没有 Apple 开发者证书和公证凭据时，不发布未签名 DMG 冒充正式版本。

单人开发粗略估算为 7–10 周，其中风险最高的是 ChatGPT 登录兼容、DOM 改版和 macOS 签名流程。

## 10. 完整测试计划

### 单元与契约测试

- 时间边界、筛选、搜索、去重和选择保护
- ChatGPT API 分页、项目、置顶、归档和已安排
- Codex JSON-RPC 请求、分页、通知和未知项目类型
- SQLite 迁移、损坏恢复、删除同步和 FTS
- MCP 危险操作确认令牌
- Provider 能力降级

### Electron UI 测试

- ChatGPT 登录和跨重启会话
- 当前对话扫描、滚动跳转和收口恢复
- 节点与分支
- 2,000 条以上 ChatGPT 会话
- 5,000 条以上 Codex 任务
- 列表无闪烁、滚动位置保持
- 320px 窄面板与桌面宽屏
- 键盘、焦点、Esc 和无障碍名称
- 离线、App Server 重启和 ChatGPT 接口变化

### 安全测试

- 远程页面无法调用任意主进程 IPC
- 非 OpenAI 页面不能获得注入权限
- `window.open` 与下载目标限制
- MCP 参数不能注入 shell
- 日志不包含 Cookie、令牌、正文和环境变量
- 本地 HTTP/IPC 只允许本机和受认证客户端
- 伴侣插件卸载不破坏用户已有配置

### 破坏性操作测试

- ChatGPT 真实环境只使用专门创建的测试聊天
- 每次真实删除前人工确认
- Codex 使用隔离的临时 `CODEX_HOME`
- 不对用户现有 ChatGPT/Codex 会话运行自动删除测试
- 验证部分失败、停止队列、重试和缓存一致性

## 11. 首版验收标准

- Windows 安装版和便携版可启动、升级和卸载。
- ChatGPT 登录状态可跨重启保存。
- 现有扫描、搜索、跳转、收口、节点、分支和会话管理功能完成迁移。
- ChatGPT 接口不兼容时所有写操作安全停止。
- Codex 能分页查看未归档和已归档任务，并读取完整任务内容。
- Codex 支持标题/正文搜索、节点和按轮次分叉。
- Codex 支持批量归档、恢复和删除，且正确提示派生任务影响。
- 缓存数据显示期间不闪烁、不重置滚动位置。
- 官方伴侣插件能够查看和管理 Codex 任务，并打开 CGN Desktop。
- 不读取官方应用凭据文件，不上传会话正文，不把令牌写入日志或数据库。
- Windows CI、测试、安装包审计和 GitHub Release 全部通过后才能发布。
