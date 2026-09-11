import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell, type IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronUpdater from "electron-updater";
import { ChatGptBridgeServer, ConversationIndexStore, chooseCacheSyncMode, type CachedConversation } from "@conversation-manager/chatgpt-bridge-server";
import { CodexAppServer } from "@conversation-manager/codex-app-server-adapter";
import { discoverCodexCommands } from "./codex-discovery.js";
import { buildSessionsArchive, extractSessionsArchive } from "./codex-sessions-archive.js";
import { terminalResumeSpawn } from "./open-terminal.js";
import { cleanupMacInstallLeftovers, downloadMacArchive, fetchMacRelease, macAppBundlePath, swapMacBundle, type MacUpdateCheck } from "./mac-updater.js";
import { DEFAULT_AUTO_UPDATE, isUpdateInstallSafe, parseAutoUpdatePreference, supportsAutomaticInstallation } from "./update-policy.js";
import { initLogger, logInfo, logWarn, onLogLine, readLogs, clearLogs, saveLogsTo } from "./logger.js";
import { loadLanguagePreference, saveLanguagePreference, type AppLanguage } from "./language.js";
import { MAIN_STRINGS } from "./strings.js";
import { chatgptTranscriptMarkdown, codexMessagesFromTurns, codexMetadataMarkdown, codexTranscriptMarkdown, codexTurnsFromPayload, safeFileName } from "./export.js";

const { autoUpdater } = electronUpdater;
const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASE_URL = "https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases";
const CHATGPT_URL = "https://chatgpt.com/";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const BRIDGE_TIMEOUT_LONG_MS = 300_000;
const BRIDGE_TIMEOUT_PROJECTS_MS = 120_000;
// 会话正文读取缓存：重复查看同一会话时秒开，编辑类操作不走此缓存
const readConversationCache = new Map<string, { at: number; data: { title: string; messages: Array<{ role: string; at: number | null; text: string }> } }>();
const READ_CACHE_TTL_MS = 10 * 60 * 1000;
const READ_CACHE_MAX = 50;
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
let macRelease: MacUpdateCheck | null = null;
let macArchivePath: string | null = null;
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
  // 界面内点击的网页链接一律交给系统浏览器，防止应用窗口被导航走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith("http")) void shell.openExternal(url).catch(() => {}); return { action: "deny" }; });
  mainWindow.webContents.on("will-navigate", (event, url) => { event.preventDefault(); if (url.startsWith("http")) void shell.openExternal(url).catch(() => {}); });
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
    if (updateState.phase === "downloaded" && macArchivePath && activeBatchCount === 0) startMacInstall();
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
function scheduleAutomaticUpdates(): void { if (updateStartupTimer) clearTimeout(updateStartupTimer); if (updateInterval) clearInterval(updateInterval); updateStartupTimer = null; updateInterval = null; if (!app.isPackaged || !autoUpdateEnabled) return; updateStartupTimer = setTimeout(() => void checkForUpdates(), 10_000); updateInterval = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS); updateStartupTimer.unref(); updateInterval.unref(); }
function scheduleUpdateInstall(): void {
  if (updateInstallTimer) return;
  updateInstallTimer = setTimeout(() => {
    updateInstallTimer = null;
    if (isUpdateInstallSafe(updateState.phase, activeBatchCount)) autoUpdater.quitAndInstall(true, true);
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

ipcMain.handle("app:version", (event) => { requireRenderer(event); return app.getVersion(); });
ipcMain.handle("external:open", async (event, value) => { requireRenderer(event); if (value !== CHATGPT_URL && value !== RELEASE_URL && value !== "https://developers.openai.com/codex/app-server") throw new Error("URL not allowed"); await shell.openExternal(value); });
ipcMain.handle("chatgpt:state", (event) => { requireRenderer(event); return bridge.state(); });
ipcMain.handle("chatgpt:clear-pairing", async (event) => { requireRenderer(event); await bridge.clearPairing(); return bridge.state(); });
ipcMain.handle("chatgpt:open", async (event) => { requireRenderer(event); await shell.openExternal(CHATGPT_URL); });
ipcMain.handle("chatgpt:open-conversation", async (event, value) => { requireRenderer(event); await shell.openExternal(`${CHATGPT_URL}c/${requireId(value)}`); });
ipcMain.handle("chatgpt:show-extension", (event) => { requireRenderer(event); const directory = extensionDirectory(); shell.showItemInFolder(join(directory, "manifest.json")); return directory; });
ipcMain.handle("chatgpt:extension-directory", (event) => { requireRenderer(event); return extensionDirectory(); });
ipcMain.handle("chatgpt:accounts", async (event) => { requireRenderer(event); const result = await bridge.request("accounts", {}); if (!result.ok) throw new Error(result.error?.message || M().accountReadFailed); return sanitizeAccounts(result.payload); });
ipcMain.handle("chatgpt:projects", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const accountKey = requireAccount(input.accountKey);
  const result = await bridge.request("projects", { accountKey }, BRIDGE_TIMEOUT_PROJECTS_MS); if (!result.ok) throw new Error(result.error?.message || M().accountReadFailed);
  const payload = result.payload as { projects?: unknown }; const rows = Array.isArray(payload?.projects) ? payload.projects : [];
  return { projects: rows.slice(0, 300).map((row) => { const item = row && typeof row === "object" ? row as Record<string, unknown> : {}; if (typeof item.id !== "string" || !item.id.startsWith("g-p-") || item.id.length > 128) return null; const name = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 100) : item.id; return { id: item.id, name }; }).filter((row): row is { id: string; name: string } => Boolean(row)) };
});
ipcMain.handle("chatgpt:cached-accounts", (event) => { requireRenderer(event); return { accounts: indexStore.accounts().map((item) => ({ ...item, isDefault: false })) }; });
ipcMain.handle("chatgpt:cache", (event, value) => { requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; return indexStore.read(requireAccount(input.accountKey), requireState(input.state)); });
ipcMain.handle("chatgpt:list", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const accountKey = requireAccount(input.accountKey); const state = requireState(input.state); const label = typeof input.label === "string" ? input.label.slice(0, 100) : "ChatGPT"; const cached = indexStore.read(accountKey, state); const mode = chooseCacheSyncMode(cached, input.full === true);
  const result = await bridge.request("list", { accountKey, state, mode, checkpoint: mode === "full" ? null : cached?.records[0]?.updatedAt ?? null }, BRIDGE_TIMEOUT_LONG_MS); if (!result.ok) throw new Error(result.error?.message || M().syncFailed);
  const payload = result.payload as { records?: unknown; full?: boolean; projects?: unknown }; const records = sanitizeRecords(payload.records, state); const projects = sanitizeProjects(payload.projects); const calibrated = mode === "full" || payload.full === true; if (calibrated) await indexStore.replace(accountKey, label, state, records, true, projects); else await indexStore.merge(accountKey, label, state, records, projects); const snapshot = indexStore.read(accountKey, state); return snapshot ? { ...snapshot, syncMode: calibrated ? "full" : "incremental" } : null;
});
ipcMain.handle("chatgpt:preview-delete", (event, value) => { requireRenderer(event); const ids = requireIds(value); return { confirmationToken: rememberConfirmation("chatgpt", ids) }; });
ipcMain.handle("chatgpt:batch", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const action = input.action; if (action !== "archive" && action !== "restore" && action !== "delete" && action !== "add-to-project" && action !== "remove-from-project") throw new Error("Invalid batch action"); const ids = requireIds(input.ids); const accountKey = requireAccount(input.accountKey); if (action === "delete") validateConfirmation("chatgpt", ids, input.confirmationToken);
  const projectId = action === "add-to-project" ? typeof input.projectId === "string" && /^g-p-[A-Za-z0-9_-]{1,120}$/.test(input.projectId) ? input.projectId : null : null;
  if (action === "add-to-project" && !projectId) throw new Error(M().projectMissing);
  const operationId = randomUUID(); currentChatBatchId = operationId;
  activeBatchCount += 1;
  try { const result = await bridge.request("batch", { accountKey, action, ids, requestId: operationId, ...(projectId ? { projectId } : {}) }, BRIDGE_TIMEOUT_LONG_MS); if (!result.ok) throw new Error(result.error?.message || M().batchFailed); const payload = result.payload as { succeeded?: string[]; failed?: Array<{ id: string; message: string }>; unprocessed?: string[] }; const succeeded = Array.isArray(payload.succeeded) ? payload.succeeded.map(requireId) : []; if (action === "add-to-project" || action === "remove-from-project") await indexStore.applyProjectMove(accountKey, succeeded, action === "add-to-project" ? projectId : null); else await indexStore.apply(accountKey, action, succeeded); return { succeeded, failed: Array.isArray(payload.failed) ? payload.failed : [], unprocessed: Array.isArray(payload.unprocessed) ? payload.unprocessed : [] }; } finally { activeBatchCount -= 1; if (currentChatBatchId === operationId) currentChatBatchId = null; }
});
ipcMain.handle("chatgpt:cancel", async (event) => { requireRenderer(event); if (!currentChatBatchId) return { cancelled: false }; const result = await bridge.request("cancel", { requestId: currentChatBatchId }); return { cancelled: result.ok }; });
ipcMain.handle("chatgpt:cache-stats", (event) => { requireRenderer(event); return indexStore.stats(); });
ipcMain.handle("chatgpt:clear-cache", async (event) => { requireRenderer(event); await indexStore.clear(); return indexStore.stats(); });
ipcMain.handle("dialog:pick-directory", async (event, value) => { requireRenderer(event); if (!mainWindow) throw new Error(M().windowUnavailable); const input = value && typeof value === "object" ? value as { defaultPath?: unknown } : {}; const defaultPath = typeof input.defaultPath === "string" && input.defaultPath ? input.defaultPath : undefined; const result = await dialog.showOpenDialog(mainWindow, { title: M().pickSaveDir, defaultPath, properties: ["openDirectory", "createDirectory"] }); return { directory: result.canceled || !result.filePaths[0] ? null : result.filePaths[0] }; });
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
        const result = await bridge.request("read", { accountKey, id: item.id }, BRIDGE_TIMEOUT_LONG_MS);
        if (!result.ok) throw new Error(result.error?.message || M().readConversationFailed);
        const payload = result.payload as { title?: unknown; messages?: unknown };
        const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
        const messages = rawMessages.map((message) => { const row = message && typeof message === "object" ? message as Record<string, unknown> : {}; return { role: typeof row.role === "string" ? row.role : "other", at: typeof row.at === "number" ? row.at : null, text: typeof row.text === "string" ? row.text : "" }; });
        const transcript = { id: item.id, title: typeof payload.title === "string" ? payload.title.slice(0, 200) : item.title, messages };
        const markdown = chatgptTranscriptMarkdown(transcript, Date.now(), "ChatGPT", LANG);
        const imagesDir = join(directory, "images");
        const imageUrls: string[] = [...new Set([...markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))].filter((u): u is string => Boolean(u)).slice(0, 30);
        for (let imgIdx = 0; imgIdx < imageUrls.length; imgIdx++) {
          const imgUrl: string = imageUrls[imgIdx] ?? "";
          if (!imgUrl) continue;
          try {
            const res = await fetch(imgUrl);
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            const extMatch = imgUrl.match(/\.(png|jpe?g|webp|gif)/i);
            const ext = extMatch?.[1]?.toLowerCase() ?? "png";
            await mkdir(imagesDir, { recursive: true });
            await writeFile(join(imagesDir, `img-${imgIdx + 1}.${ext}`), buf);
          } catch {}
        }
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
        markdown = codexTranscriptMarkdown(thread, turns, Date.now(), LANG);
      } catch (readError) {
        markdown = codexMetadataMarkdown(threadMeta, readError instanceof Error ? readError.message : String(readError), Date.now(), LANG);
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

ipcMain.handle("codex:status", async (event) => { requireRenderer(event); const available = await connectCodex(); return { available, message: available ? (codexCommand === "codex" ? M().codexConnectedLocal : M().codexConnectedBundled) : M().codexNotFound, command: codexCommand }; });
ipcMain.handle("codex:select-command", async (event) => { requireRenderer(event); if (!mainWindow) throw new Error("Window unavailable"); const dialogOptions: Electron.OpenDialogOptions = { title: M().pickCodexExe, properties: ["openFile"] }; if (process.platform !== "darwin") dialogOptions.filters = [{ name: "Codex", extensions: ["exe", "cmd", "bat"] }]; const result = await dialog.showOpenDialog(mainWindow, dialogOptions); if (result.canceled || !result.filePaths[0]) return { selected: false, command: codexCommand }; const command = result.filePaths[0]; const candidate = new CodexAppServer(command); await candidate.start(); codex.close(); codex = candidate; codexCommand = command; await writeFile(join(app.getPath("userData"), "codex-command.json"), `${JSON.stringify({ command }, null, 2)}\n`, "utf8"); return { selected: true, command }; });
ipcMain.handle("codex:list", async (event, value) => { requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; return codex.list({ cursor: typeof input.cursor === "string" ? input.cursor : null, limit: 100, archived: input.archived === true, searchTerm: typeof input.searchTerm === "string" ? input.searchTerm.slice(0, 200) : null, full: input.full === true }); });
ipcMain.handle("codex:open", async (event, value) => {
  requireRenderer(event);
  const id = requireId(value);
  const fallback = () => { clipboard.writeText(`${codexCommand} resume ${id}`); return { opened: false, copied: true }; };
  try {
    // 优先走 ChatGPT 桌面客户端注册的 codex:// 深链，在其原生界面中直接打开该会话
    await shell.openExternal(`codex://threads/${id}`);
    return { opened: true };
  } catch {
    // 深链不可用（未安装桌面客户端或协议未注册）时回退到终端 CLI
    try {
      // 保存的命令可能因客户端升级失效（版本化目录被替换），先验证再启动
      if (codexCommand !== "codex") await stat(codexCommand);
      const target = terminalResumeSpawn(codexCommand, id);
      // Windows/macOS 启动器是短命进程：退出码非 0 说明启动终端失败；Linux 直接跑 TUI，不会退出，靠超时判成功
      const opened = await new Promise<boolean>((resolve) => {
        const child = spawn(target.file, target.args, target.options);
        child.unref();
        child.once("error", () => resolve(false));
        if (process.platform !== "linux") child.once("exit", (code) => resolve(code === 0));
        setTimeout(() => resolve(true), 4000);
      });
      return opened ? { opened: true } : fallback();
    } catch { return fallback(); }
  }
});
ipcMain.handle("codex:preview-delete", async (event, value) => { requireRenderer(event); const ids = requireIds(value); const preview = await codex.previewDelete(ids); let confirmationToken: string | null = null; if (!preview.missing.length && !preview.running.length) confirmationToken = rememberConfirmation("codex", ids, preview.fingerprint); return { tasks: preview.records.map((record) => ({ id: record.id, title: record.name?.trim() || record.preview?.trim() || M().unnamedTask, derived: !ids.includes(record.id) })), missing: preview.missing, running: preview.running, confirmationToken }; });
ipcMain.handle("chatgpt:read-conversation", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const accountKey = requireAccount(input.accountKey); const id = requireId(input.id);
  const cacheKey = `${accountKey}:${id}`;
  const cached = readConversationCache.get(cacheKey);
  if (cached && Date.now() - cached.at < READ_CACHE_TTL_MS) { cached.at = Date.now(); readConversationCache.delete(cacheKey); readConversationCache.set(cacheKey, cached); return cached.data; }
  const result = await bridge.request("read", { accountKey, id }, BRIDGE_TIMEOUT_LONG_MS); if (!result.ok) throw new Error(result.error?.message || M().readConversationFailed);
  const payload = result.payload as { title?: unknown; messages?: unknown };
  const rows = Array.isArray(payload?.messages) ? payload.messages : [];
  const messages = rows.map((row) => { const item = row && typeof row === "object" ? row as Record<string, unknown> : {}; return { role: typeof item.role === "string" ? item.role.slice(0, 32) : "other", at: typeof item.at === "number" ? item.at : null, text: typeof item.text === "string" ? item.text.slice(0, 500_000) : "" }; }).filter((item) => item.text.trim().length > 0);
  const data = { title: typeof payload?.title === "string" ? payload.title.slice(0, 200) : "", messages };
  readConversationCache.set(cacheKey, { at: Date.now(), data });
  if (readConversationCache.size > READ_CACHE_MAX) { const oldest = readConversationCache.keys().next().value; if (oldest !== undefined) readConversationCache.delete(oldest); }
  return data;
});
ipcMain.handle("codex:read-thread", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const id = requireId(input.threadId);
  const payload = await codex.readThread(id);
  return { messages: codexMessagesFromTurns(codexTurnsFromPayload(payload)) };
});
ipcMain.handle("codex:projects", async (event) => { requireRenderer(event); return { projects: await codex.listProjects() }; });
ipcMain.handle("codex:project-create", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 100) : null;
  const rootPath = typeof input.rootPath === "string" && input.rootPath.trim() ? input.rootPath.trim() : null;
  if (!name || !rootPath) throw new Error(M().projectMissing);
  return await codex.createProject(name, rootPath);
});
ipcMain.handle("codex:project-rename", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const projectId = typeof input.projectId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.projectId) ? input.projectId : null;
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 100) : null;
  if (!projectId || !name) throw new Error(M().projectMissing);
  await codex.renameProject(projectId, name);
});
ipcMain.handle("codex:project-delete", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const projectId = typeof input.projectId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.projectId) ? input.projectId : null;
  if (!projectId) throw new Error(M().projectMissing);
  await codex.deleteProject(projectId);
});
ipcMain.handle("codex:set-project", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const threadId = requireId(input.threadId);
  const projectId = typeof input.projectId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.projectId) ? input.projectId : null;
  if (input.projectId != null && input.projectId !== "" && !projectId) throw new Error(M().projectMissing);
  await codex.setThreadProject(threadId, projectId);
});
ipcMain.handle("codex:batch", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const action = input.action; if (action !== "archive" && action !== "unarchive" && action !== "delete") throw new Error("Invalid batch action"); const ids = requireIds(input.ids);
  activeBatchCount += 1;
  try {
    const currentRecords = [];
    if (action === "delete") { const confirmation = validateConfirmation("codex", ids, input.confirmationToken); const current = await codex.previewDelete(ids); if (current.missing.length || current.running.length || current.fingerprint !== confirmation.fingerprint) throw new Error(M().taskStateChanged); currentRecords.push(...current.records); }
    else { let cursor: string | null = null; do { const page = await codex.list({ archived: action === "unarchive", cursor, includeDerived: true }); currentRecords.push(...page.data); cursor = page.nextCursor; } while (cursor); }
    const currentById = new Map(currentRecords.map((thread) => [thread.id, thread]));
    const succeeded: string[] = [], failed: Array<{ id: string; message: string }> = [];
    for (const id of ids) { try { const current = currentById.get(id); if (!current) throw new Error(M().taskMissing); if (current.status?.type === "active") throw new Error(M().taskRunning); if (action === "archive") await codex.archive(id); else if (action === "unarchive") await codex.unarchive(id); else await codex.delete(id); succeeded.push(id); } catch (error) { failed.push({ id, message: error instanceof Error ? error.message : String(error) }); } }
    return { succeeded, failed };
  } finally { activeBatchCount -= 1; }
});

ipcMain.handle("update:get-state", (event) => { requireRenderer(event); return updateState; });
ipcMain.handle("update:set-auto", async (event, value) => { requireRenderer(event); if (typeof value !== "boolean") throw new Error("Invalid update preference"); await saveUpdatePreference(value); autoUpdateEnabled = value; if (updateInstallTimer) { clearTimeout(updateInstallTimer); updateInstallTimer = null; } publishUpdateState({ autoUpdate: value, ...(value && updateState.phase === "downloaded" && canAutoInstallUpdate ? { message: M().downloadedAuto(updateState.version ?? "") } : {}) }); scheduleAutomaticUpdates(); if (value && updateState.phase === "downloaded" && canAutoInstallUpdate) scheduleUpdateInstall(); else if (value) void checkForUpdates(); return updateState; });
ipcMain.handle("update:check", async (event) => { requireRenderer(event); await checkForUpdates(); return updateState; });
ipcMain.handle("update:download", async (event) => { requireRenderer(event); await downloadMacRelease(); return updateState; });
ipcMain.handle("update:install", (event) => {
  requireRenderer(event);
  if (process.platform === "darwin") { if (!macArchivePath || updateState.phase !== "downloaded") throw new Error(M().updateNotReady); if (activeBatchCount > 0) throw new Error(M().installWaitBatch); startMacInstall(); return updateState; }
  if (!canAutoInstallUpdate || !isUpdateInstallSafe(updateState.phase, activeBatchCount)) throw new Error(activeBatchCount ? M().installWaitBatch : M().updateNotReady);
  autoUpdater.quitAndInstall(true, true);
});
ipcMain.handle("update:open-release", async (event) => { requireRenderer(event); await shell.openExternal(RELEASE_URL); });
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
  const files = ["conversation-index.json", "update-preferences.json", "theme-preferences.json", "language-preferences.json", "codex-command.json"];
  let copied = 0;
  for (const file of files) { try { await copyFile(join(userData, file), join(directory, file)); copied += 1; } catch {} }
  return { copied, directory };
});
ipcMain.handle("data:import", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : null;
  if (!directory) throw new Error(M().noDirectory);
  const userData = app.getPath("userData");
  const files = ["conversation-index.json", "update-preferences.json", "theme-preferences.json", "language-preferences.json", "codex-command.json"];
  let restored = 0;
  for (const file of files) { try { await copyFile(join(directory, file), join(userData, file)); restored += 1; } catch {} }
  return { restored };
});
ipcMain.handle("codex:export-sessions-archive", async (event) => {
  requireRenderer(event);
  if (!mainWindow) throw new Error(M().windowUnavailable);
  const result = await dialog.showSaveDialog(mainWindow, { title: M().saveSessionsZip, defaultPath: `codex-sessions-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: "Zip", extensions: ["zip"] }] });
  if (result.canceled || !result.filePath) return { cancelled: true };
  const { zip, count } = await buildSessionsArchive(join(homedir(), ".codex"));
  if (!count) return { cancelled: false, count: 0 };
  await writeFile(result.filePath, zip);
  logInfo(`codex sessions archive: exported ${count} sessions -> ${result.filePath}`);
  return { cancelled: false, count, file: result.filePath };
});
ipcMain.handle("codex:import-sessions-archive", async (event) => {
  requireRenderer(event);
  if (!mainWindow) throw new Error(M().windowUnavailable);
  const result = await dialog.showOpenDialog(mainWindow, { title: M().pickSessionsZip, properties: ["openFile"], filters: [{ name: "Zip", extensions: ["zip"] }] });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  const zip = new Uint8Array(await readFile(result.filePaths[0]));
  const { imported, skipped } = await extractSessionsArchive(zip, join(homedir(), ".codex"));
  logInfo(`codex sessions archive: imported ${imported}, skipped ${skipped}`);
  return { cancelled: false, imported, skipped };
});

type ThemePreference = "system" | "light" | "dark";
async function loadThemePreference(): Promise<ThemePreference> { try { const raw = JSON.parse(await readFile(join(app.getPath("userData"), "theme-preferences.json"), "utf8")) as { theme?: unknown }; return raw.theme === "light" || raw.theme === "dark" || raw.theme === "system" ? raw.theme : "system"; } catch { return "system"; } }
ipcMain.handle("theme:get", (event) => { requireRenderer(event); return nativeTheme.themeSource; });
ipcMain.handle("theme:set", async (event, value) => { requireRenderer(event); if (value !== "system" && value !== "light" && value !== "dark") throw new Error("Invalid theme preference"); nativeTheme.themeSource = value; await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "theme-preferences.json"), `${JSON.stringify({ theme: value }, null, 2)}\n`, "utf8"); return nativeTheme.themeSource; });
ipcMain.handle("log:read", async (event) => { requireRenderer(event); return readLogs(); });
ipcMain.handle("log:info", (event, message) => { requireRenderer(event); logInfo(typeof message === "string" ? message.slice(0, 300) : "invalid log message"); return true; });
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
ipcMain.handle("language:set", async (event, value) => { requireRenderer(event); if (value !== "zh" && value !== "en") throw new Error("Invalid language"); LANG = value; await saveLanguagePreference(app.getPath("userData"), LANG); refreshUpdateMessage(); return LANG; });

function extensionDirectory(): string { return app.isPackaged ? join(process.resourcesPath, "chatgpt-browser-bridge-extension") : join(app.getAppPath(), "..", "..", "packages", "chatgpt-browser-bridge-extension"); }
function refreshUpdateMessage(): void {
  if (updateState.phase === "checking") publishUpdateState({ message: M().checking });
  else if (updateState.phase === "downloading") publishUpdateState({ message: M().downloadProgress(updateState.percent ?? 0) });
  else if (updateState.phase === "downloaded") publishUpdateState({ message: autoUpdateEnabled && canAutoInstallUpdate ? M().downloadedAuto(updateState.version ?? "") : M().downloadedManual(updateState.version ?? "") });
  else if (updateState.phase === "available") publishUpdateState({ message: canAutoInstallUpdate ? M().downloadingUpdate(updateState.version ?? "") : M().downloadedManual(updateState.version ?? "") });
  else if (updateState.phase === "not-available") publishUpdateState({ message: M().upToDate });
  else if (updateState.phase === "error") publishUpdateState({ message: M().updateError });
  else if (updateState.phase === "idle") publishUpdateState({ message: M().idle });
}
function validateConfirmation(source: "chatgpt" | "codex", ids: string[], value: unknown) { const token = typeof value === "string" ? value : ""; const confirmation = confirmations.get(token); confirmations.delete(token); if (!confirmation || confirmation.source !== source || confirmation.expiresAt < Date.now() || JSON.stringify(confirmation.ids) !== JSON.stringify(ids)) throw new Error(M().deleteConfirmationExpired); return confirmation; }
function rememberConfirmation(source: "chatgpt" | "codex", ids: string[], fingerprint?: string): string { const now = Date.now(); for (const [token, entry] of confirmations) if (entry.expiresAt < now) confirmations.delete(token); const token = randomUUID(); confirmations.set(token, { source, ids, ...(fingerprint ? { fingerprint } : {}), expiresAt: now + 120_000 }); return token; }
function sanitizeAccounts(value: unknown) { const input = value && typeof value === "object" ? value as { accounts?: unknown } : {}; if (!Array.isArray(input.accounts) || input.accounts.length > 100) throw new Error(M().invalidAccountList); const out: Array<{ key: string; label: string; isDefault: boolean }> = []; for (const item of input.accounts) { const row = item && typeof item === "object" ? item as Record<string, unknown> : {}; try { out.push({ key: requireAccount(row.key), label: typeof row.label === "string" ? row.label.slice(0, 100) : "ChatGPT", isDefault: row.isDefault === true }); } catch {} } if (!out.length && input.accounts.length) throw new Error(M().unrecognizedAccountList); return { accounts: out }; }
function sanitizeProjects(value: unknown): Record<string, string> {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(input).slice(0, 300)) {
    if (!id.startsWith("g-p-") || id.length > 128) continue;
    if (typeof name === "string" && name.trim()) out[id] = name.trim().slice(0, 100);
  }
  return out;
}
const warnedMalformedIds = new Set<string>();
function sanitizeRecords(value: unknown, state: CachedConversation["state"]): CachedConversation[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error(M().invalidConversationList);
  const out: CachedConversation[] = []; let skipped = 0; let sample = "";
  for (const item of value) {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const number = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : null;
    try {
      out.push({ id: requireId(row.id), title: typeof row.title === "string" ? row.title.slice(0, 500) : M().unnamedConversation, createdAt: number(row.createdAt), updatedAt: number(row.updatedAt), state, ...(typeof row.projectId === "string" && row.projectId.length <= 128 ? { projectId: row.projectId } : {}), pinned: row.pinned === true, current: row.current === true, automation: state === "scheduled" });
    } catch {
      skipped += 1;
      if (!sample && typeof row.id === "string") sample = `${row.id.slice(0, 12)}…(len ${row.id.length})`;
    }
  }
  if (!out.length && value.length) throw new Error(M().unrecognizedConversations(value.length));
  if (skipped && !warnedMalformedIds.has(sample)) { warnedMalformedIds.add(sample); logWarn(`[chatgpt-bridge] skipped ${skipped} malformed conversation rows, sample id: ${sample || "unknown"}`); }
  return out;
}
// 开发/测试时可用 CM_USER_DATA_DIR 指向独立目录，避免与已安装实例共享单实例锁和缓存（必须在锁之前设置）
if (!app.isPackaged && process.env.CM_USER_DATA_DIR) app.setPath("userData", process.env.CM_USER_DATA_DIR);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else app.on("second-instance", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
if (app.isPackaged && process.platform === "win32") { app.setAsDefaultProtocolClient("conversation-manager"); app.setAsDefaultProtocolClient("cgn"); }

// mac 需要应用菜单才能使用 Cmd+C/V/Q 等标准快捷键；Windows 保持无菜单栏（autoHideMenuBar）
if (process.platform === "darwin") {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
// 开发/测试时可用 CM_USER_DATA_DIR 指向独立目录，避免与已安装实例共享单实例锁和缓存
if (!app.isPackaged && process.env.CM_USER_DATA_DIR) app.setPath("userData", process.env.CM_USER_DATA_DIR);
app.whenReady().then(async () => { nativeTheme.themeSource = await loadThemePreference(); const userData = app.getPath("userData"); initLogger(userData); if (process.platform === "darwin") { const bundle = macAppBundlePath(app.getPath("exe")); if (bundle) void cleanupMacInstallLeftovers(bundle); } const systemDefault: AppLanguage = app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en"; LANG = await loadLanguagePreference(userData, process.platform === "darwin" ? systemDefault : "zh"); if (process.platform === "darwin") app.setAboutPanelOptions({ applicationName: "Conversation Manager", applicationVersion: app.getVersion(), credits: "ChatGPT · Codex · Ricardo-Ping", website: "https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager" }); logInfo(M().appStart(app.getVersion(), String(app.isPackaged))); try { const saved = JSON.parse(await readFile(join(userData, "codex-command.json"), "utf8")) as { command?: unknown }; if (typeof saved.command === "string" && saved.command.length <= 1_000) { codexCommand = saved.command; codex = new CodexAppServer(codexCommand); } } catch {} bridge = new ChatGptBridgeServer(join(userData, "bridge-secret")); indexStore = new ConversationIndexStore(join(userData, "conversation-index.json")); await indexStore.load(); try { const bundled = JSON.parse(await readFile(join(extensionDirectory(), "manifest.json"), "utf8")) as { version?: unknown }; if (typeof bundled.version === "string" && /^\d+(\.\d+){0,3}/.test(bundled.version)) bridge.setExpectedExtensionVersion(bundled.version); } catch {} try { await bridge.start(); } catch (startError) { logWarn(`bridge start failed, continuing without bridge: ${startError instanceof Error ? startError.message : String(startError)}`); } autoUpdateEnabled = await loadUpdatePreference(); updateState = { ...updateState, currentVersion: app.getVersion(), autoUpdate: autoUpdateEnabled }; configureUpdater(); await createWindow(); scheduleAutomaticUpdates(); }).catch((error) => { logWarn(`startup failed: ${error instanceof Error ? error.message : String(error)}`); console.error(error); app.quit(); });
app.on("window-all-closed", () => { if (updateStartupTimer) clearTimeout(updateStartupTimer); if (updateInterval) clearInterval(updateInterval); if (updateInstallTimer) clearTimeout(updateInstallTimer); codex.close(); void bridge?.close(); if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
