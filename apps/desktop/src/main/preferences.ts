import { app, dialog, ipcMain, nativeTheme, type BrowserWindow } from "electron";
import { Worker } from "node:worker_threads";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { M } from "./language.js";
import { logInfo } from "./logger.js";
import { requireRenderer } from "./ipc-sanitize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 会话打包/导入在 worker 线程执行：zipSync/unzipSync 是 CPU 密集的同步操作，
// 跑在主进程会阻塞事件循环导致应用"未响应"。打包后的 worker 文件（自包含 bundle）
// 通过 extraResources 放在 resources 目录——worker_threads 无法从 asar 内加载。
interface ArchiveProgress { phase?: string; files?: number }
function workerScriptPath(): string { return app.isPackaged ? join(process.resourcesPath, "archive-worker.js") : join(__dirname, "archive-worker.js"); }
function runArchiveWorker<T>(job: Record<string, unknown>, onProgress?: (progress: ArchiveProgress) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (settleResolve: (value: T) => void, value: T): void => { if (settled) return; settled = true; worker.terminate(); settleResolve(value); };
    const fail = (error: Error): void => { if (settled) return; settled = true; worker.terminate(); reject(error); };
    const worker = new Worker(workerScriptPath(), { workerData: job });
    worker.on("message", (message: { type?: string; phase?: string; files?: number } & Record<string, unknown>) => {
      if (message.type === "progress") onProgress?.({ phase: message.phase, files: message.files });
      else if (message.type === "done") settle(resolve, message as T);
      else if (message.type === "error") fail(new Error(String(message.message ?? "archive worker failed")));
    });
    worker.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => { if (!settled) fail(new Error(`archive worker exited unexpectedly (code ${code})`)); });
  });
}

// 偏好设置与数据备份类 handler：主题、开机启动、数据导出/恢复、Codex 会话迁移、目录选择。
// main.ts 注入窗口引用用于弹窗与发送方校验；导入完成后通过 reloadIndex 重载内存中的
// 会话索引，避免后续 #save() 用旧内存状态覆盖刚导入的数据。
let getWindow: () => BrowserWindow | null = () => null;
let reloadIndex: () => Promise<void> = async () => {};
export function initPreferences(deps: { getMainWindow: () => BrowserWindow | null; reloadIndex: () => Promise<void> }): void {
  getWindow = deps.getMainWindow;
  reloadIndex = deps.reloadIndex;
}

export type ThemePreference = "system" | "light" | "dark";
export async function loadThemePreference(): Promise<ThemePreference> { try { const raw = JSON.parse(await readFile(join(app.getPath("userData"), "theme-preferences.json"), "utf8")) as { theme?: unknown }; return raw.theme === "light" || raw.theme === "dark" || raw.theme === "system" ? raw.theme : "system"; } catch { return "system"; } }

const BACKUP_FILES = ["conversation-index.json", "update-preferences.json", "theme-preferences.json", "language-preferences.json", "codex-command.json"];

export function registerPreferenceHandlers(): void {
  ipcMain.handle("dialog:pick-directory", async (event, value) => {
    requireRenderer(event); if (!getWindow()) throw new Error(M().windowUnavailable);
    const input = value && typeof value === "object" ? value as { defaultPath?: unknown } : {};
    const defaultPath = typeof input.defaultPath === "string" && input.defaultPath ? input.defaultPath : undefined;
    const result = await dialog.showOpenDialog(getWindow()!, { title: M().pickSaveDir, defaultPath, properties: ["openDirectory", "createDirectory"] });
    return { directory: result.canceled || !result.filePaths[0] ? null : result.filePaths[0] };
  });
  ipcMain.handle("startup:get", (event) => { requireRenderer(event); return app.getLoginItemSettings().openAtLogin; });
  ipcMain.handle("startup:set", (event, value) => {
    requireRenderer(event);
    if (typeof value !== "boolean") throw new Error("Invalid startup preference");
    try { app.setLoginItemSettings({ openAtLogin: value }); } catch {}
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle("data:export", async (event, value) => {
    requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : null;
    if (!directory) throw new Error(M().noDirectory);
    await mkdir(directory, { recursive: true });
    const userData = app.getPath("userData");
    let copied = 0;
    for (const file of BACKUP_FILES) { try { await copyFile(join(userData, file), join(directory, file)); copied += 1; } catch {} }
    return { copied, directory };
  });
  ipcMain.handle("data:import", async (event, value) => {
    requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : null;
    if (!directory) throw new Error(M().noDirectory);
    const userData = app.getPath("userData");
    let restored = 0;
    for (const file of BACKUP_FILES) { try { await copyFile(join(directory, file), join(userData, file)); restored += 1; } catch {} }
    if (restored) await reloadIndex();
    return { restored };
  });
  ipcMain.handle("codex:export-sessions-archive", async (event) => {
    requireRenderer(event);
    if (!getWindow()) throw new Error(M().windowUnavailable);
    const result = await dialog.showSaveDialog(getWindow()!, { title: M().saveSessionsZip, defaultPath: `codex-sessions-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (result.canceled || !result.filePath) return { cancelled: true };
    // 打包在 worker 线程执行：数百 MB 的压缩若跑在主进程会阻塞事件循环导致应用"未响应"
    const result2 = await runArchiveWorker<{ count: number }>({ mode: "export", codexHome: join(homedir(), ".codex"), outFile: result.filePath }, (progress) => {
      getWindow()?.webContents.send("codex:archive-progress", progress);
    });
    if (!result2.count) return { cancelled: false, count: 0 };
    logInfo(`codex sessions archive: exported ${result2.count} sessions -> ${result.filePath}`);
    return { cancelled: false, count: result2.count, file: result.filePath };
  });
  ipcMain.handle("codex:import-sessions-archive", async (event) => {
    requireRenderer(event);
    if (!getWindow()) throw new Error(M().windowUnavailable);
    const result = await dialog.showOpenDialog(getWindow()!, { title: M().pickSessionsZip, properties: ["openFile"], filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    const { imported, skipped } = await runArchiveWorker<{ imported: number; skipped: number }>({ mode: "import", codexHome: join(homedir(), ".codex"), zipPath: result.filePaths[0] });
    logInfo(`codex sessions archive: imported ${imported}, skipped ${skipped}`);
    return { cancelled: false, imported, skipped };
  });
  ipcMain.handle("theme:get", (event) => { requireRenderer(event); return nativeTheme.themeSource; });
  ipcMain.handle("theme:set", async (event, value) => { requireRenderer(event); if (value !== "system" && value !== "light" && value !== "dark") throw new Error("Invalid theme preference"); nativeTheme.themeSource = value; await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "theme-preferences.json"), `${JSON.stringify({ theme: value }, null, 2)}\n`, "utf8"); return nativeTheme.themeSource; });
}
