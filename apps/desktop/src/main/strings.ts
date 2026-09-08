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
  codexExportSummary: (saved, failed, directory) => `已保存 ${saved} 个任务文件到 ${directory}${failed ? `，失败 ${failed} 条` : ""}`
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
  codexExportSummary: (saved, failed, directory) => `Saved ${saved} task file(s) to ${directory}${failed ? `, ${failed} failed` : ""}`
};

export const MAIN_STRINGS: Record<AppLanguage, MainStrings> = { zh, en };
