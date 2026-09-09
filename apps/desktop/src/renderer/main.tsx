import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { bulkSelectableIds, filterConversations, type AgeFilter, type ConversationState, type ManagedConversation } from "@conversation-manager/conversation-domain";
import type { CachedConversation, PairingState } from "@conversation-manager/chatgpt-bridge-server";
import type { CodexThread } from "@conversation-manager/codex-app-server-adapter";
import type { ThemePreference, UpdateState } from "./global.js";
import { groupCodexConversations, isProjectTask } from "./codex-groups.js";
import { initialLanguage, setLanguage, t, type Lang } from "./strings.js";
import iconUrl from "./icon.png";
import "./styles.css";
import "./project-groups.css";

type Page = "chatgpt" | "codex" | "settings";
type Account = { key: string; label: string; isDefault: boolean };
type ConfirmOptions = { title: string; body: string; items?: string[]; requireCount?: number };
const ageOptions: Array<[AgeFilter, string]> = [["all", "全部"], ["day", "1 天前"], ["week", "1 周前"], ["month", "1 个月前"], ["halfYear", "半年前"]];
const stateLabels: Record<ConversationState, string> = { active: "未归档", archived: "已归档", scheduled: "已安排" };
const BACKGROUND_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const BACKGROUND_ROTATE_INTERVAL_MS = 30 * 60 * 1000;

function Segmented<T extends string>(props: { value: T; options: Array<[T, React.ReactNode]>; onChange(value: T): void; vertical?: boolean; className?: string; "aria-label"?: string }) {
  const nodes = useRef(new Map<T, HTMLButtonElement>());
  const [pill, setPill] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const measure = useCallback(() => { const node = nodes.current.get(props.value); if (!node) return; const next = { x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight }; setPill((old) => old && old.x === next.x && old.y === next.y && old.width === next.width && old.height === next.height ? old : next); }, [props.value]);
  useLayoutEffect(() => { measure(); });
  return <div className={`segments${props.vertical ? " vertical" : ""}${props.className ? ` ${props.className}` : ""}`} role="tablist" aria-label={props["aria-label"]}>
    {pill && <span className="segment-pill" style={{ transform: `translate(${pill.x}px, ${pill.y}px)`, width: pill.width, height: pill.height }} aria-hidden="true" />}
    {props.options.map(([value, label]) => <button type="button" key={value} role="tab" aria-selected={props.value === value} ref={(node) => { if (node) nodes.current.set(value, node); else nodes.current.delete(value); }} className={props.value === value ? "active" : ""} onClick={() => props.onChange(value)}>{label}</button>)}
  </div>;
}

function App() {
  const [page, setPage] = useState<Page>("chatgpt");
  const [lastWorkspace, setLastWorkspace] = useState<"chatgpt" | "codex">("chatgpt");
  const openWorkspace = useCallback((next: "chatgpt" | "codex") => { setPage(next); setLastWorkspace(next); }, []);
  const toggleSettings = useCallback(() => setPage((current) => current === "settings" ? lastWorkspace : "settings"), [lastWorkspace]);
  const [lang, setLang] = useState<Lang>(initialLanguage());
  const changeLanguage = useCallback((next: Lang) => { setLanguage(next); setLang(next); void window.conversationManager.setAppLanguage(next); }, []);
  const [version, setVersion] = useState("");
  const [bridge, setBridge] = useState<PairingState>({ paired: false, connected: false, code: null, expiresAt: null, extensionVersion: null });
  const [codexReady, setCodexReady] = useState<boolean | null>(null);
  const [workspaceStates, setWorkspaceStates] = useState<{ chatgpt: ConversationState; codex: ConversationState }>({ chatgpt: "active", codex: "active" });
  const [workspaceKinds, setWorkspaceKinds] = useState<{ chatgpt: "chat" | "work" }>({ chatgpt: "chat" });
  const [chatCounts, setChatCounts] = useState<Partial<Record<ConversationState, { chat: number; work: number }>>>({});
  const [codexCounts, setCodexCounts] = useState<Partial<Record<ConversationState, number>>>({});
  const reportCodexStatus = useCallback((available: boolean) => setCodexReady(available), []);
  const setWorkspaceState = useCallback((value: ConversationState) => setWorkspaceStates((old) => ({ ...old, [page === "codex" ? "codex" : "chatgpt"]: value })), [page]);
  useEffect(() => { void window.conversationManager.appVersion().then(setVersion); }, []);
  useEffect(() => { const read = () => void window.conversationManager.chatgpt.state().then(setBridge); read(); const timer = window.setInterval(read, 3000); return () => window.clearInterval(timer); }, []);
  const extensionMismatch = Boolean(bridge.extensionVersion && version && bridge.extensionVersion !== version);
  const bridgeDot = extensionMismatch ? "warn" : bridge.connected ? "ok" : bridge.paired ? "warn" : "off";
  const bridgeText = extensionMismatch ? t("扩展 v{ext} · 需重载", { ext: bridge.extensionVersion ?? "" }) : bridge.connected ? t("已连接") : bridge.paired ? t("等待浏览器") : t("未配对");
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src={iconUrl} alt="" /><div><strong>Conversation Manager</strong><small>ChatGPT · Codex</small></div></div>
      <nav className="side-nav" aria-label={t("会话状态")}>
        <button type="button" className={`side-item ${page === "chatgpt" ? "active" : ""}`} aria-current={page === "chatgpt" ? "page" : undefined} onClick={() => openWorkspace("chatgpt")}><span className={`dot ${bridgeDot}`} title={extensionMismatch ? t("浏览器扩展为 v{ext}，与主程序 v{app} 不一致，请在 chrome://extensions 中重新加载", { ext: bridge.extensionVersion ?? "", app: version }) : bridge.connected ? t("桥接已连接") : bridge.paired ? t("已配对，等待浏览器") : t("未配对")}></span>ChatGPT</button>
        <button type="button" className={`side-item ${page === "codex" ? "active" : ""}`} aria-current={page === "codex" ? "page" : undefined} onClick={() => openWorkspace("codex")}><span className={`dot ${codexReady === true ? "ok" : codexReady === false ? "off" : "wait"}`} title={codexReady === true ? t("App Server 已连接") : codexReady === false ? t("未连接") : t("检测中")}></span>Codex</button>
      </nav>
      {page !== "settings" && <div className="side-states">
        <p className="side-states-label">{t("会话状态")}</p>
        <Segmented vertical value={page === "codex" ? workspaceStates.codex : workspaceStates.chatgpt} options={(page === "codex" ? (["active", "archived"] as ConversationState[]) : (["active", "archived", "scheduled"] as ConversationState[])).map((value) => { const split = chatCounts[value]; const count = page === "chatgpt" ? (split ? (workspaceKinds.chatgpt === "work" ? split.work : split.chat) : undefined) : codexCounts[value]; return [value, <React.Fragment key={value}>{t(stateLabels[value])}{typeof count === "number" && <span className="count">{count}</span>}</React.Fragment>] as [ConversationState, React.ReactNode]; })} onChange={setWorkspaceState} aria-label={t("会话状态")}/>
      </div>}
      <div className="side-status" aria-label={t("连接状态")}>
        <p className={extensionMismatch ? "stale" : undefined}><span className={`dot ${bridgeDot}`}></span><strong>{t("ChatGPT 桥接")}</strong>{bridgeText}</p>
        <p><span className={`dot ${codexReady === true ? "ok" : codexReady === false ? "off" : "wait"}`}></span><strong>{t("Codex 服务")}</strong>{codexReady === true ? t("已连接") : codexReady === false ? t("未连接") : t("检测中")}</p>
      </div>
      <div className="side-footer">
        <button type="button" className={`side-item ${page === "settings" ? "active" : ""}`} title={page === "settings" ? t("返回上一页面") : t("设置")} onClick={toggleSettings}><span aria-hidden="true">⚙</span>{page === "settings" ? t("返回") : t("设置")}</button>
        <small className="side-version">v{version}</small>
      </div>
    </aside>
    <main className="content">{page === "chatgpt" ? <ChatGptWorkspace bridge={bridge} state={workspaceStates.chatgpt} onState={(value) => setWorkspaceStates((old) => ({ ...old, chatgpt: value }))} kind={workspaceKinds.chatgpt} onKind={(value) => setWorkspaceKinds({ chatgpt: value })} onCounts={setChatCounts} /> : page === "codex" ? <CodexWorkspace onStatus={reportCodexStatus} state={workspaceStates.codex} onState={(value) => setWorkspaceStates((old) => ({ ...old, codex: value }))} onCounts={setCodexCounts} /> : <Settings version={version} lang={lang} onLanguage={changeLanguage} onCodexStatus={reportCodexStatus} />}</main>
  </div>;
}

function useConfirm(): { confirm(options: ConfirmOptions): Promise<boolean>; dialog: React.ReactNode } {
  const [state, setState] = useState<(ConfirmOptions & { resolve(value: boolean): void }) | null>(null);
  const [match, setMatch] = useState(false);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => { setMatch(false); setState({ ...options, resolve }); }), []);
  const close = useCallback((value: boolean) => setState((current) => { current?.resolve(value); return null; }), []);
  useEffect(() => { if (!state) return; const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(false); }; document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey); }, [state, close]);
  const dialog = state ? <div className="dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(false); }}>
    <div className="dialog" role="alertdialog" aria-modal="true" aria-label={state.title}>
      <h2>{state.title}</h2>
      <p>{state.body}</p>
      {state.items && state.items.length > 0 && <ul className="dialog-items">{state.items.slice(0, 6).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}{state.items.length > 6 && <li className="more">{t("其余 {n} 条", { n: state.items.length - 6 })}</li>}</ul>}
      {state.requireCount !== undefined && <input className="dialog-input" autoFocus placeholder={t("输入 {n} 以确认", { n: state.requireCount })} onChange={(event) => setMatch(event.currentTarget.value === String(state.requireCount))} onKeyDown={(event) => { if (event.key === "Enter" && event.currentTarget.value === String(state.requireCount)) close(true); }} />}
      <div className="dialog-actions"><button type="button" onClick={() => close(false)}>{t("取消")}</button><button type="button" className="danger" disabled={state.requireCount !== undefined && !match} onClick={() => close(true)}>{t("确认删除")}</button></div>
    </div>
  </div> : null;
  return { confirm, dialog };
}

function deleteConfirmOptions(ids: string[], records: ManagedConversation[], unit: string): ConfirmOptions {
  return { title: t("永久删除 {n} 条{unit}", { n: ids.length, unit }), body: t("此操作无法撤销，删除后无法恢复。"), items: records.filter((record) => ids.includes(record.id)).slice(0, 6).map((record) => record.title), requireCount: ids.length > 20 ? ids.length : undefined };
}

function ChatGptWorkspace({ bridge, state, onState, kind, onKind, onCounts }: { bridge: PairingState; state: ConversationState; onState(state: ConversationState): void; kind: "chat" | "work"; onKind(value: "chat" | "work"): void; onCounts(counts: Partial<Record<ConversationState, { chat: number; work: number }>>): void }) {
  const [accounts, setAccounts] = useState<Account[]>([]); const [accountKey, setAccountKey] = useState("");
  const [records, setRecords] = useState<ManagedConversation[]>([]); const [syncedAt, setSyncedAt] = useState<number | null>(null); const [compatible, setCompatible] = useState(false); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const syncingViewsRef = useRef(new Set<string>()); const currentViewRef = useRef(""); currentViewRef.current = `${accountKey}:${state}`;
  const { confirm, dialog } = useConfirm();
  useEffect(() => { void window.conversationManager.chatgpt.cachedAccounts().then((value) => { setAccounts(value.accounts); setAccountKey(value.accounts[0]?.key || ""); }); }, []);
  useEffect(() => { if (!bridge.connected) return; void window.conversationManager.chatgpt.accounts().then((value) => { setAccounts(value.accounts); setAccountKey((old) => old || value.accounts.find((item) => item.isDefault)?.key || value.accounts[0]?.key || ""); }).catch((cause) => setError(message(cause))); }, [bridge.connected]);
  async function refreshCounts(key = accountKey): Promise<void> { if (!key) { onCounts({}); return; } const next: Partial<Record<ConversationState, { chat: number; work: number }>> = {}; for (const value of ["active", "archived", "scheduled"] as ConversationState[]) { try { const rows = (await window.conversationManager.chatgpt.cached(key, value as CachedConversation["state"]))?.records ?? []; next[value] = { chat: rows.filter((row) => !row.projectId).length, work: rows.filter((row) => Boolean(row.projectId)).length }; } catch {} } onCounts(next); }
  useEffect(() => { if (!accountKey) return; void refreshCounts(accountKey); }, [accountKey]);
  useEffect(() => { if (!accountKey) return; const view = `${accountKey}:${state}`; setRecords([]); setSyncedAt(null); setNotice(""); setCompatible(false); void window.conversationManager.chatgpt.cached(accountKey, state as CachedConversation["state"]).then((cache) => { if (currentViewRef.current !== view) return; if (cache) { setRecords(cache.records.map(toChatManaged)); setSyncedAt(cache.syncedAt); } if (bridge.connected) void sync(false); }); }, [accountKey, state, bridge.connected]);
  useEffect(() => { if (!accountKey || !bridge.connected) return; const timer = setInterval(() => { if (document.visibilityState === "visible") void sync(false); }, BACKGROUND_SYNC_INTERVAL_MS); return () => clearInterval(timer); }, [accountKey, state, bridge.connected]);
  async function sync(full: boolean) { await fetchState(state, full, true); }
  async function fetchState(target: ConversationState, full: boolean, visible: boolean): Promise<void> { const view = `${accountKey}:${target}`; if (!accountKey || !bridge.connected || syncingViewsRef.current.has(view)) return; syncingViewsRef.current.add(view); if (visible) { setLoading(true); setCompatible(false); setError(""); } try { const account = accounts.find((item) => item.key === accountKey); const cache = await window.conversationManager.chatgpt.list(accountKey, account?.label || "ChatGPT 账号", target as CachedConversation["state"], full); if (visible && currentViewRef.current !== view) return; if (visible) { setRecords((cache?.records || []).map(toChatManaged)); setSyncedAt(cache?.syncedAt || null); setCompatible(true); const summary = full ? t("完整校准完成") : cache?.syncMode === "full" ? t("后台完整校准完成") : t("后台增量同步完成"); setNotice(`${summary}：${t("当前状态共 {n} 条会话", { n: (cache?.records || []).length })}`); } void window.conversationManager.logs.info(`chatgpt sync: state=${target}, mode=${cache?.syncMode ?? "incremental"}, n=${(cache?.records || []).length}`); void refreshCounts(); } catch (cause) { if (visible && currentViewRef.current === view) setError(message(cause)); } finally { syncingViewsRef.current.delete(view); if (visible && currentViewRef.current === view) setLoading(false); } }
  useEffect(() => { if (!accountKey || !bridge.connected) return; const rotate = () => { if (document.visibilityState !== "visible") return; const others = (["active", "archived", "scheduled"] as ConversationState[]).filter((value) => value !== state); void (async () => { for (const target of others) await fetchState(target, false, false); })(); }; const timer = setInterval(rotate, BACKGROUND_ROTATE_INTERVAL_MS); return () => clearInterval(timer); }, [accountKey, state, bridge.connected]);
  if (!bridge.paired) return <ConnectionCard />;
  return <>
    <ManagerLayout source="chatgpt" title={kind === "work" ? t("ChatGPT 项目工作") : t("ChatGPT 聊天")} subtitle={bridge.connected ? `${t("浏览器桥接已连接")}${syncedAt ? ` · ${t("{t}同步", { t: relativeTime(syncedAt) })}` : ""}` : t("桥接已断开，当前为只读缓存")} emptyHint={kind === "work" ? t("当前账号还没有项目工作会话；这类会话在项目文件夹或 Codex 中创建。") : bridge.connected ? t("点击右上角“完整刷新”，同步当前账号的全部会话。") : t("桥接已断开。重新打开浏览器中的 ChatGPT 页面，扩展会自动重连并同步。")} onOpenExternal={() => void window.conversationManager.chatgpt.openChatGpt()} kind={kind} onKind={onKind} onExport={async (ids) => { const picked = await window.conversationManager.dialog.pickDirectory({ defaultPath: localStorage.getItem("cm-export-dir") ?? undefined }); if (!picked.directory) return t("已取消保存"); localStorage.setItem("cm-export-dir", picked.directory); const result = await window.conversationManager.chatgpt.exportSessions({ accountKey, directory: picked.directory, items: ids.map((id) => { const record = records.find((item) => item.id === id); return { id, title: record?.title ?? "" }; }) }); const failedNote = result.failed.length ? ` · ${t("{n} 条失败", { n: result.failed.length })}` : ""; return `${t("已保存 {n} 个会话文件", { n: result.saved })} → ${result.directory}${failedNote}`; }} accounts={accounts} accountKey={accountKey} onAccount={setAccountKey} state={state} onState={onState} records={records.filter((record) => kind === "chat" ? !record.projectId : Boolean(record.projectId))} writable={bridge.connected && compatible && !loading} refreshable={bridge.connected} loading={loading} error={error} notice={notice} onRefresh={() => sync(true)} onOpen={(record) => window.conversationManager.chatgpt.openConversation(record.id)} onCancel={() => window.conversationManager.chatgpt.cancel()} onBatch={async (action, ids) => {
      let token: string | undefined; if (action === "delete") { if (!(await confirm(deleteConfirmOptions(ids, records, t("会话"))))) return null; token = (await window.conversationManager.chatgpt.previewDelete(ids)).confirmationToken; }
      const result = await window.conversationManager.chatgpt.runBatch(accountKey, action, ids, token); const cache = await window.conversationManager.chatgpt.cached(accountKey, state as CachedConversation["state"]); setRecords((cache?.records || []).map(toChatManaged)); void refreshCounts(); return result;
    }} />
    {dialog}
  </>;
}

function ConnectionCard() {
  return <section className="connection-card"><div className="connection-art">↔</div><p className="eyebrow">{t("安全浏览器桥接")}</p><h1>{t("复用浏览器中的 ChatGPT 登录")}</h1><p>{t("无需在管理器中再次登录。在 Chrome/Edge 中加载配套扩展后即会自动完成配对，无需其他操作；也可以点击浏览器工具栏中的扩展，再点“一键连接桌面管理器”。Cookie 和访问令牌始终留在浏览器。")}</p>
    <div className="card-actions"><button onClick={() => void window.conversationManager.chatgpt.openChatGpt()}>{t("打开 ChatGPT")}</button></div>
  </section>;
}

function CodexWorkspace({ onStatus, state, onState, onCounts }: { onStatus?(available: boolean): void; state: ConversationState; onState(state: ConversationState): void; onCounts(counts: Partial<Record<ConversationState, number>> | ((old: Partial<Record<ConversationState, number>>) => Partial<Record<ConversationState, number>>)): void }) {
  const archived = state === "archived";
  const [available, setAvailable] = useState<boolean | null>(null); const [status, setStatus] = useState(t("正在连接本机 Codex…")); const [records, setRecords] = useState<ManagedConversation[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const recordsByState = useRef<Partial<Record<ConversationState, ManagedConversation[]>>>({});
  const { confirm, dialog } = useConfirm();
  async function load(full = false) { setLoading(true); setError(""); try { const all: CodexThread[] = []; let cursor: string | null = null; do { const page = await window.conversationManager.codex.list({ cursor, archived, full }); all.push(...page.data); cursor = page.nextCursor; } while (cursor); const merged = [...new Map(all.map((thread) => [thread.id, toCodexManaged(thread, archived)])).values()]; recordsByState.current = { ...recordsByState.current, [state]: merged }; setRecords(merged); onCounts({ [state]: merged.length }); void window.conversationManager.logs.info(`codex sync: archived=${archived}, n=${merged.length}`); setNotice(`${full ? t("完整校准完成") : t("同步完成")}：${t("共 {n} 条任务", { n: merged.length })}`); } catch (cause) { setError(message(cause)); } finally { setLoading(false); } }
  useEffect(() => { void window.conversationManager.codex.status().then((value) => { setAvailable(value.available); setStatus(value.message); onStatus?.(value.available); if (value.available) void load(); }); }, []);
  useEffect(() => { if (!available) return; const cachedRecords = recordsByState.current[state]; if (cachedRecords) { setRecords(cachedRecords); setNotice(""); } void load(); }, [state]);
  if (available === false) return <section className="connection-card"><div className="connection-art">⌘</div><p className="eyebrow">{t("统一桌面客户端 · 本机 App Server")}</p><h1>{t("暂时无法连接 Codex")}</h1><p>{status}</p><button className="primary" onClick={() => location.reload()}>{t("重新检测")}</button><button onClick={() => void window.conversationManager.openExternal("https://developers.openai.com/codex/app-server")}>{t("查看安装文档")}</button></section>;
  return <>
    <ManagerLayout source="codex" title={t("Codex 任务")} subtitle={status} emptyHint={t("点击“完整刷新”从本机 App Server 读取任务；若仍为空，请确认已在 Codex 客户端创建过会话。")} onExport={async (ids) => { const picked = await window.conversationManager.dialog.pickDirectory({ defaultPath: localStorage.getItem("cm-export-dir") ?? undefined }); if (!picked.directory) return t("已取消保存"); localStorage.setItem("cm-export-dir", picked.directory); const result = await window.conversationManager.codex.exportSessions({ directory: picked.directory, items: ids.map((id) => { const record = records.find((item) => item.id === id); return { id, title: record?.title ?? "", preview: record?.preview ?? "", cwd: record?.cwd ?? null }; }) }); const failedNote = result.failed.length ? ` · ${t("{n} 条失败", { n: result.failed.length })}` : ""; return `${t("已保存 {n} 个任务文件", { n: result.saved })} → ${result.directory}${failedNote}`; }} state={state} onState={onState} records={records} writable={available === true && !loading} refreshable={available === true} loading={loading} error={error} notice={notice} onRefresh={() => load(true)} onOpen={async (record) => { const result = await window.conversationManager.codex.open(record.id); if (!result.opened) setNotice(t("已复制恢复命令，请在终端运行")); }} onBatch={async (action, ids) => {
      const codexAction = action === "restore" ? "unarchive" : action; let token: string | undefined;
      if (action === "delete") { if (!(await confirm(deleteConfirmOptions(ids, records, t("任务"))))) return null; const preview = await window.conversationManager.codex.previewDelete(ids); if (preview.missing.length || preview.running.length || !preview.confirmationToken) throw new Error(t("部分任务不存在或仍在运行，无法删除")); if (preview.tasks.length > ids.length && !(await confirm({ title: t("同时删除 {n} 个派生任务", { n: preview.tasks.length - ids.length }), body: t("选中任务带有派生子任务，将随主任务一并删除，此操作无法撤销。") }))) return null; token = preview.confirmationToken; }
      const result = await window.conversationManager.codex.runBatch(codexAction, ids, token); const removed = new Set(result.succeeded); const next = records.filter((record) => !removed.has(record.id)); recordsByState.current = { ...recordsByState.current, [state]: next }; setRecords(next); onCounts({ [state]: next.length }); return result;
    }} />
    {dialog}
  </>;
}

function ManagerLayout(props: { source: "chatgpt" | "codex"; title: string; subtitle: string; emptyHint: string; kind?: "chat" | "work"; onKind?(value: "chat" | "work"): void; onOpenExternal?(): void; onExport?(ids: string[]): Promise<string>; accounts?: Account[]; accountKey?: string; onAccount?(key: string): void; state: ConversationState; onState(state: ConversationState): void; records: ManagedConversation[]; writable: boolean; refreshable: boolean; loading: boolean; error: string; notice: string; onRefresh(): void | Promise<void>; onOpen(record: ManagedConversation): void | Promise<void>; onCancel?(): Promise<{ cancelled: boolean }>; onBatch(action: "archive" | "restore" | "delete", ids: string[]): Promise<{ succeeded: string[]; failed: Array<{ id: string; message: string }>; unprocessed?: string[] } | null> }) {
  const [query, setQuery] = useState(""); const deferredQuery = useDeferredValue(query); const [age, setAge] = useState<AgeFilter>("all"); const [sort, setSort] = useState<"newest" | "oldest">("newest"); const [selected, setSelected] = useState<Set<string>>(new Set()); const [busy, setBusy] = useState(false); const [localNotice, setLocalNotice] = useState(""); const [limit, setLimit] = useState(100); const [focusId, setFocusId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null); const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setSelected(new Set()); setLimit(100); setFocusId(null); }, [props.state, props.accountKey, age, props.kind]);
  const visible = useMemo(() => filterConversations(props.records, { state: props.state, query: deferredQuery, age }).sort((a, b) => sort === "newest" ? (b.updatedAt ?? 0) - (a.updatedAt ?? 0) : (a.updatedAt ?? 0) - (b.updatedAt ?? 0)), [props.records, props.state, deferredQuery, age, sort]); const shown = visible.slice(0, limit); const selectable = bulkSelectableIds(visible); const allSelected = selectable.length > 0 && selectable.every((id) => selected.has(id));
  const groups = props.source === "codex" ? groupCodexConversations(shown) : null;
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(`cm-collapsed-groups:${props.source}`) || "[]") as string[]); } catch { return new Set(); } });
  const toggleGroup = (key: string, open: boolean) => setCollapsedGroups((old) => { const next = new Set(old); if (open) next.delete(key); else next.add(key); try { localStorage.setItem(`cm-collapsed-groups:${props.source}`, JSON.stringify([...next])); } catch {} return next; });
  const toggleOne = (id: string) => setSelected((old) => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; });
  async function batch(action: "archive" | "restore" | "delete") { const ids = [...selected]; if (!ids.length) return; setBusy(true); setLocalNotice(""); try { const result = await props.onBatch(action, ids); if (!result) return; setSelected(new Set([...result.failed.map((item) => item.id), ...(result.unprocessed || [])])); setLocalNotice(t("完成：成功 {s}，失败 {f}，未处理 {u}", { s: result.succeeded.length, f: result.failed.length, u: result.unprocessed?.length || 0 })); } catch (cause) { setLocalNotice(`${t("操作失败")}：${message(cause)}`); } finally { setBusy(false); } }
  const runRefresh = () => { setLocalNotice(""); return Promise.resolve(props.onRefresh()); };
  async function runExport() { if (!props.onExport) return; setBusy(true); setLocalNotice(""); try { setLocalNotice(await props.onExport([...selected])); } catch (cause) { setLocalNotice(`${t("保存失败")}：${message(cause)}`); } finally { setBusy(false); } }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.closest("input,textarea,select,[contenteditable]") !== null || target.isContentEditable);
      if (event.key === "Escape") { if (editing) (target as HTMLElement).blur(); else { setSelected(new Set()); setFocusId(null); } return; }
      if (editing) return;
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); if (selectable.length) setSelected(new Set(selectable)); return; }
      const deleteRequested = event.key === "Delete" || (/Mac/i.test(navigator.platform) && event.metaKey && event.key === "Backspace");
      if (deleteRequested && !busy && props.writable && selected.size > 0 && (props.state === "active" || props.state === "archived")) { event.preventDefault(); void batch(props.state === "active" ? "archive" : "delete"); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const renderRow = (record: ManagedConversation) => {
    const selectableRow = props.state !== "scheduled" && !record.running && record.capabilities.some((value) => value === "archive" || value === "restore" || value === "delete");
    const sub = props.source === "codex" ? `${record.preview ? `${record.preview} · ` : ""}${isProjectTask(record) ? t("项目任务") : t("非项目任务")}` : record.projectId ? t("项目会话") : record.pinned ? t("置顶会话") : t("ChatGPT");
    return <div className={`row ${selected.has(record.id) ? "selected" : ""} ${focusId === record.id ? "focused" : ""}`} key={record.id} onClick={() => { if (selectableRow && !busy) toggleOne(record.id); }} onDoubleClick={() => void props.onOpen(record)}>
      <label className="check" onClick={(event) => event.stopPropagation()}><input type="checkbox" disabled={!selectableRow || busy} checked={selected.has(record.id)} onChange={() => toggleOne(record.id)}/><span></span></label>
      <button type="button" className="row-main" onFocus={() => setFocusId(record.id)} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const rows = listRef.current ? Array.from(listRef.current.querySelectorAll<HTMLButtonElement>(".row-main")) : []; const index = rows.indexOf(event.currentTarget); const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)]; if (next) { next.focus({ preventScroll: true }); next.closest(".row")?.scrollIntoView({ block: "nearest" }); } }
        else if (event.key === " " && selectableRow && !busy) { event.preventDefault(); toggleOne(record.id); }
        else if (event.key === "Enter") { event.preventDefault(); void props.onOpen(record); }
      }} title={t("单击选中 · 双击打开")}>
        <strong>{record.running ? <span className="running-dot" aria-label={t("运行中")} /> : null}{record.title}</strong>
        <small>{sub}</small>
      </button>
      <time title={record.updatedAt ? new Date(record.updatedAt).toLocaleString() : undefined}>{record.updatedAt ? relativeTime(record.updatedAt) : t("未知")}</time>
    </div>;
  };
  return <section className="workspace">
    <div className="workspace-main">
      <div className="workspace-title"><div><p className="eyebrow">{props.source === "chatgpt" ? t("浏览器会话") : t("本机任务")}</p><h1>{props.title}</h1><p>{props.subtitle}</p></div><div className="title-actions">{props.onOpenExternal && <button onClick={() => props.onOpenExternal?.()}>{t("打开 ChatGPT")}</button>}{props.accounts && props.accounts.length > 1 && <select value={props.accountKey} onChange={(event) => props.onAccount?.(event.target.value)}>{props.accounts.map((account) => <option key={account.key} value={account.key}>{account.label}</option>)}</select>}<button className="refresh" disabled={props.loading || !props.refreshable} onClick={() => void runRefresh()}>{props.loading ? t("同步中…") : t("完整刷新")}</button></div></div>
      <div className="toolbar"><input ref={searchRef} className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索标题（按 / 聚焦）")} aria-label={t("搜索标题")}/>{props.onKind && <Segmented value={props.kind ?? "chat"} options={[["chat", t("聊天")], ["work", t("工作")]] as Array<["chat" | "work", string]>} onChange={props.onKind} aria-label={t("会话类型")}/>}<Segmented<AgeFilter> className="age-filter" value={age} options={ageOptions.map(([value, label]) => [value, t(label)] as [AgeFilter, string])} onChange={setAge} aria-label={t("时间范围")}/><select className="refresh" value={sort} onChange={(event) => setSort(event.target.value as "newest" | "oldest")} aria-label={t("排序")}><option value="newest">{t("最新优先")}</option><option value="oldest">{t("最早优先")}</option></select></div>
      {(props.error || props.notice || localNotice) && <div className={`notice ${props.error ? "error" : ""}`}>{props.error || localNotice || props.notice}</div>}
      <div className="list" ref={listRef} onScroll={(event) => { const node = event.currentTarget; if (node.scrollTop + node.clientHeight >= node.scrollHeight - 120) setLimit((old) => Math.min(old + 100, visible.length)); }}>
        <div className="list-head"><span></span><span>{t("{n} 条结果", { n: visible.length })}</span><span>{t("最后更新")}</span></div>
        {groups ? groups.map((group) => <details className="project-group" open={!collapsedGroups.has(group.key)} onToggle={(event) => { const open = (event.target as HTMLDetailsElement).open; if (open === collapsedGroups.has(group.key)) toggleGroup(group.key, open); }} key={group.key}><summary><span>📁 {group.name}</span><small>{t("{n} 条", { n: group.records.length })}{group.path ? ` · ${group.path}` : ""}</small></summary>{group.records.map(renderRow)}</details>) : shown.map(renderRow)}
        {!props.loading && !shown.length && (props.records.length === 0
          ? <div className="empty"><strong>{props.source === "chatgpt" ? t("还没有同步过会话") : t("还没有读取到任务")}</strong><small>{props.emptyHint}</small>{props.refreshable && <button onClick={() => void runRefresh()}>{t("完整刷新")}</button>}</div>
          : <div className="empty"><strong>{t("当前筛选下没有记录")}</strong><small>{t("换个搜索关键词，或放宽时间范围再试。")}</small><button onClick={() => { setQuery(""); setAge("all"); }}>{t("清除筛选")}</button></div>)}
      </div>
      <div className="actionbar">
        <div><strong>{t("已选 {n} 条", { n: selected.size })}</strong><span>{props.state === "scheduled" ? t("已安排会话请在 ChatGPT 官方页面管理") : props.writable ? t("操作只影响当前筛选与选择") : t("只读状态")}</span></div>
        <div className="selection-actions"><button type="button" className={allSelected ? "active" : ""} disabled={!selectable.length || busy} onClick={() => setSelected(new Set(selectable))}>{t("全选当前结果")}</button><button type="button" disabled={!selected.size || busy} onClick={() => setSelected(new Set())}>{t("清空选择")}</button></div>
        <div className="primary-actions">{props.onExport && props.state !== "scheduled" && <button type="button" className="secondary" disabled={!selected.size || busy} onClick={() => void runExport()}>{t("保存会话")}</button>}{props.state === "active" && <button type="button" className="primary" disabled={!props.writable || !selected.size || busy} onClick={() => void batch("archive")}>{t("归档")}</button>}{props.state === "archived" && <button type="button" className="primary" disabled={!props.writable || !selected.size || busy} onClick={() => void batch("restore")}>{t("恢复")}</button>}</div>
        <div className="danger-actions">{busy && props.onCancel && <button type="button" className="danger" onClick={() => void props.onCancel?.()}>{t("停止后续操作")}</button>}{props.state !== "scheduled" && <button type="button" className="danger" disabled={!props.writable || !selected.size || busy} onClick={() => void batch("delete")}>{t("永久删除")}</button>}</div>
      </div>
    </div>
  </section>;
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

function Settings({ version, lang, onLanguage, onCodexStatus }: { version: string; lang: Lang; onLanguage(value: Lang): void; onCodexStatus?(available: boolean): void }) {
  const [update, setUpdate] = useState<UpdateState | null>(null); const [bridge, setBridge] = useState<PairingState | null>(null); const [cache, setCache] = useState<{ accounts: number; records: number; bytes: number; lastSyncedAt: number | null; lastFullSyncedAt: number | null } | null>(null); const [codexStatus, setCodexStatus] = useState<{ available: boolean; message: string; command: string } | null>(null); const [theme, setTheme] = useState<ThemePreference>("system"); const [pairMessage, setPairMessage] = useState("");
  const readCodexStatus = () => void window.conversationManager.codex.status().then((value) => { setCodexStatus(value); onCodexStatus?.(value.available); });
  useEffect(() => { void window.conversationManager.updates.getState().then(setUpdate); void window.conversationManager.chatgpt.state().then(setBridge); void window.conversationManager.chatgpt.cacheStats().then(setCache); void window.conversationManager.theme.get().then(setTheme); readCodexStatus(); return window.conversationManager.updates.onState(setUpdate); }, []);
  const changeTheme = (value: ThemePreference) => { setTheme(value); void window.conversationManager.theme.set(value); };
  return <section className="settings"><p className="eyebrow">Conversation Manager v{version}</p><h1>{t("设置与隐私")}</h1><div className="settings-grid">
    <article><h2>{t("外观")}</h2><p>{t("界面默认跟随系统深色模式自动切换，也可以手动固定为浅色或深色。")}</p><div className="card-actions"><Segmented value={theme} options={[["system", t("跟随系统")], ["light", t("浅色")], ["dark", t("深色")]] as Array<[ThemePreference, string]>} onChange={changeTheme} aria-label={t("外观")}/></div><p style={{ marginTop: 12 }}>{t("语言 / Language")}</p><div className="card-actions"><Segmented value={lang} options={[["zh", "中文"], ["en", "English"]] as Array<[Lang, string]>} onChange={onLanguage} aria-label={t("语言 / Language")}/></div></article>
    <article><h2>{t("浏览器桥接")}</h2><p>{bridge?.connected ? `${t("已连接")}${bridge.extensionVersion && bridge.extensionVersion !== version ? ` · ${t("扩展 v{ext} · 需重载", { ext: bridge.extensionVersion })}` : ""}` : bridge?.paired ? t("已配对，等待浏览器") : t("尚未配对")}</p>{pairMessage && <p className="pair-feedback">{pairMessage}</p>}{bridge?.code && <div className="pair-code"><span>{t("配对码 · 5 分钟内有效（通常无需使用）")}</span><strong>{bridge.code}</strong><small>{t("新版扩展会自动完成配对；此配对码仅供旧版扩展弹窗流程使用")}</small></div>}<div className="card-actions"><button onClick={() => { setPairMessage(t("正在发起新的配对…")); void window.conversationManager.chatgpt.beginPairing().then((value) => { setBridge(value); setPairMessage(value.code ? t("已开始配对：等待浏览器扩展连接（通常几秒内自动完成）") : t("已开始配对")); }); }}>{t("开始配对")}</button><button onClick={() => { setPairMessage(t("正在清除…")); void window.conversationManager.chatgpt.clearPairing().then((value) => { setBridge(value); setPairMessage(t("已清除配对。扩展默认会在后台自动重新连接；也可点击“开始配对”立即发起新的配对。")); }); }}>{t("清除配对")}</button><button onClick={() => void window.conversationManager.chatgpt.showExtension()}>{t("打开扩展目录")}</button></div></article>
    <article><h2>{t("ChatGPT 缓存")}</h2><p>{cache ? `${t("{n} 条记录", { n: cache.records })} · ${formatBytes(cache.bytes)}${cache.lastSyncedAt ? ` · ${t("{t}同步", { t: relativeTime(cache.lastSyncedAt) })}` : ""}${cache.lastFullSyncedAt ? ` · ${t("{t}完整校准", { t: relativeTime(cache.lastFullSyncedAt) })}` : ""}` : t("正在读取…")}</p><div className="card-actions"><button onClick={() => void window.conversationManager.chatgpt.clearCache().then(setCache)}>{t("清除缓存")}</button></div></article>
    <article><h2>{t("Codex 后端")}</h2><p>{codexStatus?.message || t("正在自动检测统一桌面客户端…")}<br/><small>{codexStatus?.command}</small></p><div className="card-actions">{codexStatus?.available === false && <button onClick={() => void window.conversationManager.codex.selectCommand().then(readCodexStatus)}>{t("手动选择（兜底）")}</button>}</div></article>
    <article><h2>{t("自动更新")}</h2><p>{update?.message}</p><label className="toggle"><input type="checkbox" checked={update?.autoUpdate ?? true} onChange={(event) => void window.conversationManager.updates.setAutoUpdate(event.target.checked).then(setUpdate)}/>{t("默认自动检查更新")}</label><div className="card-actions">{update?.autoUpdate === false && <button onClick={() => void window.conversationManager.updates.check()}>{t("立即检查")}</button>}{update?.autoUpdate === false && update?.phase === "downloaded" && update.canAutoInstall && <button onClick={() => void window.conversationManager.updates.install()}>{t("重启安装")}</button>}{update?.phase === "available" && !update.canAutoInstall && <button onClick={() => void window.conversationManager.updates.openRelease()}>{t("打开下载页")}</button>}</div></article>
    <article><h2>{t("隐私边界")}</h2><p>{t("管理器只保存会话标题、ID、时间和状态。Cookie、访问令牌、正文及 Codex 认证文件不会被读取或复制。")}</p></article>
    <article><h2>{t("连接方式")}</h2><p>{t("ChatGPT 会话复用 Chrome/Edge 登录；统一 ChatGPT/Codex 桌面客户端中的 Codex 任务通过自动发现的本机 App Server 读取。两者都不在管理器中重复登录。")}</p></article>
    <LogCard />
  </div></section>;
}

function toChatManaged(record: CachedConversation): ManagedConversation { return { source: "chatgpt", ...record, capabilities: record.state === "scheduled" ? [] : record.state === "archived" ? ["open", "restore", "delete"] : ["open", "archive", "delete"], running: false }; }
function toCodexManaged(thread: CodexThread, archived: boolean): ManagedConversation { return { source: "codex", id: thread.id, title: thread.name?.trim() || thread.preview?.trim() || "未命名任务", preview: thread.preview?.trim().replace(/\s+/g, " ").slice(0, 160) || null, createdAt: thread.createdAt * 1000, updatedAt: thread.updatedAt * 1000, state: archived ? "archived" : "active", projectId: thread.projectId || undefined, cwd: thread.cwd, pinned: false, running: thread.status?.type === "active", current: false, capabilities: thread.status?.type === "active" ? ["open"] : archived ? ["open", "restore", "delete"] : ["open", "archive", "delete"] }; }
function relativeTime(value: number): string { const seconds = Math.max(0, Math.round((Date.now() - value) / 1000)); return seconds < 60 ? t("刚刚") : seconds < 3600 ? t("{n} 分钟前", { n: Math.floor(seconds / 60) }) : seconds < 86400 ? t("{n} 小时前", { n: Math.floor(seconds / 3600) }) : seconds < 7 * 86400 ? t("{n} 天前", { n: Math.floor(seconds / 86400) }) : new Date(value).toLocaleDateString(); }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error:\s*/, ""); }
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
