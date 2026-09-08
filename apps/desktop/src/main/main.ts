import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronUpdater from "electron-updater";
import { ChatGptBridgeServer, ConversationIndexStore, chooseCacheSyncMode, type CachedConversation } from "@conversation-manager/chatgpt-bridge-server";
import { CodexAppServer } from "@conversation-manager/codex-app-server-adapter";
import { discoverCodexCommands } from "./codex-discovery.js";
import { DEFAULT_AUTO_UPDATE, isUpdateInstallSafe, parseAutoUpdatePreference, supportsAutomaticInstallation } from "./update-policy.js";
import { initLogger, logInfo, logWarn, onLogLine, readLogs, clearLogs, saveLogsTo } from "./logger.js";
import { loadLanguagePreference, saveLanguagePreference, type AppLanguage } from "./language.js";
import { MAIN_STRINGS } from "./strings.js";
import { chatgptTranscriptMarkdown, codexMetadataMarkdown, codexTranscriptMarkdown, codexTurnsFromPayload, safeFileName } from "./export.js";

const { autoUpdater } = electronUpdater;
const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASE_URL = "https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases";
const CHATGPT_URL = "https://chatgpt.com/";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
let codexCommand = "codex";
let codex = new CodexAppServer(codexCommand);
let codexConnection: Promise<boolean> | null = null;
let mainWindow: BrowserWindow | null = null;
let bridge: ChatGptBridgeServer;
let indexStore: ConversationIndexStore;
let autoUpdateEnabled = DEFAULT_AUTO_UPDATE;
let updateStartupTimer: NodeJS.Timeout | null = null;
let updateInterval: NodeJS.Timeout | null = null;
let updateInstallTimer: NodeJS.Timeout | null = null;
let currentChatBatchId: string | null = null;
let activeBatchCount = 0;
const confirmations = new Map<string, { source: "chatgpt" | "codex"; ids: string[]; fingerprint?: string; expiresAt: number }>();
const canAutoInstallUpdate = supportsAutomaticInstallation(app.isPackaged, process.platform, process.env.PORTABLE_EXECUTABLE_FILE);
let LANG: AppLanguage = "zh";
const M = () => MAIN_STRINGS[LANG];
let updateState = { phase: app.isPackaged ? "idle" : "unsupported", currentVersion: app.getVersion(), version: null as string | null, percent: null as number | null, message: M().idle, autoUpdate: true, canAutoInstall: canAutoInstallUpdate };

function requireRenderer(event: IpcMainInvokeEvent): void { if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Untrusted IPC sender"); }
function requireId(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new Error("Invalid conversation ID"); return value; }
function requireAccount(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid account key"); return value; }
function requireIds(value: unknown): string[] { if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new Error("Invalid selection"); return [...new Set(value.map(requireId))].sort(); }
function requireState(value: unknown): CachedConversation["state"] { if (value !== "active" && value !== "archived" && value !== "scheduled") throw new Error("Invalid state"); return value; }

let logUnsubscribe: (() => void) | null = null;
async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 760, minHeight: 560, title: "Conversation Manager", autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c181b" : "#f4f8f7", webPreferences: { preload: join(__dirname, "..", "..", "src", "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"), { query: { lang: LANG } }); mainWindow.on("closed", () => { mainWindow = null; });
  if (logUnsubscribe) logUnsubscribe();
  logUnsubscribe = onLogLine((line) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("log:appended", line); });
}

function publishUpdateState(patch: Partial<typeof updateState>): void { updateState = { ...updateState, ...patch }; mainWindow?.webContents.send("update:state", updateState); }
async function loadUpdatePreference(): Promise<boolean> { for (const file of [join(app.getPath("userData"), "update-preferences.json"), join(app.getPath("appData"), "CGN Desktop", "update-preferences.json")]) { try { return parseAutoUpdatePreference((JSON.parse(await readFile(file, "utf8")) as { autoUpdate?: unknown }).autoUpdate); } catch {} } return DEFAULT_AUTO_UPDATE; }
async function saveUpdatePreference(value: boolean): Promise<void> { await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "update-preferences.json"), `${JSON.stringify({ autoUpdate: value }, null, 2)}\n`, "utf8"); }
async function connectCodex(): Promise<boolean> {
  if (codexConnection) return codexConnection;
  codexConnection = (async () => {
    try { await codex.start(); return true; } catch {}
    for (const command of await discoverCodexCommands()) {
      if (command === codexCommand) continue;
      const candidate = new CodexAppServer(command);
      try {
        await candidate.start(); codex.close(); codex = candidate; codexCommand = command;
        await writeFile(join(app.getPath("userData"), "codex-command.json"), `${JSON.stringify({ command }, null, 2)}\n`, "utf8");
        return true;
      } catch { candidate.close(); }
    }
    return false;
  })();
  try { return await codexConnection; } finally { codexConnection = null; }
}
async function checkForUpdates(): Promise<void> { if (!app.isPackaged || ["checking", "downloading"].includes(updateState.phase)) return; publishUpdateState({ phase: "checking", percent: null, message: M().checking }); try { await autoUpdater.checkForUpdates(); } catch { publishUpdateState({ phase: "error", message: M().updateError }); } }
function scheduleAutomaticUpdates(): void { if (updateStartupTimer) clearTimeout(updateStartupTimer); if (updateInterval) clearInterval(updateInterval); updateStartupTimer = null; updateInterval = null; if (!app.isPackaged || !autoUpdateEnabled) return; updateStartupTimer = setTimeout(() => void checkForUpdates(), 10_000); updateInterval = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS); updateStartupTimer.unref(); updateInterval.unref(); }
function scheduleUpdateInstall(): void {
  if (updateInstallTimer) return;
  updateInstallTimer = setTimeout(() => {
    updateInstallTimer = null;
    if (isUpdateInstallSafe(updateState.phase, activeBatchCount)) autoUpdater.quitAndInstall(true, true);
    else if (updateState.phase === "downloaded" && autoUpdateEnabled) { publishUpdateState({ message: "更新已下载，将在批量操作完成后自动安装" }); scheduleUpdateInstall(); }
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

ipcMain.handle("app:version", (event) => { requireRenderer(event); return app.getVersion(); });
ipcMain.handle("external:open", async (event, value) => { requireRenderer(event); if (value !== CHATGPT_URL && value !== RELEASE_URL && value !== "https://developers.openai.com/codex/app-server") throw new Error("URL not allowed"); await shell.openExternal(value); });
ipcMain.handle("chatgpt:state", (event) => { requireRenderer(event); return bridge.state(); });
ipcMain.handle("chatgpt:pair", (event) => { requireRenderer(event); return bridge.beginPairing(); });
ipcMain.handle("chatgpt:clear-pairing", async (event) => { requireRenderer(event); await bridge.clearPairing(); return bridge.state(); });
ipcMain.handle("chatgpt:open", async (event) => { requireRenderer(event); await shell.openExternal(CHATGPT_URL); });
ipcMain.handle("chatgpt:open-conversation", async (event, value) => { requireRenderer(event); await shell.openExternal(`${CHATGPT_URL}c/${requireId(value)}`); });
ipcMain.handle("chatgpt:show-extension", (event) => { requireRenderer(event); const directory = app.isPackaged ? join(process.resourcesPath, "chatgpt-browser-bridge-extension") : join(app.getAppPath(), "..", "..", "packages", "chatgpt-browser-bridge-extension"); shell.showItemInFolder(join(directory, "manifest.json")); return directory; });
ipcMain.handle("chatgpt:accounts", async (event) => { requireRenderer(event); const result = await bridge.request("accounts", {}); if (!result.ok) throw new Error(result.error?.message || "无法读取 ChatGPT 账号"); return sanitizeAccounts(result.payload); });
ipcMain.handle("chatgpt:cached-accounts", (event) => { requireRenderer(event); return { accounts: indexStore.accounts().map((item) => ({ ...item, isDefault: false })) }; });
ipcMain.handle("chatgpt:cache", (event, value) => { requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; return indexStore.read(requireAccount(input.accountKey), requireState(input.state)); });
ipcMain.handle("chatgpt:list", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const accountKey = requireAccount(input.accountKey); const state = requireState(input.state); const label = typeof input.label === "string" ? input.label.slice(0, 100) : "ChatGPT 账号"; const cached = indexStore.read(accountKey, state); const mode = chooseCacheSyncMode(cached, input.full === true);
  const result = await bridge.request("list", { accountKey, state, mode, checkpoint: mode === "full" ? null : cached?.records[0]?.updatedAt ?? null }, 180_000); if (!result.ok) throw new Error(result.error?.message || "同步失败");
  const payload = result.payload as { records?: unknown; full?: boolean }; const records = sanitizeRecords(payload.records, state); const calibrated = mode === "full" || payload.full === true; if (calibrated) await indexStore.replace(accountKey, label, state, records, true); else await indexStore.merge(accountKey, label, state, records); const snapshot = indexStore.read(accountKey, state); return snapshot ? { ...snapshot, syncMode: calibrated ? "full" : "incremental" } : null;
});
ipcMain.handle("chatgpt:preview-delete", (event, value) => { requireRenderer(event); const ids = requireIds(value); return { confirmationToken: rememberConfirmation("chatgpt", ids) }; });
ipcMain.handle("chatgpt:batch", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const action = input.action; if (action !== "archive" && action !== "restore" && action !== "delete") throw new Error("Invalid batch action"); const ids = requireIds(input.ids); const accountKey = requireAccount(input.accountKey); if (action === "delete") validateConfirmation("chatgpt", ids, input.confirmationToken);
  const operationId = randomUUID(); currentChatBatchId = operationId;
  activeBatchCount += 1;
  try { const result = await bridge.request("batch", { accountKey, action, ids, requestId: operationId }, 300_000); if (!result.ok) throw new Error(result.error?.message || "批量操作失败"); const payload = result.payload as { succeeded?: string[]; failed?: Array<{ id: string; message: string }>; unprocessed?: string[] }; const succeeded = Array.isArray(payload.succeeded) ? payload.succeeded.map(requireId) : []; await indexStore.apply(accountKey, action, succeeded); return { succeeded, failed: Array.isArray(payload.failed) ? payload.failed : [], unprocessed: Array.isArray(payload.unprocessed) ? payload.unprocessed : [] }; } finally { activeBatchCount -= 1; if (currentChatBatchId === operationId) currentChatBatchId = null; }
});
ipcMain.handle("chatgpt:cancel", async (event) => { requireRenderer(event); if (!currentChatBatchId) return { cancelled: false }; const result = await bridge.request("cancel", { requestId: currentChatBatchId }); return { cancelled: result.ok }; });
ipcMain.handle("chatgpt:cache-stats", (event) => { requireRenderer(event); return indexStore.stats(); });
ipcMain.handle("chatgpt:clear-cache", async (event) => { requireRenderer(event); await indexStore.clear(); return indexStore.stats(); });
ipcMain.handle("dialog:pick-directory", async (event) => { requireRenderer(event); if (!mainWindow) throw new Error(M().windowUnavailable); const result = await dialog.showOpenDialog(mainWindow, { title: M().pickSaveDir, properties: ["openDirectory", "createDirectory"] }); return { directory: result.canceled || !result.filePaths[0] ? null : result.filePaths[0] }; });
ipcMain.handle("chatgpt:export", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const accountKey = requireAccount(input.accountKey);
  const directory = typeof input.directory === "string" && input.directory ? input.directory : null;
  if (!directory) throw new Error(M().noDirectory);
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const items = rawItems.map((item) => { const row = item && typeof item === "object" ? item as Record<string, unknown> : {}; return { id: requireId(row.id), title: typeof row.title === "string" ? row.title.slice(0, 120) : "" }; });
  if (!items.length) throw new Error(M().noItems);
  await mkdir(directory, { recursive: true });
  let saved = 0; const failed: Array<{ id: string; message: string }> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (!item) break;
      try {
        const result = await bridge.request("read", { accountKey, id: item.id }, 120_000);
        if (!result.ok) throw new Error(result.error?.message || M().readConversationFailed);
        const payload = result.payload as { title?: unknown; messages?: unknown };
        const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
        const messages = rawMessages.map((message) => { const row = message && typeof message === "object" ? message as Record<string, unknown> : {}; return { role: typeof row.role === "string" ? row.role : "other", at: typeof row.at === "number" ? row.at : null, text: typeof row.text === "string" ? row.text : "" }; });
        const transcript = { id: item.id, title: typeof payload.title === "string" ? payload.title.slice(0, 200) : item.title, messages };
        const markdown = chatgptTranscriptMarkdown(transcript, Date.now(), "ChatGPT");
        await writeFile(join(directory, safeFileName(transcript.title || item.title, item.id)), markdown, "utf8");
        saved += 1;
      } catch (error) { failed.push({ id: item.id, message: error instanceof Error ? error.message : String(error) }); }
    }
  });
  await Promise.all(workers);
  logInfo(`chatgpt export: saved ${saved}, failed ${failed.length}`);
  return { saved, failed, directory };
});
ipcMain.handle("codex:export", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const directory = typeof input.directory === "string" && input.directory ? input.directory : null;
  if (!directory) throw new Error(M().noDirectory);
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const items = rawItems.map((item) => { const row = item && typeof item === "object" ? item as Record<string, unknown> : {}; return { id: requireId(row.id), title: typeof row.title === "string" ? row.title.slice(0, 120) : "", preview: typeof row.preview === "string" ? row.preview.slice(0, 500) : "", cwd: typeof row.cwd === "string" ? row.cwd : null }; });
  if (!items.length) throw new Error(M().noItems);
  await mkdir(directory, { recursive: true });
  let saved = 0; const failed: Array<{ id: string; message: string }> = [];
  for (const item of items) {
    try {
      const threadMeta = threadLike(item);
      let markdown: string;
      try {
        const payload = await codex.readThread(item.id);
        const turns = codexTurnsFromPayload(payload);
        const thread = threadPayload(payload, item);
        markdown = codexTranscriptMarkdown(thread, turns, Date.now());
      } catch (readError) {
        markdown = codexMetadataMarkdown(threadMeta, readError instanceof Error ? readError.message : String(readError), Date.now());
      }
      await writeFile(join(directory, safeFileName(threadMeta.name?.trim() || item.title, item.id)), markdown, "utf8");
      saved += 1;
    } catch (error) { failed.push({ id: item.id, message: error instanceof Error ? error.message : String(error) }); }
  }
  logInfo(`codex export: saved ${saved}, failed ${failed.length}`);
  return { saved, failed, directory };
});
function threadPayload(payload: unknown, item: { id: string; title: string; preview: string; cwd: string | null }): { id: string; name?: string; preview?: string; cwd?: string | null } {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const thread = root.thread && typeof root.thread === "object" ? root.thread as Record<string, unknown> : root;
  const text = (v: unknown) => typeof v === "string" ? v : undefined;
  return { id: item.id, name: text(thread.name) ?? (item.title || undefined), preview: text(thread.preview) ?? item.preview, cwd: text(thread.cwd) ?? item.cwd ?? null };
}
function threadLike(item: { id: string; title: string; preview: string; cwd: string | null }): { id: string; name: string | null; preview: string | null; cwd: string | null } { return { id: item.id, name: item.title || null, preview: item.preview || null, cwd: item.cwd }; }

ipcMain.handle("codex:status", async (event) => { requireRenderer(event); const available = await connectCodex(); return { available, message: available ? (codexCommand === "codex" ? "已连接本机 Codex App Server" : "已自动连接 ChatGPT/Codex 桌面客户端内置 App Server") : "未找到 ChatGPT/Codex 桌面客户端或可用的 Codex App Server", command: codexCommand }; });
ipcMain.handle("codex:select-command", async (event) => { requireRenderer(event); if (!mainWindow) throw new Error("Window unavailable"); const result = await dialog.showOpenDialog(mainWindow, { title: M().pickCodexExe, properties: ["openFile"], filters: [{ name: "Codex", extensions: ["exe", "cmd", "bat"] }] }); if (result.canceled || !result.filePaths[0]) return { selected: false, command: codexCommand }; const command = result.filePaths[0]; const candidate = new CodexAppServer(command); await candidate.start(); codex.close(); codex = candidate; codexCommand = command; await writeFile(join(app.getPath("userData"), "codex-command.json"), `${JSON.stringify({ command }, null, 2)}\n`, "utf8"); return { selected: true, command }; });
ipcMain.handle("codex:list", async (event, value) => { requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; return codex.list({ cursor: typeof input.cursor === "string" ? input.cursor : null, limit: 100, archived: input.archived === true, searchTerm: typeof input.searchTerm === "string" ? input.searchTerm.slice(0, 200) : null, full: input.full === true }); });
ipcMain.handle("codex:open", async (event, value) => { requireRenderer(event); const id = requireId(value); try { const child = process.platform === "win32" ? spawn("powershell.exe", ["-NoExit", "-EncodedCommand", Buffer.from(`& '${codexCommand.replaceAll("'", "''")}' resume '${id}'`, "utf16le").toString("base64")], { detached: true, stdio: "ignore", windowsHide: false }) : spawn(codexCommand, ["resume", id], { detached: true, stdio: "ignore" }); child.unref(); return { opened: true }; } catch { clipboard.writeText(`${codexCommand} resume ${id}`); return { opened: false, copied: true }; } });
ipcMain.handle("codex:preview-delete", async (event, value) => { requireRenderer(event); const ids = requireIds(value); const preview = await codex.previewDelete(ids); let confirmationToken: string | null = null; if (!preview.missing.length && !preview.running.length) confirmationToken = rememberConfirmation("codex", ids, preview.fingerprint); return { tasks: preview.records.map((record) => ({ id: record.id, title: record.name?.trim() || record.preview?.trim() || "未命名任务", derived: !ids.includes(record.id) })), missing: preview.missing, running: preview.running, confirmationToken }; });
ipcMain.handle("codex:batch", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const action = input.action; if (action !== "archive" && action !== "unarchive" && action !== "delete") throw new Error("Invalid batch action"); const ids = requireIds(input.ids);
  activeBatchCount += 1;
  try {
    const currentRecords = [];
    if (action === "delete") { const confirmation = validateConfirmation("codex", ids, input.confirmationToken); const current = await codex.previewDelete(ids); if (current.missing.length || current.running.length || current.fingerprint !== confirmation.fingerprint) throw new Error("任务状态已变化，请重新预览"); currentRecords.push(...current.records); }
    else { let cursor: string | null = null; do { const page = await codex.list({ archived: action === "unarchive", cursor, includeDerived: true }); currentRecords.push(...page.data); cursor = page.nextCursor; } while (cursor); }
    const currentById = new Map(currentRecords.map((thread) => [thread.id, thread]));
    const succeeded: string[] = [], failed: Array<{ id: string; message: string }> = [];
    for (const id of ids) { try { const current = currentById.get(id); if (!current) throw new Error("任务不存在"); if (current.status?.type === "active") throw new Error("运行中的任务不能批量操作"); if (action === "archive") await codex.archive(id); else if (action === "unarchive") await codex.unarchive(id); else await codex.delete(id); succeeded.push(id); } catch (error) { failed.push({ id, message: error instanceof Error ? error.message : String(error) }); } }
    return { succeeded, failed };
  } finally { activeBatchCount -= 1; }
});

ipcMain.handle("update:get-state", (event) => { requireRenderer(event); return updateState; });
ipcMain.handle("update:set-auto", async (event, value) => { requireRenderer(event); if (typeof value !== "boolean") throw new Error("Invalid update preference"); await saveUpdatePreference(value); autoUpdateEnabled = value; if (updateInstallTimer) { clearTimeout(updateInstallTimer); updateInstallTimer = null; } publishUpdateState({ autoUpdate: value, ...(value && updateState.phase === "downloaded" && canAutoInstallUpdate ? { message: M().downloadedAuto(updateState.version ?? "") } : {}) }); scheduleAutomaticUpdates(); if (value && updateState.phase === "downloaded" && canAutoInstallUpdate) scheduleUpdateInstall(); else if (value) void checkForUpdates(); return updateState; });
ipcMain.handle("update:check", async (event) => { requireRenderer(event); await checkForUpdates(); return updateState; });
ipcMain.handle("update:install", (event) => { requireRenderer(event); if (!canAutoInstallUpdate || !isUpdateInstallSafe(updateState.phase, activeBatchCount)) throw new Error(activeBatchCount ? M().installWaitBatch : M().updateNotReady); autoUpdater.quitAndInstall(true, true); });
ipcMain.handle("update:open-release", async (event) => { requireRenderer(event); await shell.openExternal(RELEASE_URL); });

type ThemePreference = "system" | "light" | "dark";
async function loadThemePreference(): Promise<ThemePreference> { try { const raw = JSON.parse(await readFile(join(app.getPath("userData"), "theme-preferences.json"), "utf8")) as { theme?: unknown }; return raw.theme === "light" || raw.theme === "dark" || raw.theme === "system" ? raw.theme : "system"; } catch { return "system"; } }
ipcMain.handle("theme:get", (event) => { requireRenderer(event); return nativeTheme.themeSource; });
ipcMain.handle("theme:set", async (event, value) => { requireRenderer(event); if (value !== "system" && value !== "light" && value !== "dark") throw new Error("Invalid theme preference"); nativeTheme.themeSource = value; await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "theme-preferences.json"), `${JSON.stringify({ theme: value }, null, 2)}\n`, "utf8"); return nativeTheme.themeSource; });
ipcMain.handle("log:read", async (event) => { requireRenderer(event); return readLogs(); });
ipcMain.handle("log:clear", async (event) => { requireRenderer(event); await clearLogs(); return true; });
ipcMain.handle("log:save", async (event) => {
  requireRenderer(event); if (!mainWindow) throw new Error(M().windowUnavailable);
  const result = await dialog.showSaveDialog(mainWindow, { title: M().saveLogTitle, defaultPath: `conversation-manager-logs-${new Date().toISOString().slice(0, 10)}.log`, filters: [{ name: "Log", extensions: ["log", "txt"] }] });
  if (result.canceled || !result.filePath) return { saved: false };
  await saveLogsTo(result.filePath);
  return { saved: true, path: result.filePath };
});
ipcMain.on("app:language-sync", (event) => { event.returnValue = LANG; });
ipcMain.handle("language:get", (event) => { requireRenderer(event); return LANG; });
ipcMain.handle("language:set", async (event, value) => { requireRenderer(event); if (value !== "zh" && value !== "en") throw new Error("Invalid language"); LANG = value; await saveLanguagePreference(app.getPath("userData"), LANG); return LANG; });

function validateConfirmation(source: "chatgpt" | "codex", ids: string[], value: unknown) { const token = typeof value === "string" ? value : ""; const confirmation = confirmations.get(token); confirmations.delete(token); if (!confirmation || confirmation.source !== source || confirmation.expiresAt < Date.now() || JSON.stringify(confirmation.ids) !== JSON.stringify(ids)) throw new Error("删除确认已过期，请重新预览"); return confirmation; }
function rememberConfirmation(source: "chatgpt" | "codex", ids: string[], fingerprint?: string): string { const now = Date.now(); for (const [token, entry] of confirmations) if (entry.expiresAt < now) confirmations.delete(token); const token = randomUUID(); confirmations.set(token, { source, ids, ...(fingerprint ? { fingerprint } : {}), expiresAt: now + 120_000 }); return token; }
function sanitizeAccounts(value: unknown) { const input = value && typeof value === "object" ? value as { accounts?: unknown } : {}; if (!Array.isArray(input.accounts) || input.accounts.length > 100) throw new Error("浏览器返回了无效账号列表"); const out: Array<{ key: string; label: string; isDefault: boolean }> = []; for (const item of input.accounts) { const row = item && typeof item === "object" ? item as Record<string, unknown> : {}; try { out.push({ key: requireAccount(row.key), label: typeof row.label === "string" ? row.label.slice(0, 100) : "ChatGPT 账号", isDefault: row.isDefault === true }); } catch {} } if (!out.length && input.accounts.length) throw new Error("浏览器返回了无法识别的账号列表"); return { accounts: out }; }
const warnedMalformedIds = new Set<string>();
function sanitizeRecords(value: unknown, state: CachedConversation["state"]): CachedConversation[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("浏览器返回了无效会话列表");
  const out: CachedConversation[] = []; let skipped = 0; let sample = "";
  for (const item of value) {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const number = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : null;
    try {
      out.push({ id: requireId(row.id), title: typeof row.title === "string" ? row.title.slice(0, 500) : "未命名会话", createdAt: number(row.createdAt), updatedAt: number(row.updatedAt), state, ...(typeof row.projectId === "string" && row.projectId.length <= 128 ? { projectId: row.projectId } : {}), pinned: row.pinned === true, current: row.current === true, automation: state === "scheduled" });
    } catch {
      skipped += 1;
      if (!sample && typeof row.id === "string") sample = `${row.id.slice(0, 12)}…(len ${row.id.length})`;
    }
  }
  if (!out.length && value.length) throw new Error(`浏览器返回了 ${value.length} 条无法识别的会话记录，已保留本地缓存`);
  if (skipped && !warnedMalformedIds.has(sample)) { warnedMalformedIds.add(sample); logWarn(`[chatgpt-bridge] skipped ${skipped} malformed conversation rows, sample id: ${sample || "unknown"}`); }
  return out;
}
// 开发/测试时可用 CM_USER_DATA_DIR 指向独立目录，避免与已安装实例共享单实例锁和缓存（必须在锁之前设置）
if (!app.isPackaged && process.env.CM_USER_DATA_DIR) app.setPath("userData", process.env.CM_USER_DATA_DIR);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else app.on("second-instance", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
if (app.isPackaged) { app.setAsDefaultProtocolClient("conversation-manager"); app.setAsDefaultProtocolClient("cgn"); }
// 开发/测试时可用 CM_USER_DATA_DIR 指向独立目录，避免与已安装实例共享单实例锁和缓存
if (!app.isPackaged && process.env.CM_USER_DATA_DIR) app.setPath("userData", process.env.CM_USER_DATA_DIR);
app.whenReady().then(async () => { nativeTheme.themeSource = await loadThemePreference(); const userData = app.getPath("userData"); initLogger(userData); LANG = await loadLanguagePreference(userData); logInfo(M().appStart(app.getVersion(), String(app.isPackaged))); try { const saved = JSON.parse(await readFile(join(userData, "codex-command.json"), "utf8")) as { command?: unknown }; if (typeof saved.command === "string" && saved.command.length <= 1_000) { codexCommand = saved.command; codex = new CodexAppServer(codexCommand); } } catch {} bridge = new ChatGptBridgeServer(join(userData, "bridge-secret")); indexStore = new ConversationIndexStore(join(userData, "conversation-index.json")); await indexStore.load(); try { await bridge.start(); } catch (startError) { logWarn(`bridge start failed, continuing without bridge: ${startError instanceof Error ? startError.message : String(startError)}`); } autoUpdateEnabled = await loadUpdatePreference(); updateState = { ...updateState, currentVersion: app.getVersion(), autoUpdate: autoUpdateEnabled }; configureUpdater(); await createWindow(); scheduleAutomaticUpdates(); }).catch((error) => { logWarn(`startup failed: ${error instanceof Error ? error.message : String(error)}`); console.error(error); app.quit(); });
app.on("window-all-closed", () => { if (updateStartupTimer) clearTimeout(updateStartupTimer); if (updateInterval) clearInterval(updateInterval); if (updateInstallTimer) clearTimeout(updateInstallTimer); codex.close(); void bridge?.close(); if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
