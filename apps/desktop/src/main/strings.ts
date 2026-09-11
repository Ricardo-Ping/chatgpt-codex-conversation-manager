export type AppLanguage = "zh" | "en";

interface MainStrings {
  checking: string;
  upToDate: string;
  downloadingUpdate: (version: string) => string;
  downloadProgress: (percent: number) => string;
  downloadedAuto: (version: string) => string;
  downloadedManual: (version: string) => string;
  updateError: string;
  installWaitBatch: string;
  updateNotReady: string;
  idle: string;
  devMode: string;
  pickCodexExe: string;
  pickSessionsZip: string;
  saveSessionsZip: string;
  pickSaveDir: string;
  saveLogTitle: string;
  noDirectory: string;
  noItems: string;
  readConversationFailed: string;
  windowUnavailable: string;
  appStart: (version: string, packaged: string) => string;
  startupFailed: (detail: string) => string;
  noSavedCodexCommand: string;
  chatgptExportSummary: (saved: number, failed: number, directory: string) => string;
  codexExportSummary: (saved: number, failed: number, directory: string) => string;
  codexConnectedLocal: string;
  codexConnectedBundled: string;
  codexNotFound: string;
  downloadedWaitBatch: string;
  taskMissing: string;
  taskStateChanged: string;
  deleteConfirmationExpired: string;
  taskRunning: string;
  syncFailed: string;
  batchFailed: string;
  accountReadFailed: string;
  invalidAccountList: string;
  unrecognizedAccountList: string;
  invalidConversationList: string;
  unrecognizedConversations: (count: number) => string;
  unnamedTask: string;
  unnamedConversation: string;
  projectMissing: string;
  macUpdateAvailable: (version: string) => string;
  macInstallNoPermission: string;
}

const zh: MainStrings = {
  checking: "正在检查 GitHub Releases…",
  upToDate: "当前已是最新版本",
  downloadingUpdate: (version) => `发现 v${version}，正在下载`,
  downloadProgress: (percent) => `正在下载更新 ${percent}%`,
  downloadedAuto: (version) => `v${version} 已下载，5 秒后自动重启安装`,
  downloadedManual: (version) => `v${version} 已下载，可重启安装`,
  updateError: "更新失败，请手动打开 Release 页面",
  installWaitBatch: "请等待批量操作完成后再安装更新",
  updateNotReady: "Update is not ready",
  idle: "等待检查更新",
  devMode: "开发模式不检查更新",
  pickCodexExe: "选择 Codex 可执行文件",
  pickSessionsZip: "选择 Codex 会话存档",
  saveSessionsZip: "导出 Codex 会话",
  pickSaveDir: "选择保存位置",
  saveLogTitle: "保存运行日志",
  noDirectory: "未选择保存目录",
  noItems: "未选择要保存的会话",
  readConversationFailed: "读取会话失败",
  windowUnavailable: "Window unavailable",
  appStart: (version, packaged) => `app start: v${version} packaged=${packaged}`,
  startupFailed: (detail) => `startup failed: ${detail}`,
  noSavedCodexCommand: "no saved codex command; using default discovery",
  chatgptExportSummary: (saved, failed, directory) => `已保存 ${saved} 个会话文件到 ${directory}${failed ? `，失败 ${failed} 条` : ""}`,
  codexExportSummary: (saved, failed, directory) => `已保存 ${saved} 个任务文件到 ${directory}${failed ? `，失败 ${failed} 条` : ""}`,
  codexConnectedLocal: "已连接本机 Codex App Server",
  codexConnectedBundled: "已自动连接 ChatGPT/Codex 桌面客户端内置 App Server",
  codexNotFound: "未找到 ChatGPT/Codex 桌面客户端或可用的 Codex App Server",
  downloadedWaitBatch: "更新已下载，将在批量操作完成后自动安装",
  taskMissing: "任务不存在",
  taskStateChanged: "任务状态已变化，请重新预览",
  deleteConfirmationExpired: "删除确认已过期，请重新预览",
  taskRunning: "运行中的任务不能批量操作",
  syncFailed: "同步失败",
  batchFailed: "批量操作失败",
  accountReadFailed: "无法读取 ChatGPT 账号",
  invalidAccountList: "浏览器返回了无效账号列表",
  unrecognizedAccountList: "浏览器返回了无法识别的账号列表",
  invalidConversationList: "浏览器返回了无效会话列表",
  unrecognizedConversations: (count) => `浏览器返回了 ${count} 条无法识别的会话记录，已保留本地缓存`,
  unnamedTask: "未命名任务",
  unnamedConversation: "未命名会话",
  projectMissing: "缺少目标项目",
  macUpdateAvailable: (version) => `发现新版本 v${version}，可下载更新`,
  macInstallNoPermission: "应用所在目录没有写入权限，无法自动安装；请从下载页手动安装"
};

const en: MainStrings = {
  checking: "Checking GitHub Releases…",
  upToDate: "You are on the latest version",
  downloadingUpdate: (version) => `Found v${version}, downloading`,
  downloadProgress: (percent) => `Downloading update ${percent}%`,
  downloadedAuto: (version) => `v${version} downloaded — restarting to install in 5 seconds`,
  downloadedManual: (version) => `v${version} downloaded — restart to install`,
  updateError: "Update failed. Please open the Releases page manually",
  installWaitBatch: "Please wait for batch operations to finish before installing",
  updateNotReady: "Update is not ready",
  idle: "Waiting for update check",
  devMode: "Update checks are disabled in development",
  pickCodexExe: "Select the Codex executable",
  pickSessionsZip: "Select the Codex session archive",
  saveSessionsZip: "Export Codex sessions",
  pickSaveDir: "Choose where to save",
  saveLogTitle: "Save application log",
  noDirectory: "No save folder selected",
  noItems: "No conversations selected",
  readConversationFailed: "Failed to read conversation",
  windowUnavailable: "Window unavailable",
  appStart: (version, packaged) => `app start: v${version} packaged=${packaged}`,
  startupFailed: (detail) => `startup failed: ${detail}`,
  noSavedCodexCommand: "no saved codex command; using default discovery",
  chatgptExportSummary: (saved, failed, directory) => `Saved ${saved} conversation file(s) to ${directory}${failed ? `, ${failed} failed` : ""}`,
  codexExportSummary: (saved, failed, directory) => `Saved ${saved} task file(s) to ${directory}${failed ? `, ${failed} failed` : ""}`,
  codexConnectedLocal: "Connected to the local Codex App Server",
  codexConnectedBundled: "Connected automatically to the bundled App Server of the ChatGPT/Codex desktop client",
  codexNotFound: "ChatGPT/Codex desktop client or a usable Codex App Server was not found",
  downloadedWaitBatch: "Update downloaded — it will install automatically once batch operations finish",
  taskMissing: "Task not found",
  taskStateChanged: "Task state has changed — preview again",
  deleteConfirmationExpired: "Delete confirmation expired — preview again",
  taskRunning: "Running tasks cannot be modified in bulk",
  syncFailed: "Sync failed",
  batchFailed: "Batch operation failed",
  accountReadFailed: "Could not read ChatGPT accounts",
  invalidAccountList: "The browser returned an invalid account list",
  unrecognizedAccountList: "The browser returned an unrecognized account list",
  invalidConversationList: "The browser returned an invalid conversation list",
  unrecognizedConversations: (count) => `The browser returned ${count} unrecognized conversations; the local cache was kept`,
  unnamedTask: "Untitled task",
  unnamedConversation: "Untitled conversation",
  projectMissing: "Target project is missing",
  macUpdateAvailable: (version) => `New version v${version} is available`,
  macInstallNoPermission: "The app folder is not writable, so the update cannot be installed automatically. Install manually from the download page."
};

export const MAIN_STRINGS: Record<AppLanguage, MainStrings> = { zh, en };
