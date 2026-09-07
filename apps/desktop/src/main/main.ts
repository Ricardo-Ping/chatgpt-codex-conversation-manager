import { app, BrowserWindow, ipcMain, session, shell, WebContentsView, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronUpdater from "electron-updater";
import { CodexAppServer } from "@cgn/codex-app-server-adapter";
import { extensionDirectory, loadChatGptExtension } from "@cgn/chatgpt-web-adapter";
import { DEFAULT_AUTO_UPDATE, parseAutoUpdatePreference, supportsAutomaticInstallation } from "./update-policy.js";

const { autoUpdater } = electronUpdater;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_PARTITION = "persist:cgn-chatgpt";
const CHAT_URL = "https://chatgpt.com/";
const RELEASE_URL = "https://github.com/Ricardo-Ping/chatgpt-codex-conversation-navigator-desktop/releases";
const SIDEBAR_WIDTH = 252;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const codex = new CodexAppServer();

if (app.isPackaged) app.setAsDefaultProtocolClient("cgn");

let mainWindow: BrowserWindow | null = null;
let chatView: WebContentsView | null = null;
let chatAttached = false;
let chatSecurityInstalled = false;
const securedChatContents = new Set<number>();
const deleteConfirmations = new Map<string, { ids: string[]; fingerprint: string; expiresAt: number }>();
const canAutoInstallUpdate = supportsAutomaticInstallation(app.isPackaged, process.platform, process.env.PORTABLE_EXECUTABLE_FILE);
let autoUpdateEnabled = DEFAULT_AUTO_UPDATE;
let updateStartupTimer: NodeJS.Timeout | null = null;
let updateInterval: NodeJS.Timeout | null = null;
let updateState = {
  phase: app.isPackaged ? "idle" : "unsupported",
  currentVersion: app.getVersion(),
  version: null as string | null,
  percent: null as number | null,
  message: app.isPackaged ? "等待检查更新" : "开发模式不检查更新",
  autoUpdate: autoUpdateEnabled,
  canAutoInstall: canAutoInstallUpdate
};

function publishUpdateState(patch: Partial<typeof updateState>): void {
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:state", updateState);
}

async function loadUpdatePreference(): Promise<boolean> {
  try {
    const raw = await readFile(join(app.getPath("userData"), "update-preferences.json"), "utf8");
    return parseAutoUpdatePreference((JSON.parse(raw) as { autoUpdate?: unknown }).autoUpdate);
  } catch {
    return DEFAULT_AUTO_UPDATE;
  }
}

async function saveUpdatePreference(value: boolean): Promise<void> {
  const directory = app.getPath("userData");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "update-preferences.json"), `${JSON.stringify({ autoUpdate: value }, null, 2)}\n`, "utf8");
}

async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged || updateState.phase === "checking" || updateState.phase === "downloading") return;
  publishUpdateState({ phase: "checking", percent: null, message: "正在检查 GitHub Releases…" });
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    publishUpdateState({ phase: "error", message: "检查更新失败，请稍后重试" });
  }
}

function scheduleAutomaticUpdates(): void {
  if (updateStartupTimer) clearTimeout(updateStartupTimer);
  if (updateInterval) clearInterval(updateInterval);
  updateStartupTimer = null;
  updateInterval = null;
  if (!app.isPackaged || !autoUpdateEnabled) return;
  updateStartupTimer = setTimeout(() => void checkForUpdates(), 10_000);
  updateInterval = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
  updateStartupTimer.unref();
  updateInterval.unref();
}

function configureUpdater(): void {
  autoUpdater.allowPrerelease = app.getVersion().includes("-");
  autoUpdater.autoDownload = canAutoInstallUpdate;
  autoUpdater.autoInstallOnAppQuit = canAutoInstallUpdate;
  autoUpdater.logger = null;
  autoUpdater.on("checking-for-update", () => publishUpdateState({ phase: "checking", percent: null, message: "正在检查 GitHub Releases…" }));
  autoUpdater.on("update-available", (info) => publishUpdateState({
    phase: "available",
    version: info.version,
    message: canAutoInstallUpdate ? `发现 v${info.version}，正在下载` : `发现 v${info.version}，请前往 Release 下载`
  }));
  autoUpdater.on("update-not-available", (info) => publishUpdateState({ phase: "not-available", version: info.version, percent: null, message: "当前已是最新版本" }));
  autoUpdater.on("download-progress", (progress) => publishUpdateState({ phase: "downloading", percent: Math.round(progress.percent), message: `正在下载更新 ${Math.round(progress.percent)}%` }));
  autoUpdater.on("update-downloaded", (info) => publishUpdateState({ phase: "downloaded", version: info.version, percent: 100, message: `v${info.version} 已下载，可重启安装` }));
  autoUpdater.on("error", () => publishUpdateState({ phase: "error", message: "更新失败，请手动打开 Release 页面" }));
}

function allowedRemoteUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "chatgpt.com"
      || host === "openai.com"
      || host.endsWith(".openai.com")
      || host === "accounts.google.com"
      || host === "login.microsoftonline.com"
      || host === "login.live.com";
  } catch {
    return false;
  }
}

function requireRenderer(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Untrusted IPC sender");
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new Error("Invalid task ID");
  return value;
}

function secureChatContents(contents: WebContents): void {
  if (securedChatContents.has(contents.id)) return;
  securedChatContents.add(contents.id);
  contents.once("destroyed", () => securedChatContents.delete(contents.id));
  contents.on("will-navigate", (event, url) => {
    if (!allowedRemoteUrl(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (allowedRemoteUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { partition: CHAT_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true }
        }
      };
    }
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

function updateChatBounds(): void {
  if (!mainWindow || !chatView || !chatAttached) return;
  const size = mainWindow.getContentSize();
  chatView.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(1, (size[0] ?? 1) - SIDEBAR_WIDTH), height: size[1] ?? 1 });
}

function setMode(mode: "chatgpt" | "codex" | "settings"): void {
  if (!mainWindow || !chatView) return;
  if (mode === "chatgpt" && !chatAttached) {
    mainWindow.contentView.addChildView(chatView);
    chatAttached = true;
    updateChatBounds();
  } else if (mode !== "chatgpt" && chatAttached) {
    mainWindow.contentView.removeChildView(chatView);
    chatAttached = false;
  }
}

async function createChatView(): Promise<WebContentsView> {
  const chatSession = session.fromPartition(CHAT_PARTITION);
  const extensionPath = extensionDirectory(app.getAppPath(), process.resourcesPath, app.isPackaged);
  await loadChatGptExtension(chatSession, extensionPath);

  chatSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const safePermission = permission === "clipboard-sanitized-write" || permission === "fullscreen";
    callback(safePermission && allowedRemoteUrl(webContents.getURL()));
  });
  if (!chatSecurityInstalled) {
    app.on("web-contents-created", (_event, contents) => {
      if (contents.session === chatSession) secureChatContents(contents);
    });
    chatSecurityInstalled = true;
  }

  const view = new WebContentsView({
    webPreferences: {
      partition: CHAT_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  secureChatContents(view.webContents);
  await view.webContents.loadURL(CHAT_URL);
  return view;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "CGN Desktop",
    autoHideMenuBar: true,
    backgroundColor: "#f6fafb",
    webPreferences: {
      preload: join(__dirname, "..", "..", "src", "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  await mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"));
  chatView = await createChatView();
  setMode("chatgpt");
  mainWindow.on("resize", updateChatBounds);
  mainWindow.on("closed", () => {
    chatView?.webContents.close();
    chatView = null;
    mainWindow = null;
    chatAttached = false;
  });
}

ipcMain.handle("view:set-mode", (event, mode: unknown) => {
  requireRenderer(event);
  if (mode !== "chatgpt" && mode !== "codex" && mode !== "settings") throw new Error("Invalid view mode");
  setMode(mode);
});

ipcMain.handle("app:version", (event) => {
  requireRenderer(event);
  return app.getVersion();
});

ipcMain.handle("update:get-state", (event) => {
  requireRenderer(event);
  return updateState;
});

ipcMain.handle("update:set-auto", async (event, value: unknown) => {
  requireRenderer(event);
  if (typeof value !== "boolean") throw new Error("Invalid update preference");
  await saveUpdatePreference(value);
  autoUpdateEnabled = value;
  publishUpdateState({ autoUpdate: value });
  scheduleAutomaticUpdates();
  if (value) void checkForUpdates();
  return updateState;
});

ipcMain.handle("update:check", async (event) => {
  requireRenderer(event);
  await checkForUpdates();
  return updateState;
});

ipcMain.handle("update:install", (event) => {
  requireRenderer(event);
  if (!canAutoInstallUpdate || updateState.phase !== "downloaded") throw new Error("Update is not ready to install");
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle("update:open-release", async (event) => {
  requireRenderer(event);
  await shell.openExternal(RELEASE_URL);
});

ipcMain.handle("external:open", async (event, value: unknown) => {
  requireRenderer(event);
  if (typeof value !== "string" || !/^https:\/\//i.test(value)) throw new Error("Invalid external URL");
  await shell.openExternal(value);
});

ipcMain.handle("codex:list", async (event, params: unknown) => {
  requireRenderer(event);
  const input = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  return codex.list({
    cursor: typeof input.cursor === "string" ? input.cursor : null,
    limit: 100,
    archived: input.archived === true,
    searchTerm: typeof input.searchTerm === "string" ? input.searchTerm.slice(0, 200) : null,
    full: input.full === true
  });
});

ipcMain.handle("codex:read", async (event, value: unknown) => {
  requireRenderer(event);
  return codex.read(requireId(value));
});

ipcMain.handle("codex:fork", async (event, value: unknown) => {
  requireRenderer(event);
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const lastTurnId = input.lastTurnId === undefined ? undefined : requireId(input.lastTurnId);
  return codex.fork(requireId(input.threadId), lastTurnId);
});

ipcMain.handle("codex:preview-delete", async (event, value: unknown) => {
  requireRenderer(event);
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new Error("Invalid task selection");
  const ids = [...new Set(value.map(requireId))].sort();
  const preview = await codex.previewDelete(ids);
  let confirmationToken: string | null = null;
  if (!preview.missing.length && !preview.running.length) {
    confirmationToken = randomUUID();
    deleteConfirmations.set(confirmationToken, { ids, fingerprint: preview.fingerprint, expiresAt: Date.now() + 120_000 });
  }
  return {
    tasks: preview.records.map((record) => ({
      id: record.id,
      title: record.name?.trim() || record.preview?.trim() || "未命名任务",
      derived: !ids.includes(record.id)
    })),
    missing: preview.missing,
    running: preview.running,
    confirmationToken
  };
});

ipcMain.handle("codex:batch", async (event, value: unknown) => {
  requireRenderer(event);
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const action = input.action;
  if (action !== "archive" && action !== "unarchive" && action !== "delete") throw new Error("Invalid batch action");
  if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.length > 500) throw new Error("Invalid task selection");
  const ids = [...new Set(input.ids.map(requireId))].sort();
  if (action === "delete") {
    const token = typeof input.confirmationToken === "string" ? input.confirmationToken : "";
    const confirmation = deleteConfirmations.get(token);
    deleteConfirmations.delete(token);
    if (!confirmation || confirmation.expiresAt < Date.now() || JSON.stringify(confirmation.ids) !== JSON.stringify(ids)) {
      throw new Error("删除确认已过期，请重新预览");
    }
    const current = await codex.previewDelete(ids);
    if (current.missing.length || current.running.length || current.fingerprint !== confirmation.fingerprint) {
      throw new Error("任务状态已变化，请重新预览后再删除");
    }
  }
  const succeeded: string[] = [];
  const failed: Array<{ id: string; message: string }> = [];
  for (const id of ids) {
    try {
      if (action !== "delete") {
        const current = await codex.read(id);
        if (current.thread.status?.type === "active") throw new Error("运行中的任务不能批量操作");
      }
      if (action === "archive") await codex.archive(id);
      else if (action === "unarchive") await codex.unarchive(id);
      else await codex.delete(id);
      succeeded.push(id);
    } catch (error) {
      failed.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { succeeded, failed };
});

app.whenReady().then(async () => {
  autoUpdateEnabled = await loadUpdatePreference();
  updateState = { ...updateState, currentVersion: app.getVersion(), autoUpdate: autoUpdateEnabled };
  configureUpdater();
  await createWindow();
  scheduleAutomaticUpdates();
}).catch((error) => {
  console.error(error);
  app.quit();
});
app.on("window-all-closed", () => {
  if (updateStartupTimer) clearTimeout(updateStartupTimer);
  if (updateInterval) clearInterval(updateInterval);
  codex.close();
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
