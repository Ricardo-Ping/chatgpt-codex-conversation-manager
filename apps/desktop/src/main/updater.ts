import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import electronUpdater from "electron-updater";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { downloadMacArchive, fetchMacRelease, macAppBundlePath, swapMacBundle, type MacUpdateCheck } from "./mac-updater.js";
import { DEFAULT_AUTO_UPDATE, isUpdateInstallSafe, parseAutoUpdatePreference, supportsAutomaticInstallation } from "./update-policy.js";
import { M } from "./language.js";
import { logWarn } from "./logger.js";

const { autoUpdater } = electronUpdater;

export const RELEASE_URL = "https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let autoUpdateEnabled = DEFAULT_AUTO_UPDATE;
let updateStartupTimer: NodeJS.Timeout | null = null;
let updateInterval: NodeJS.Timeout | null = null;
let updateInstallTimer: NodeJS.Timeout | null = null;
let macRelease: MacUpdateCheck | null = null;
let macArchivePath: string | null = null;
const canAutoInstallUpdate = supportsAutomaticInstallation(app.isPackaged, process.platform, process.env.PORTABLE_EXECUTABLE_FILE);
let updateState = { phase: app.isPackaged ? "idle" : "unsupported", currentVersion: app.getVersion(), version: null as string | null, percent: null as number | null, message: M().idle, autoUpdate: true, canAutoInstall: canAutoInstallUpdate };

let getWindow: () => BrowserWindow | null = () => null;
// 桌面端在批量操作进行中时不退出安装，main 注入当前进行中的批量数
let getActiveBatchCount: () => number = () => 0;

export function initUpdater(deps: { getMainWindow: () => BrowserWindow | null; getActiveBatchCount: () => number }): void {
  getWindow = deps.getMainWindow;
  getActiveBatchCount = deps.getActiveBatchCount;
}

function publishUpdateState(patch: Partial<typeof updateState>): void { updateState = { ...updateState, ...patch }; getWindow()?.webContents.send("update:state", updateState); }
async function loadUpdatePreference(): Promise<boolean> { for (const file of [join(app.getPath("userData"), "update-preferences.json"), join(app.getPath("appData"), "CGN Desktop", "update-preferences.json")]) { try { return parseAutoUpdatePreference((JSON.parse(await readFile(file, "utf8")) as { autoUpdate?: unknown }).autoUpdate); } catch {} } return DEFAULT_AUTO_UPDATE; }
async function saveUpdatePreference(value: boolean): Promise<void> { await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "update-preferences.json"), `${JSON.stringify({ autoUpdate: value }, null, 2)}\n`, "utf8"); }
async function checkForUpdates(): Promise<void> { if (!app.isPackaged || ["checking", "downloading"].includes(updateState.phase)) return; if (process.platform === "darwin") return void checkMacRelease(); publishUpdateState({ phase: "checking", percent: null, message: M().checking }); try { await autoUpdater.checkForUpdates(); } catch { publishUpdateState({ phase: "error", message: M().updateError }); } }
function macAppBundle(): string | null { const bundle = macAppBundlePath(app.getPath("exe")); if (!bundle) return null; try { accessSync(dirname(bundle), fsConstants.W_OK); accessSync(bundle, fsConstants.W_OK); return bundle; } catch { return null; } }
async function checkMacRelease(): Promise<void> {
  publishUpdateState({ phase: "checking", percent: null, message: M().checking });
  try {
    const release = await fetchMacRelease(app.getVersion());
    if (!release) { macRelease = null; publishUpdateState({ phase: "not-available", version: null, percent: null, message: M().upToDate }); return; }
    macRelease = release;
    publishUpdateState({ phase: "available", version: release.version, percent: null, message: M().macUpdateAvailable(release.version) });
    if (autoUpdateEnabled) void downloadMacRelease();
  } catch { publishUpdateState({ phase: "error", message: M().updateError }); }
}
async function downloadMacRelease(): Promise<void> {
  if (process.platform !== "darwin" || !app.isPackaged) throw new Error(M().updateNotReady);
  if (updateState.phase === "downloading") return;
  if (!macRelease) { await checkMacRelease(); if (!macRelease) throw new Error(M().updateNotReady); }
  const bundle = macAppBundle();
  if (!bundle) { publishUpdateState({ phase: "error", message: M().macInstallNoPermission }); return; }
  publishUpdateState({ phase: "downloading", percent: 0, message: M().downloadProgress(0) });
  try {
    const archiveDir = join(app.getPath("userData"), "mac-updates");
    await rm(archiveDir, { recursive: true, force: true });
    const archivePath = await downloadMacArchive(macRelease, archiveDir, (percent) => publishUpdateState({ phase: "downloading", percent, message: M().downloadProgress(percent) }));
    macArchivePath = archivePath;
    publishUpdateState({ phase: "downloaded", version: macRelease.version, percent: 100, message: autoUpdateEnabled ? M().downloadedAuto(macRelease.version) : M().downloadedManual(macRelease.version) });
    if (autoUpdateEnabled) scheduleMacInstall();
  } catch { publishUpdateState({ phase: "error", message: M().updateError }); }
}
function scheduleMacInstall(): void {
  if (updateInstallTimer) return;
  updateInstallTimer = setTimeout(() => {
    updateInstallTimer = null;
    if (updateState.phase === "downloaded" && macArchivePath && getActiveBatchCount() === 0) startMacInstall();
    else if (updateState.phase === "downloaded" && autoUpdateEnabled) { publishUpdateState({ message: M().downloadedWaitBatch }); scheduleMacInstall(); }
  }, 5_000);
  updateInstallTimer.unref();
}
function startMacInstall(): void {
  if (process.platform !== "darwin" || !macArchivePath || updateState.phase !== "downloaded") throw new Error(M().updateNotReady);
  const bundle = macAppBundle();
  if (!bundle) { publishUpdateState({ phase: "error", message: M().macInstallNoPermission }); return; }
  void swapMacBundle(macArchivePath, bundle).then(() => { app.relaunch(); app.quit(); }).catch(() => publishUpdateState({ phase: "error", message: M().updateError }));
}
export function scheduleAutomaticUpdates(): void { if (updateStartupTimer) clearTimeout(updateStartupTimer); if (updateInterval) clearInterval(updateInterval); updateStartupTimer = null; updateInterval = null; if (!app.isPackaged || !autoUpdateEnabled) return; updateStartupTimer = setTimeout(() => void checkForUpdates(), 10_000); updateInterval = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS); updateStartupTimer.unref(); updateInterval.unref(); }
function scheduleUpdateInstall(): void {
  if (updateInstallTimer) return;
  updateInstallTimer = setTimeout(() => {
    updateInstallTimer = null;
    if (isUpdateInstallSafe(updateState.phase, getActiveBatchCount())) autoUpdater.quitAndInstall(true, true);
    else if (updateState.phase === "downloaded" && autoUpdateEnabled) { publishUpdateState({ message: M().downloadedWaitBatch }); scheduleUpdateInstall(); }
  }, 5_000);
  updateInstallTimer.unref();
}
function configureUpdater(): void {
  autoUpdater.allowPrerelease = app.getVersion().includes("-"); autoUpdater.autoDownload = canAutoInstallUpdate; autoUpdater.autoInstallOnAppQuit = canAutoInstallUpdate; autoUpdater.logger = null;
  autoUpdater.on("checking-for-update", () => publishUpdateState({ phase: "checking", percent: null, message: M().checking }));
  autoUpdater.on("update-available", (info) => publishUpdateState({ phase: "available", version: info.version, message: canAutoInstallUpdate ? M().downloadingUpdate(info.version) : M().downloadedManual(info.version) }));
  autoUpdater.on("update-not-available", (info) => publishUpdateState({ phase: "not-available", version: info.version, percent: null, message: M().upToDate }));
  autoUpdater.on("download-progress", (progress) => publishUpdateState({ phase: "downloading", percent: Math.round(progress.percent), message: M().downloadProgress(Math.round(progress.percent)) }));
  autoUpdater.on("update-downloaded", (info) => {
    if (canAutoInstallUpdate && autoUpdateEnabled) {
      publishUpdateState({ phase: "downloaded", version: info.version, percent: 100, message: M().downloadedAuto(info.version) });
      scheduleUpdateInstall();
    } else {
      publishUpdateState({ phase: "downloaded", version: info.version, percent: 100, message: M().downloadedManual(info.version) });
    }
  });
  autoUpdater.on("error", (error) => { logWarn(`updater error: ${error?.message ?? error}`); publishUpdateState({ phase: "error", message: M().updateError }); });
}
export function refreshUpdateMessage(): void {
  if (updateState.phase === "checking") publishUpdateState({ message: M().checking });
  else if (updateState.phase === "downloading") publishUpdateState({ message: M().downloadProgress(updateState.percent ?? 0) });
  else if (updateState.phase === "downloaded") publishUpdateState({ message: autoUpdateEnabled && canAutoInstallUpdate ? M().downloadedAuto(updateState.version ?? "") : M().downloadedManual(updateState.version ?? "") });
  else if (updateState.phase === "available") publishUpdateState({ message: canAutoInstallUpdate ? M().downloadingUpdate(updateState.version ?? "") : M().downloadedManual(updateState.version ?? "") });
  else if (updateState.phase === "not-available") publishUpdateState({ message: M().upToDate });
  else if (updateState.phase === "error") publishUpdateState({ message: M().updateError });
  else if (updateState.phase === "idle") publishUpdateState({ message: M().idle });
}
export async function applyStartupUpdatePreferences(): Promise<void> { autoUpdateEnabled = await loadUpdatePreference(); updateState = { ...updateState, currentVersion: app.getVersion(), autoUpdate: autoUpdateEnabled }; configureUpdater(); }
export function shutdownUpdaterTimers(): void { if (updateStartupTimer) clearTimeout(updateStartupTimer); if (updateInterval) clearInterval(updateInterval); if (updateInstallTimer) clearTimeout(updateInstallTimer); }
export function registerUpdateHandlers(): void {
  ipcMain.handle("update:get-state", (event) => { requireUpdateSender(event); return updateState; });
  ipcMain.handle("update:set-auto", async (event, value) => { requireUpdateSender(event); if (typeof value !== "boolean") throw new Error("Invalid update preference"); await saveUpdatePreference(value); autoUpdateEnabled = value; if (updateInstallTimer) { clearTimeout(updateInstallTimer); updateInstallTimer = null; } publishUpdateState({ autoUpdate: value, ...(value && updateState.phase === "downloaded" && canAutoInstallUpdate ? { message: M().downloadedAuto(updateState.version ?? "") } : {}) }); scheduleAutomaticUpdates(); if (value && updateState.phase === "downloaded" && canAutoInstallUpdate) scheduleUpdateInstall(); else if (value) void checkForUpdates(); return updateState; });
  ipcMain.handle("update:check", async (event) => { requireUpdateSender(event); await checkForUpdates(); return updateState; });
  ipcMain.handle("update:download", async (event) => { requireUpdateSender(event); await downloadMacRelease(); return updateState; });
  ipcMain.handle("update:install", (event) => {
    requireUpdateSender(event);
    if (process.platform === "darwin") { if (!macArchivePath || updateState.phase !== "downloaded") throw new Error(M().updateNotReady); if (getActiveBatchCount() > 0) throw new Error(M().installWaitBatch); startMacInstall(); return updateState; }
    if (!canAutoInstallUpdate || !isUpdateInstallSafe(updateState.phase, getActiveBatchCount())) throw new Error(getActiveBatchCount() ? M().installWaitBatch : M().updateNotReady);
    autoUpdater.quitAndInstall(true, true);
  });
  ipcMain.handle("update:open-release", async (event) => { requireUpdateSender(event); await shell.openExternal(RELEASE_URL); });
}

// 更新类 handler 的发送方校验与 ipc-sanitize#requireRenderer 相同；窗口 getter 由 initUpdater 注入
function requireUpdateSender(event: IpcMainInvokeEvent): void { if (!getWindow() || event.sender !== getWindow()!.webContents) throw new Error("Untrusted IPC sender"); }
