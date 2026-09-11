import { app, dialog, ipcMain, nativeTheme, type BrowserWindow } from "electron";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSessionsArchive, extractSessionsArchive } from "./codex-sessions-archive.js";
import { M } from "./language.js";
import { logInfo } from "./logger.js";
import { requireRenderer } from "./ipc-sanitize.js";

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
    const { zip, count } = await buildSessionsArchive(join(homedir(), ".codex"));
    if (!count) return { cancelled: false, count: 0 };
    await writeFile(result.filePath, zip);
    logInfo(`codex sessions archive: exported ${count} sessions -> ${result.filePath}`);
    return { cancelled: false, count, file: result.filePath };
  });
  ipcMain.handle("codex:import-sessions-archive", async (event) => {
    requireRenderer(event);
    if (!getWindow()) throw new Error(M().windowUnavailable);
    const result = await dialog.showOpenDialog(getWindow()!, { title: M().pickSessionsZip, properties: ["openFile"], filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    const zip = new Uint8Array(await readFile(result.filePaths[0]));
    const { imported, skipped } = await extractSessionsArchive(zip, join(homedir(), ".codex"));
    logInfo(`codex sessions archive: imported ${imported}, skipped ${skipped}`);
    return { cancelled: false, imported, skipped };
  });
  ipcMain.handle("theme:get", (event) => { requireRenderer(event); return nativeTheme.themeSource; });
  ipcMain.handle("theme:set", async (event, value) => { requireRenderer(event); if (value !== "system" && value !== "light" && value !== "dark") throw new Error("Invalid theme preference"); nativeTheme.themeSource = value; await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "theme-preferences.json"), `${JSON.stringify({ theme: value }, null, 2)}\n`, "utf8"); return nativeTheme.themeSource; });
}
