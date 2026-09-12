import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_PORT, ChatGptBridgeServer, ConversationIndexStore, chooseCacheSyncMode, type BridgeCommandType, type BridgeResult } from "@conversation-manager/chatgpt-bridge-server";
import { CodexAppServer } from "@conversation-manager/codex-app-server-adapter";
import { isValidVersionFormat } from "@conversation-manager/conversation-domain";
import { discoverCodexCommands } from "./codex-discovery.js";
import { syncExtensionFiles } from "./extension-sync.js";
import { healLoadedExtensionFolders } from "./extension-heal.js";
import { extensionCodeHash, classifyExtensionStaleness, shouldDemandReload } from "./extension-integrity.js";
import { terminalResumeSpawn } from "./open-terminal.js";
import { cleanupMacInstallLeftovers, isNewerVersion, macAppBundlePath } from "./mac-updater.js";
import { initLogger, logInfo, logWarn, onLogLine, readLogs, clearLogs, saveLogsTo } from "./logger.js";
import { loadLanguagePreference, saveLanguagePreference, setAppLanguage, appLanguage, M, type AppLanguage } from "./language.js";
import { applyImageRewrites, chatGptImageDir, chatgptTranscriptMarkdown, codexMessagesFromTurns, codexMetadataMarkdown, codexTranscriptMarkdown, codexTurnsFromPayload, extractChatGptImageUrls, safeFileName } from "./export.js";
import { initIpcWindow, requireRenderer, requireId, requireIds, requireAccount, requireState, validateConfirmation, rememberConfirmation, sanitizeAccounts, sanitizeProjects, sanitizeRecords } from "./ipc-sanitize.js";
import { initUpdater, registerUpdateHandlers, applyStartupUpdatePreferences, scheduleAutomaticUpdates, refreshUpdateMessage, shutdownUpdaterTimers, RELEASE_URL } from "./updater.js";
import { initPreferences, registerPreferenceHandlers, loadThemePreference } from "./preferences.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHATGPT_URL = "https://chatgpt.com/";
const BRIDGE_TIMEOUT_LONG_MS = 300_000;
const BRIDGE_TIMEOUT_PROJECTS_MS = 120_000;
// 会话正文读取缓存：重复查看同一会话时秒开，编辑类操作不走此缓存
const readConversationCache = new Map<string, { at: number; data: { title: string; messages: Array<{ role: string; at: number | null; text: string }> } }>();
const READ_CACHE_TTL_MS = 10 * 60 * 1000;
const READ_CACHE_MAX = 50;
let codexCommand = "codex";
let codex = new CodexAppServer(codexCommand);
let codexConnection: Promise<boolean> | null = null;
let codexScanFailedAt = 0;
let mainWindow: BrowserWindow | null = null;
let bridge: ChatGptBridgeServer;
let indexStore: ConversationIndexStore;
let currentChatBatchId: string | null = null;
let activeBatchCount = 0;
let tray: Tray | null = null;
let quickWindow: BrowserWindow | null = null;
let isQuitting = false;
initIpcWindow(() => [mainWindow, quickWindow]);
initUpdater({ getMainWindow: () => mainWindow, getActiveBatchCount: () => activeBatchCount });
initPreferences({ getMainWindow: () => mainWindow, reloadIndex: () => indexStore.load() });
registerUpdateHandlers();
registerPreferenceHandlers();

let logUnsubscribe: (() => void) | null = null;
async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 760, minHeight: 560, title: "Conversation Manager", autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c181b" : "#f4f8f7", webPreferences: { preload: join(__dirname, "..", "..", "src", "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  // 界面内点击的网页链接一律交给系统浏览器，防止应用窗口被导航走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith("http")) void shell.openExternal(url).catch(() => {}); return { action: "deny" }; });
  mainWindow.webContents.on("will-navigate", (event, url) => { event.preventDefault(); if (url.startsWith("http")) void shell.openExternal(url).catch(() => {}); });
  await mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"), { query: { lang: appLanguage() } }); mainWindow.on("closed", () => { mainWindow = null; });
  // 托盘驻留：点关闭 = 隐藏到托盘，真正退出走托盘菜单的「退出」
  mainWindow.on("close", (event) => { if (!isQuitting) { event.preventDefault(); mainWindow?.hide(); } });
  if (logUnsubscribe) logUnsubscribe();
  logUnsubscribe = onLogLine((line) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("log:appended", line); });
}

function showMainWindow(): void {
  if (!mainWindow) { void createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

function trayIcon(): Electron.NativeImage {
  const path = app.isPackaged ? join(process.resourcesPath, "tray-icon.png") : join(app.getAppPath(), "build", "icon.png");
  const image = nativeImage.createFromPath(path);
  return image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: M().trayShow, click: () => showMainWindow() },
    { label: `${M().trayQuickSearch}  (Alt+Shift+Space)`, click: () => toggleQuickSearch() },
    { type: "separator" },
    { label: M().trayQuit, click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function createTray(): void {
  if (tray) return;
  const icon = trayIcon();
  if (icon.isEmpty()) { logWarn("tray icon missing; tray disabled"); return; }
  tray = new Tray(icon);
  tray.setToolTip("Conversation Manager");
  rebuildTrayMenu();
  tray.on("click", () => showMainWindow());
}

function createQuickWindow(): void {
  quickWindow = new BrowserWindow({ width: 680, height: 460, show: false, frame: false, resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c181b" : "#f4f8f7", webPreferences: { preload: join(__dirname, "..", "..", "src", "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  quickWindow.loadFile(join(__dirname, "..", "renderer", "index.html"), { query: { lang: appLanguage(), window: "quick" } });
  quickWindow.on("blur", () => quickWindow?.hide());
  quickWindow.on("close", (event) => { if (!isQuitting) { event.preventDefault(); quickWindow?.hide(); } });
}

function toggleQuickSearch(): void {
  if (!quickWindow) createQuickWindow();
  if (!quickWindow) return;
  if (quickWindow.isVisible()) { quickWindow.hide(); return; }
  quickWindow.center();
  quickWindow.show();
  quickWindow.focus();
}

// 候选命令全量扫描失败后的冷却期：期间不再重复扫描（每次扫描都会逐个启动进程探测），
// 但现有命令的快速重连不受影响；手动选择命令会重置冷却
const CODEX_SCAN_COOLDOWN_MS = 60_000;
async function connectCodex(): Promise<boolean> {
  if (codexConnection) return codexConnection;
  codexConnection = (async () => {
    try { await codex.start(); return true; } catch {}
    if (Date.now() - codexScanFailedAt < CODEX_SCAN_COOLDOWN_MS) return false;
    for (const command of await discoverCodexCommands()) {
      if (command === codexCommand) continue;
      const candidate = new CodexAppServer(command);
      try {
        await candidate.start(); codex.close(); codex = candidate; codexCommand = command;
        await writeFile(join(app.getPath("userData"), "codex-command.json"), `${JSON.stringify({ command }, null, 2)}\n`, "utf8");
        codexScanFailedAt = 0;
        return true;
      } catch { candidate.close(); }
    }
    codexScanFailedAt = Date.now();
    return false;
  })();
  try { return await codexConnection; } finally { codexConnection = null; }
}
ipcMain.handle("app:version", (event) => { requireRenderer(event); return app.getVersion(); });
ipcMain.handle("external:open", async (event, value) => { requireRenderer(event); if (value !== CHATGPT_URL && value !== RELEASE_URL && value !== "https://developers.openai.com/codex/app-server") throw new Error("URL not allowed"); await shell.openExternal(value); });
ipcMain.handle("chatgpt:state", async (event) => { requireRenderer(event); await updateExtensionReloadHint(); return bridge.state(); });
ipcMain.handle("chatgpt:clear-pairing", async (event) => { requireRenderer(event); await bridge.clearPairing(); return bridge.state(); });
ipcMain.handle("chatgpt:open", async (event) => { requireRenderer(event); await shell.openExternal(CHATGPT_URL); });
ipcMain.handle("chatgpt:open-conversation", async (event, value) => { requireRenderer(event); await shell.openExternal(`${CHATGPT_URL}c/${requireId(value)}`); });
ipcMain.handle("chatgpt:show-extension", (event) => { requireRenderer(event); const directory = extensionDirectory(); shell.showItemInFolder(join(directory, "manifest.json")); return directory; });
ipcMain.handle("chatgpt:extension-directory", (event) => { requireRenderer(event); return extensionDirectory(); });
ipcMain.handle("chatgpt:accounts", async (event) => { requireRenderer(event); const result = await bridgeRequest("accounts", {}); if (!result.ok) throw new Error(result.error?.message || M().accountReadFailed); return sanitizeAccounts(result.payload); });
ipcMain.handle("chatgpt:projects", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const accountKey = requireAccount(input.accountKey);
  const result = await bridgeRequest("projects", { accountKey }, BRIDGE_TIMEOUT_PROJECTS_MS); if (!result.ok) throw new Error(result.error?.message || M().accountReadFailed);
  const payload = result.payload as { projects?: unknown }; const rows = Array.isArray(payload?.projects) ? payload.projects : [];
  return { projects: rows.slice(0, 300).map((row) => { const item = row && typeof row === "object" ? row as Record<string, unknown> : {}; if (typeof item.id !== "string" || !item.id.startsWith("g-p-") || item.id.length > 128) return null; const name = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 100) : item.id; return { id: item.id, name }; }).filter((row): row is { id: string; name: string } => Boolean(row)) };
});
ipcMain.handle("chatgpt:cached-accounts", (event) => { requireRenderer(event); return { accounts: indexStore.accounts().map((item) => ({ ...item, isDefault: false })) }; });
ipcMain.handle("chatgpt:cache", (event, value) => { requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; return indexStore.read(requireAccount(input.accountKey), requireState(input.state)); });
ipcMain.handle("chatgpt:list", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const accountKey = requireAccount(input.accountKey); const state = requireState(input.state); const label = typeof input.label === "string" ? input.label.slice(0, 100) : "ChatGPT"; const cached = indexStore.read(accountKey, state); const mode = chooseCacheSyncMode(cached, input.full === true);
  const result = await bridgeRequest("list", { accountKey, state, mode, checkpoint: mode === "full" ? null : cached?.records[0]?.updatedAt ?? null }, BRIDGE_TIMEOUT_LONG_MS); if (!result.ok) throw new Error(result.error?.message || M().syncFailed);
  const payload = result.payload as { records?: unknown; full?: boolean; projects?: unknown }; const records = sanitizeRecords(payload.records, state); const projects = sanitizeProjects(payload.projects); const calibrated = mode === "full" || payload.full === true; if (calibrated) await indexStore.replace(accountKey, label, state, records, true, projects); else await indexStore.merge(accountKey, label, state, records, projects); const snapshot = indexStore.read(accountKey, state); return snapshot ? { ...snapshot, syncMode: calibrated ? "full" : "incremental" } : null;
});
ipcMain.handle("chatgpt:preview-delete", (event, value) => { requireRenderer(event); const ids = requireIds(value); return { confirmationToken: rememberConfirmation("chatgpt", ids) }; });
ipcMain.handle("chatgpt:batch", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; const action = input.action; if (action !== "archive" && action !== "restore" && action !== "delete" && action !== "add-to-project" && action !== "remove-from-project") throw new Error("Invalid batch action"); const ids = requireIds(input.ids); const accountKey = requireAccount(input.accountKey); if (action === "delete") validateConfirmation("chatgpt", ids, input.confirmationToken);
  const projectId = action === "add-to-project" ? typeof input.projectId === "string" && /^g-p-[A-Za-z0-9_-]{1,120}$/.test(input.projectId) ? input.projectId : null : null;
  if (action === "add-to-project" || action === "remove-from-project") {
    if (action === "add-to-project" && !projectId) throw new Error(M().projectMissing);
    const operationId = randomUUID(); currentChatBatchId = operationId;
    activeBatchCount += 1;
    try { const result = await bridgeRequest("batch", { accountKey, action, ids, requestId: operationId, ...(projectId ? { projectId } : {}) }, BRIDGE_TIMEOUT_LONG_MS); if (!result.ok) throw new Error(result.error?.message || M().batchFailed); const payload = result.payload as { succeeded?: string[]; failed?: Array<{ id: string; message: string }>; unprocessed?: string[] }; const succeeded = Array.isArray(payload.succeeded) ? payload.succeeded.map(requireId) : []; await indexStore.applyProjectMove(accountKey, succeeded, action === "add-to-project" ? projectId : null); return { succeeded, failed: Array.isArray(payload.failed) ? payload.failed : [], unprocessed: Array.isArray(payload.unprocessed) ? payload.unprocessed : [] }; } finally { activeBatchCount -= 1; if (currentChatBatchId === operationId) currentChatBatchId = null; }
  }
  return runChatGptBatch(accountKey, action, ids);
});
// 归档/恢复/删除共用管线：桌面 UI 与本地 MCP API 走同一条路，批量计数期间暂停更新安装
async function runChatGptBatch(accountKey: string, action: "archive" | "restore" | "delete", ids: string[]): Promise<{ succeeded: string[]; failed: Array<{ id: string; message: string }>; unprocessed: string[] }> {
  const operationId = randomUUID(); currentChatBatchId = operationId;
  activeBatchCount += 1;
  try { const result = await bridgeRequest("batch", { accountKey, action, ids, requestId: operationId }, BRIDGE_TIMEOUT_LONG_MS); if (!result.ok) throw new Error(result.error?.message || M().batchFailed); const payload = result.payload as { succeeded?: string[]; failed?: Array<{ id: string; message: string }>; unprocessed?: string[] }; const succeeded = Array.isArray(payload.succeeded) ? payload.succeeded.map(requireId) : []; await indexStore.apply(accountKey, action, succeeded); return { succeeded, failed: Array.isArray(payload.failed) ? payload.failed : [], unprocessed: Array.isArray(payload.unprocessed) ? payload.unprocessed : [] }; } finally { activeBatchCount -= 1; if (currentChatBatchId === operationId) currentChatBatchId = null; }
}
ipcMain.handle("chatgpt:cancel", async (event) => { requireRenderer(event); if (!currentChatBatchId) return { cancelled: false }; const result = await bridgeRequest("cancel", { requestId: currentChatBatchId }); return { cancelled: result.ok }; });
ipcMain.handle("chatgpt:cache-stats", (event) => { requireRenderer(event); return indexStore.stats(); });
ipcMain.handle("chatgpt:clear-cache", async (event) => { requireRenderer(event); await indexStore.clear(); return indexStore.stats(); });
ipcMain.handle("chatgpt:export", async (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const accountKey = requireAccount(input.accountKey);
  const directory = typeof input.directory === "string" && input.directory ? input.directory : null;
  if (!directory) throw new Error(M().noDirectory);
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const items = rawItems.map((item) => { const row = item && typeof item === "object" ? item as Record<string, unknown> : {}; return { id: requireId(row.id), title: typeof row.title === "string" ? row.title.slice(0, 120) : "" }; });
  if (!items.length) throw new Error(M().noItems);
  return exportChatGptSessions(accountKey, directory, items);
});
// 导出管线：桌面 UI 与本地 MCP API 共用；逐会话经扩展读取正文并写出 Markdown（含图片本地化）
async function exportChatGptSessions(accountKey: string, directory: string, items: Array<{ id: string; title: string }>): Promise<{ saved: number; failed: Array<{ id: string; message: string }>; directory: string }> {
  await mkdir(directory, { recursive: true });
  let saved = 0; const failed: Array<{ id: string; message: string }> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (!item) break;
      try {
        const result = await bridgeRequest("read", { accountKey, id: item.id }, BRIDGE_TIMEOUT_LONG_MS);
        if (!result.ok) throw new Error(result.error?.message || M().readConversationFailed);
        const payload = result.payload as { title?: unknown; messages?: unknown };
        const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
        const messages = rawMessages.map((message) => { const row = message && typeof message === "object" ? message as Record<string, unknown> : {}; return { role: typeof row.role === "string" ? row.role : "other", at: typeof row.at === "number" ? row.at : null, text: typeof row.text === "string" ? row.text : "" }; });
        const transcript = { id: item.id, title: typeof payload.title === "string" ? payload.title.slice(0, 200) : item.title, messages };
        const markdown = chatgptTranscriptMarkdown(transcript, Date.now(), "ChatGPT", appLanguage());
        // 图片按会话存放在独立子目录，避免批量导出时同名互相覆盖
        const imageDirName = chatGptImageDir(transcript.title || item.title, item.id);
        let rewritten = markdown;
        const imageUrls = extractChatGptImageUrls(markdown);
        for (let imgIdx = 0; imgIdx < imageUrls.length; imgIdx++) {
          const imgUrl: string = imageUrls[imgIdx] ?? "";
          if (!imgUrl) continue;
          try {
            const res = await fetch(imgUrl);
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            const extMatch = imgUrl.match(/\.(png|jpe?g|webp|gif)/i);
            const ext = extMatch?.[1]?.toLowerCase() ?? "png";
            const relativePath = `images/${imageDirName}/img-${imgIdx + 1}.${ext}`;
            await mkdir(join(directory, "images", imageDirName), { recursive: true });
            await writeFile(join(directory, relativePath), buf);
            // 只把成功下载的 URL 改写为相对路径；下载失败的保留原始远程链接
            rewritten = applyImageRewrites(rewritten, [[imgUrl, relativePath]]);
          } catch {}
        }
        await writeFile(join(directory, safeFileName(transcript.title || item.title, item.id)), rewritten, "utf8");
        saved += 1;
      } catch (error) { failed.push({ id: item.id, message: error instanceof Error ? error.message : String(error) }); }
    }
  });
  await Promise.all(workers);
  logInfo(`chatgpt export: saved ${saved}, failed ${failed.length}`);
  return { saved, failed, directory };
}
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
        markdown = codexTranscriptMarkdown(thread, turns, Date.now(), appLanguage());
      } catch (readError) {
        markdown = codexMetadataMarkdown(threadMeta, readError instanceof Error ? readError.message : String(readError), Date.now(), appLanguage());
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

ipcMain.handle("codex:status", async (event) => { requireRenderer(event); const available = await connectCodex(); return { available, message: available ? (codexCommand === "codex" ? M().codexConnectedLocal : M().codexConnectedBundled) : M().codexNotFound, command: codexCommand, home: join(homedir(), ".codex") }; });
ipcMain.handle("codex:select-command", async (event) => { requireRenderer(event); if (!mainWindow) throw new Error("Window unavailable"); const dialogOptions: Electron.OpenDialogOptions = { title: M().pickCodexExe, properties: ["openFile"] }; if (process.platform !== "darwin") dialogOptions.filters = [{ name: "Codex", extensions: ["exe", "cmd", "bat"] }]; const result = await dialog.showOpenDialog(mainWindow, dialogOptions); if (result.canceled || !result.filePaths[0]) return { selected: false, command: codexCommand }; const command = result.filePaths[0]; const candidate = new CodexAppServer(command); await candidate.start(); codex.close(); codex = candidate; codexCommand = command; codexScanFailedAt = 0; await writeFile(join(app.getPath("userData"), "codex-command.json"), `${JSON.stringify({ command }, null, 2)}\n`, "utf8"); return { selected: true, command }; });
ipcMain.handle("codex:list", async (event, value) => { requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; return codex.list({ cursor: typeof input.cursor === "string" ? input.cursor : null, limit: 100, archived: input.archived === true, searchTerm: typeof input.searchTerm === "string" ? input.searchTerm.slice(0, 200) : null, full: input.full === true }); });
ipcMain.handle("codex:open", async (event, value) => {
  requireRenderer(event);
  const id = requireId(value);
  const fallback = () => { clipboard.writeText(`${codexCommand} resume ${id}`); return { opened: false, copied: true }; };
  try {
    // 仅当系统确实注册了 codex:// 处理程序时才走深链：未注册协议的 openExternal 在
    // Windows 可能弹系统选择框、macOS 可能静默成功，不能依赖它的 reject 触发回退
    const handler = await app.getApplicationNameForProtocol(`codex://threads/${id}`);
    if (!handler) throw new Error("codex:// protocol has no handler");
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
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {}; return readConversationShared(requireAccount(input.accountKey), requireId(input.id));
});
// 快速搜索窗（托盘全局快捷键呼出）使用：与 chatgpt.search 共用同一检索管线
ipcMain.handle("chatgpt:quick-search", (event, value) => {
  requireRenderer(event); const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return handleLocalCommand("chatgpt.search", { query: typeof input.query === "string" ? input.query : "", limit: typeof input.limit === "number" ? input.limit : 6 });
});
// 读取管线：带 LRU 缓存；桌面阅读面板与本地 MCP API 共用
async function readConversationShared(accountKey: string, id: string): Promise<{ title: string; messages: Array<{ role: string; at: number | null; text: string }> }> {
  const cacheKey = `${accountKey}:${id}`;
  const cached = readConversationCache.get(cacheKey);
  if (cached && Date.now() - cached.at < READ_CACHE_TTL_MS) { cached.at = Date.now(); readConversationCache.delete(cacheKey); readConversationCache.set(cacheKey, cached); return cached.data; }
  const result = await bridgeRequest("read", { accountKey, id }, BRIDGE_TIMEOUT_LONG_MS); if (!result.ok) throw new Error(result.error?.message || M().readConversationFailed);
  const payload = result.payload as { title?: unknown; messages?: unknown };
  const rows = Array.isArray(payload?.messages) ? payload.messages : [];
  const messages = rows.map((row) => { const item = row && typeof row === "object" ? row as Record<string, unknown> : {}; return { role: typeof item.role === "string" ? item.role.slice(0, 32) : "other", at: typeof item.at === "number" ? item.at : null, text: typeof item.text === "string" ? item.text.slice(0, 500_000) : "" }; }).filter((item) => item.text.trim().length > 0);
  const data = { title: typeof payload?.title === "string" ? payload.title.slice(0, 200) : "", messages };
  readConversationCache.set(cacheKey, { at: Date.now(), data });
  if (readConversationCache.size > READ_CACHE_MAX) { const oldest = readConversationCache.keys().next().value; if (oldest !== undefined) readConversationCache.delete(oldest); }
  return data;
}
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
ipcMain.handle("language:get", (event) => { requireRenderer(event); return appLanguage(); });
ipcMain.handle("language:set", async (event, value) => { requireRenderer(event); if (value !== "zh" && value !== "en") throw new Error("Invalid language"); setAppLanguage(value); await saveLanguagePreference(app.getPath("userData"), appLanguage()); refreshUpdateMessage(); rebuildTrayMenu(); return appLanguage(); });

function bundledExtensionDirectory(): string { return app.isPackaged ? join(process.resourcesPath, "chatgpt-browser-bridge-extension") : join(app.getAppPath(), "..", "..", "packages", "chatgpt-browser-bridge-extension"); }
// Chrome 实际加载的目录固定指向稳定目录（启动时同步最新扩展文件），
// 这样扩展的自动重载总能读到新文件，用户只需在 Chrome 里加载一次
let extensionDirOverride: string | null = null;
let expectedExtensionVersion: string | null = null;
// 扩展硬重载提示的状态：同一上报身份（版本+代码指纹）最多提示 2 次（避免重载风暴），
// 上报身份变化则重新计数
const reloadHintState = { reported: "", count: 0 };
let cachedDiskHash: { hash: string | null; at: number } | null = null;
async function diskExtensionCodeHash(): Promise<string | null> {
  // 短 TTL 缓存：每次状态轮询都会用到，避免频繁读盘；TTL 足够短，自愈覆写后很快生效
  if (cachedDiskHash && Date.now() - cachedDiskHash.at < 5_000) return cachedDiskHash.hash;
  const hash = await extensionCodeHash(extensionDirectory());
  cachedDiskHash = { hash, at: Date.now() };
  return hash;
}
async function updateExtensionReloadHint(): Promise<void> {
  const reported = bridge.reportedVersion();
  const reportedHash = bridge.reportedCodeHash();
  const diskHash = await diskExtensionCodeHash();
  // 版本落后（常规路径）或代码指纹漂移（同版本号文件被自愈覆写但 SW 未重启）都值得硬重载；
  // 指纹判断不依赖版本号，恰好覆盖版本比对发现不了的内容更新
  const versionBehind = Boolean(expectedExtensionVersion && reported && isNewerVersion(expectedExtensionVersion, reported));
  const codeDrift = Boolean(diskHash && reportedHash && reportedHash !== "hash-unavailable" && diskHash !== reportedHash);
  if (!versionBehind && !codeDrift) { reloadHintState.count = 0; bridge.setReloadHint(false); return; }
  const identity = `${reported || ""}|${reportedHash || ""}`;
  if (reloadHintState.reported !== identity) { reloadHintState.reported = identity; reloadHintState.count = 0; }
  if (reloadHintState.count >= 2) { bridge.setReloadHint(false); return; }
  reloadHintState.count += 1;
  logWarn(`extension reload hint #${reloadHintState.count}: versionBehind=${versionBehind}, codeDrift=${codeDrift}, reported=${reported || "?"}, hash=${reportedHash ? reportedHash.slice(0, 8) : "none"} vs disk=${diskHash ? diskHash.slice(0, 8) : "unknown"}`);
  bridge.setReloadHint(true);
}
// 桥接命令统一入口：超时且扩展明明在线时，诊断扩展是否是"无法自动升级的旧代码"，
// 把笼统的同步超时换成明确的重载指引。连接着却等满整个预算都没有结果，
// 在新版扩展的层层限时下几乎只会发生在缺少防护的旧 SW 上。
const STALE_EXTENSION_MESSAGE = "Extension code is outdated — reload it in chrome://extensions and retry";
async function bridgeRequest(type: BridgeCommandType, payload: unknown, timeoutMs?: number): Promise<BridgeResult> {
  try { return await (timeoutMs === undefined ? bridge.request(type, payload) : bridge.request(type, payload, timeoutMs)); }
  catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!/timed out/i.test(text) || !bridge.state().connected) throw error;
    const staleness = classifyExtensionStaleness({
      expectedVersion: expectedExtensionVersion,
      reportedVersion: bridge.reportedVersion(),
      reportedCodeHash: bridge.reportedCodeHash(),
      expectedCodeHash: await diskExtensionCodeHash(),
    });
    if (!shouldDemandReload(staleness)) throw error;
    logWarn(`bridge ${type} timed out while connected; extension staleness=${staleness}, reported=${bridge.reportedVersion() || "?"}, hash=${bridge.reportedCodeHash() ? bridge.reportedCodeHash()!.slice(0, 8) : "none"}`);
    throw new Error(STALE_EXTENSION_MESSAGE, { cause: error });
  }
}
function extensionDirectory(): string { return extensionDirOverride ?? bundledExtensionDirectory(); }

// MCP 端点描述文件：让本机 MCP server（Claude Code / Cline / Cursor 等客户端）发现本地服务。
// 密钥与 bridge-secret 同源，文件权限 0600；未配对时 secret 为 null，MCP 侧据此给出明确提示
const MCP_ENDPOINT_FILE = join(homedir(), ".conversation-manager", "mcp-endpoint.json");
function writeMcpEndpointFile(): void {
  const payload = { protocolVersion: 1, port: BRIDGE_PORT, secret: bridge.secretText(), pid: process.pid, version: app.getVersion(), updatedAt: new Date().toISOString() };
  mkdir(dirname(MCP_ENDPOINT_FILE), { recursive: true }).then(() => writeFile(MCP_ENDPOINT_FILE, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })).catch((error) => logWarn(`mcp endpoint file write failed: ${error instanceof Error ? error.message : String(error)}`));
}

// 本地 API 语义层：MCP 的 ChatGPT 工具全部路由到这里，与桌面 UI 共用同一条命令管线
async function handleLocalCommand(type: string, payload: unknown): Promise<unknown> {
  const input = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const resolveAccount = (): string => {
    const provided = typeof input.accountKey === "string" ? input.accountKey : "";
    if (provided) return requireAccount(provided);
    const first = indexStore.accounts()[0]?.key;
    if (!first) throw new Error("No ChatGPT account has been synced yet. Sync once in the desktop app first.");
    return first;
  };
  if (type === "chatgpt.status") {
    const state = bridge.state();
    return { paired: state.paired, extensionConnected: state.connected, version: app.getVersion(), accounts: indexStore.accounts().map((account) => ({ key: account.key, label: account.label })) };
  }
  if (type === "chatgpt.accounts") return { accounts: indexStore.accounts().map((account) => ({ key: account.key, label: account.label })) };
  if (type === "chatgpt.search") {
    const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
    const state = input.state === "active" || input.state === "archived" || input.state === "scheduled" ? input.state : null;
    const limit = typeof input.limit === "number" && input.limit >= 1 && input.limit <= 100 ? Math.floor(input.limit) : 20;
    const rows: Array<{ id: string; accountKey: string; title: string; state: string; createdAt: number | null; updatedAt: number | null; projectId: string | null }> = [];
    for (const account of indexStore.accounts()) {
      for (const st of ["active", "archived", "scheduled"] as const) {
        if (state && st !== state) continue;
        for (const record of indexStore.read(account.key, st)?.records ?? []) {
          if (query && !record.title.toLowerCase().includes(query)) continue;
          rows.push({ id: record.id, accountKey: account.key, title: record.title, state: st, createdAt: record.createdAt, updatedAt: record.updatedAt, projectId: record.projectId ?? null });
        }
      }
    }
    rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { total: rows.length, rows: rows.slice(0, limit) };
  }
  if (type === "chatgpt.read") return readConversationShared(resolveAccount(), requireId(input.id));
  if (type === "chatgpt.batch") {
    const action = input.action;
    if (action !== "archive" && action !== "restore") throw new Error("Only archive and restore are supported over the local API");
    const ids = requireIds(input.ids);
    return runChatGptBatch(resolveAccount(), action, ids);
  }
  if (type === "chatgpt.export") {
    const accountKey = resolveAccount();
    const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : null;
    if (!directory) throw new Error(M().noDirectory);
    const rawIds = Array.isArray(input.ids) ? input.ids : [];
    const items = rawIds.map((id) => ({ id: requireId(id), title: "" }));
    if (!items.length) throw new Error(M().noItems);
    return exportChatGptSessions(accountKey, directory, items);
  }
  throw new Error(`Unknown local command: ${type}`);
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
app.whenReady().then(async () => {
  nativeTheme.themeSource = await loadThemePreference();
  const userData = app.getPath("userData");
  initLogger(userData);
  if (process.platform === "darwin") {
    const bundle = macAppBundlePath(app.getPath("exe"));
    if (bundle) void cleanupMacInstallLeftovers(bundle);
  }
  const systemDefault: AppLanguage = app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en";
  setAppLanguage(await loadLanguagePreference(userData, process.platform === "darwin" ? systemDefault : "zh"));
  if (process.platform === "darwin") app.setAboutPanelOptions({ applicationName: "Conversation Manager", applicationVersion: app.getVersion(), credits: "ChatGPT · Codex · Ricardo-Ping", website: "https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager" });
  logInfo(M().appStart(app.getVersion(), String(app.isPackaged)));
  // 把最新扩展同步到稳定目录（必须在读取期望版本与启动桥接之前完成）
  try {
    const synced = await syncExtensionFiles(bundledExtensionDirectory(), join(homedir(), ".conversation-manager", "extension"));
    extensionDirOverride = synced.targetDir;
    if (synced.skipped.length) logWarn(`extension sync skipped locked files: ${synced.skipped.join(", ")}`);
  } catch (syncError) { logWarn(`extension sync to stable dir failed, falling back to bundled dir: ${syncError instanceof Error ? syncError.message : String(syncError)}`); }
  try {
    const saved = JSON.parse(await readFile(join(userData, "codex-command.json"), "utf8")) as { command?: unknown };
    if (typeof saved.command === "string" && saved.command.length <= 1_000) {
      codexCommand = saved.command;
      codex = new CodexAppServer(codexCommand);
    }
  } catch {}
  bridge = new ChatGptBridgeServer(join(userData, "bridge-secret"));
  bridge.onSecretChange(() => writeMcpEndpointFile());
  bridge.setLocalHandler(handleLocalCommand);
  indexStore = new ConversationIndexStore(join(userData, "conversation-index.json"));
  await indexStore.load();
  try {
    const bundled = JSON.parse(await readFile(join(extensionDirectory(), "manifest.json"), "utf8")) as { version?: unknown };
    if (isValidVersionFormat(bundled.version)) { bridge.setExpectedExtensionVersion(bundled.version); expectedExtensionVersion = bundled.version; }
  } catch {}
  // 自愈：若 Chrome/Edge 加载的是旧目录的扩展，把最新文件直接写进该目录——
  // 扩展下次轮询发现期望版本更新后自动 reload 即可拿到新代码，无需人工重载
  try {
    const browserUserDataDirs = [join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data"), join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "User Data")].filter((dir) => dir.length > 0);
    for (const healedPath of await healLoadedExtensionFolders(extensionDirectory(), browserUserDataDirs)) logInfo(`extension auto-heal: synced new files into loaded folder ${healedPath}`);
  } catch (healError) { logWarn(`extension auto-heal failed: ${healError instanceof Error ? healError.message : String(healError)}`); }
  try { await bridge.start(); } catch (startError) { logWarn(`bridge start failed, continuing without bridge: ${startError instanceof Error ? startError.message : String(startError)}`); }
  await applyStartupUpdatePreferences();
  refreshUpdateMessage();
  await createWindow();
  createQuickWindow();
  createTray();
  if (!globalShortcut.register("Alt+Shift+Space", toggleQuickSearch)) logWarn("global shortcut Alt+Shift+Space registration failed");
  scheduleAutomaticUpdates();
}).catch((error) => { logWarn(`startup failed: ${error instanceof Error ? error.message : String(error)}`); console.error(error); app.quit(); });
app.on("before-quit", () => { isQuitting = true; globalShortcut.unregisterAll(); });
app.on("window-all-closed", () => { shutdownUpdaterTimers(); codex.close(); void bridge?.close(); if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
