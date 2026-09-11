import { useCallback, useEffect, useRef, useState } from "react";
import type { PairingState } from "@conversation-manager/chatgpt-bridge-server";
import type { ThemePreference, UpdateState } from "./global.js";
import { relativeTime } from "./conversation-viewer.js";
import { t, type Lang } from "./strings.js";
import { Segmented } from "./segmented.js";
import { friendlyError } from "./ui-format.js";

export function useExtensionDirectory(): string {
  const [directory, setDirectory] = useState("");
  useEffect(() => { void window.conversationManager.chatgpt.extensionDirectory().then(setDirectory).catch(() => {}); }, []);
  return directory;
}

export function ExtensionPath({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return <div className="extension-path">
    <div className="extension-path-head"><span>{label}</span><button type="button" onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {})}>{copied ? t("已复制") : t("复制路径")}</button></div>
    <code>{value}</code>
  </div>;
}

function LogCard() {
  const [lines, setLines] = useState<string[]>([]); const [savedPath, setSavedPath] = useState(""); const [autoScroll, setAutoScroll] = useState(true);
  const viewRef = useRef<HTMLPreElement>(null);
  const refresh = useCallback(() => void window.conversationManager.logs.read().then((content) => setLines(content ? content.replace(/\n$/, "").split("\n") : [])), []);
  useEffect(() => { refresh(); return window.conversationManager.logs.onLine((line) => setLines((old) => [...old.slice(-499), line])); }, [refresh]);
  useEffect(() => { const node = viewRef.current; if (node && autoScroll) node.scrollTop = node.scrollHeight; }, [lines, autoScroll]);
  return <article className="log-card"><h2>{t("运行日志")}</h2><p>{t("应用运行事件的实时输出，仅保存在本机，用于问题排查。")}</p>
    <pre className="log-view" ref={viewRef}>{lines.length ? lines.join("\n") : t("暂无日志")}</pre>
    <div className="card-actions">
      <button onClick={refresh}>{t("刷新日志")}</button>
      <button onClick={() => void window.conversationManager.logs.clear().then(() => { setLines([]); setSavedPath(""); })}>{t("清空日志")}</button>
      <button onClick={() => void window.conversationManager.logs.save().then((result) => { if (result.saved && result.path) setSavedPath(t("已保存到 {path}", { path: result.path })); })}>{t("保存日志")}</button>
      <label className="toggle"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />{t("自动滚动")}</label>
    </div>
    {savedPath && <p className="pair-feedback">{savedPath}</p>}
  </article>;
}

function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }

export function Settings({ version, lang, onLanguage, onCodexStatus }: { version: string; lang: Lang; onLanguage(value: Lang): void; onCodexStatus?(available: boolean): void }) {
  const [update, setUpdate] = useState<UpdateState | null>(null); const [bridge, setBridge] = useState<PairingState | null>(null); const [cache, setCache] = useState<{ accounts: number; records: number; bytes: number; lastSyncedAt: number | null; lastFullSyncedAt: number | null } | null>(null); const [codexStatus, setCodexStatus] = useState<{ available: boolean; message: string; command: string } | null>(null); const [theme, setTheme] = useState<ThemePreference>("system"); const [pairMessage, setPairMessage] = useState("");
  const extensionDirectory = useExtensionDirectory();
  const [loginItem, setLoginItem] = useState(false);
  useEffect(() => { void window.conversationManager.startup.get().then(setLoginItem).catch(() => {}); }, []);
  const readCodexStatus = () => void window.conversationManager.codex.status().then((value) => { setCodexStatus(value); onCodexStatus?.(value.available); });
  useEffect(() => { void window.conversationManager.updates.getState().then(setUpdate); void window.conversationManager.chatgpt.state().then(setBridge); void window.conversationManager.chatgpt.cacheStats().then(setCache); void window.conversationManager.theme.get().then(setTheme); readCodexStatus(); return window.conversationManager.updates.onState(setUpdate); }, []);
  const changeTheme = (value: ThemePreference) => { setTheme(value); void window.conversationManager.theme.set(value); };
  return <section className="settings"><p className="eyebrow">Conversation Manager v{version}</p><h1>{t("设置与隐私")}</h1><div className="settings-grid">
    <article><h2>{t("外观")}</h2><p>{t("界面默认跟随系统深色模式自动切换，也可以手动固定为浅色或深色。")}</p><div className="card-actions"><Segmented value={theme} options={[["system", t("跟随系统")], ["light", t("浅色")], ["dark", t("深色")]] as Array<[ThemePreference, string]>} onChange={changeTheme} aria-label={t("外观")}/></div><p style={{ marginTop: 12 }}>{t("语言 / Language")}</p><div className="card-actions"><Segmented value={lang} options={[["zh", "中文"], ["en", "English"]] as Array<[Lang, string]>} onChange={onLanguage} aria-label={t("语言 / Language")}/></div></article>
    <article><h2>{t("浏览器桥接")}</h2><p>{bridge?.connected ? `${t("已连接")}${bridge.extensionVersion && bridge.extensionVersion !== version ? ` · ${t("扩展 v{ext} · 需重载", { ext: bridge.extensionVersion })}` : ""}` : bridge?.paired ? t("已配对，等待浏览器") : t("尚未配对")}</p>{!bridge?.connected && <p>{t("无需手动配对：桌面端运行时，浏览器扩展会自动完成连接。")}</p>}{pairMessage && <p className="pair-feedback">{pairMessage}</p>}<ExtensionPath label={t("扩展目录")} value={extensionDirectory} /><div className="card-actions"><button onClick={() => { setPairMessage(t("正在清除…")); void window.conversationManager.chatgpt.clearPairing().then((value) => { setBridge(value); setPairMessage(t("已清除配对。桌面端运行时，扩展会在后台自动重新配对。")); }); }}>{t("清除配对")}</button><button onClick={() => void window.conversationManager.chatgpt.showExtension()}>{t("打开扩展目录")}</button></div></article>
    <article><h2>{t("ChatGPT 缓存")}</h2><p>{cache ? `${t("{n} 条记录", { n: cache.records })} · ${formatBytes(cache.bytes)}${cache.lastSyncedAt ? ` · ${t("{t}同步", { t: relativeTime(cache.lastSyncedAt) })}` : ""}${cache.lastFullSyncedAt ? ` · ${t("{t}完整校准", { t: relativeTime(cache.lastFullSyncedAt) })}` : ""}` : t("正在读取…")}</p><div className="card-actions"><button onClick={() => void window.conversationManager.chatgpt.clearCache().then(setCache)}>{t("清除缓存")}</button></div></article>
    <article><h2>{t("Codex 后端")}</h2><p>{codexStatus?.message || t("正在自动检测统一桌面客户端…")}</p><ExtensionPath label={t("Codex 命令")} value={codexStatus?.command || ""} /><div className="card-actions">{codexStatus?.available === false && <button onClick={() => void window.conversationManager.codex.selectCommand().then(readCodexStatus)}>{t("手动选择（兜底）")}</button>}</div></article>
    <article><h2>{t("自动更新")}</h2><p>{update?.message}</p><label className="toggle"><input type="checkbox" checked={update?.autoUpdate ?? true} onChange={(event) => void window.conversationManager.updates.setAutoUpdate(event.target.checked).then(setUpdate)}/>{t("默认自动检查更新")}</label><div className="card-actions">{update?.autoUpdate === false && <button onClick={() => void window.conversationManager.updates.check()}>{t("立即检查")}</button>}{update?.phase === "available" && !update.canAutoInstall && /Mac/i.test(navigator.platform) && <button onClick={() => void window.conversationManager.updates.download().catch(() => {})}>{t("下载更新")}</button>}{update?.phase === "available" && !update.canAutoInstall && <button onClick={() => void window.conversationManager.updates.openRelease()}>{t("打开下载页")}</button>}{update?.phase === "downloaded" && !update.canAutoInstall && /Mac/i.test(navigator.platform) && <button onClick={() => void window.conversationManager.updates.install().catch(() => {})}>{t("重启安装")}</button>}</div></article>
    <article><h2>{t("开机启动")}</h2><p>{t("登录系统时自动启动 Conversation Manager，默认关闭。")}</p><div className="card-actions"><label className="toggle"><input type="checkbox" checked={loginItem} onChange={(event) => void window.conversationManager.startup.set(event.currentTarget.checked).then(setLoginItem).catch(() => {})}/>{t("开机时自动启动")}</label></div></article>
    <article><h2>{t("数据备份")}</h2><p>{t("导出或恢复应用数据（缓存索引、偏好设置），用于备份或迁移到其他设备。")}</p><div className="card-actions"><button onClick={async () => { const picked = await window.conversationManager.dialog.pickDirectory(); if (!picked.directory) return; try { const r = await window.conversationManager.data.exportData(picked.directory); setPairMessage(t("已导出 {n} 个数据文件到 {dir}", { n: r.copied, dir: r.directory })); } catch (cause) { setPairMessage(friendlyError(cause)); } }}>{t("导出数据")}</button><button onClick={async () => { const picked = await window.conversationManager.dialog.pickDirectory(); if (!picked.directory) return; try { const r = await window.conversationManager.data.importData(picked.directory); setPairMessage(t("已恢复 {n} 个数据文件（缓存与部分设置在重启后完全生效）", { n: r.restored })); } catch (cause) { setPairMessage(friendlyError(cause)); } }}>{t("恢复数据")}</button></div></article>
    <article><h2>{t("Codex 会话迁移")}</h2><p>{t("把本机全部 Codex 会话打包为 zip，在其他电脑导入后即可继续这些会话；不包含登录凭据。")}</p><div className="card-actions"><button onClick={async () => { try { const r = await window.conversationManager.codex.exportSessionsArchive(); if (r.cancelled) return; setPairMessage(r.count ? t("已导出 {n} 个会话到 {file}", { n: r.count, file: r.file ?? "" }) : t("没有可导出的 Codex 会话")); } catch (cause) { setPairMessage(friendlyError(cause)); } }}>{t("导出 Codex 会话")}</button><button onClick={async () => { try { const r = await window.conversationManager.codex.importSessionsArchive(); if (r.cancelled) return; setPairMessage(t("已导入 {n} 个会话（跳过 {s} 个已存在）", { n: r.imported ?? 0, s: r.skipped ?? 0 })); } catch (cause) { setPairMessage(friendlyError(cause)); } }}>{t("导入 Codex 会话")}</button></div></article>
    <article><h2>{t("隐私边界")}</h2><p>{t("管理器只保存会话标题、ID、时间和状态。Cookie、访问令牌、正文及 Codex 认证文件不会被读取或复制。")}</p></article>
    <article><h2>{t("连接方式")}</h2><p>{t("ChatGPT 会话复用 Chrome/Edge 登录；统一 ChatGPT/Codex 桌面客户端中的 Codex 任务通过自动发现的本机 App Server 读取。两者都不在管理器中重复登录。")}</p></article>
    <LogCard />
  </div></section>;
}
