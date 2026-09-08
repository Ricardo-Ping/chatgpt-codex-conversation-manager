import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { bulkSelectableIds, filterConversations, type AgeFilter, type ConversationState, type ManagedConversation } from "@conversation-manager/conversation-domain";
import type { CachedConversation, PairingState } from "@conversation-manager/chatgpt-bridge-server";
import type { CodexThread } from "@conversation-manager/codex-app-server-adapter";
import type { ThemePreference, UpdateState } from "./global.js";
import { groupCodexConversations, isProjectTask } from "./codex-groups.js";
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
  const measure = useCallback(() => { const node = nodes.current.get(props.value); if (node) setPill({ x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight }); }, [props.value]);
  useLayoutEffect(() => { measure(); }, [measure]);
  useEffect(() => { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }, [measure]);
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
  const bridgeText = extensionMismatch ? `扩展 v${bridge.extensionVersion} · 需重载` : bridge.connected ? "已连接" : bridge.paired ? "等待浏览器" : "未配对";
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src={iconUrl} alt="" /><div><strong>Conversation Manager</strong><small>ChatGPT · Codex</small></div></div>
      <nav className="side-nav" aria-label="平台切换">
        <button type="button" className={`side-item ${page === "chatgpt" ? "active" : ""}`} aria-current={page === "chatgpt" ? "page" : undefined} onClick={() => openWorkspace("chatgpt")}><span className={`dot ${bridgeDot}`} title={extensionMismatch ? `浏览器扩展为 v${bridge.extensionVersion}，与主程序 v${version} 不一致，请在 chrome://extensions 中重新加载` : bridge.connected ? "桥接已连接" : bridge.paired ? "已配对，等待浏览器" : "未配对"}></span>ChatGPT</button>
        <button type="button" className={`side-item ${page === "codex" ? "active" : ""}`} aria-current={page === "codex" ? "page" : undefined} onClick={() => openWorkspace("codex")}><span className={`dot ${codexReady === true ? "ok" : codexReady === false ? "off" : "wait"}`} title={codexReady === true ? "App Server 已连接" : codexReady === false ? "未连接" : "检测中"}></span>Codex</button>
      </nav>
      {page !== "settings" && <div className="side-states">
        <p className="side-states-label">会话状态</p>
        <Segmented vertical value={page === "codex" ? workspaceStates.codex : workspaceStates.chatgpt} options={(page === "codex" ? (["active", "archived"] as ConversationState[]) : (["active", "archived", "scheduled"] as ConversationState[])).map((value) => { const split = chatCounts[value]; const count = page === "chatgpt" ? (split ? (workspaceKinds.chatgpt === "work" ? split.work : split.chat) : undefined) : codexCounts[value]; return [value, <React.Fragment key={value}>{stateLabels[value]}{typeof count === "number" && <span className="count">{count}</span>}</React.Fragment>] as [ConversationState, React.ReactNode]; })} onChange={setWorkspaceState} aria-label="会话状态"/>
      </div>}
      <div className="side-status" aria-label="连接状态">
        <p className={extensionMismatch ? "stale" : undefined}><span className={`dot ${bridgeDot}`}></span><strong>ChatGPT 桥接</strong>{bridgeText}</p>
        <p><span className={`dot ${codexReady === true ? "ok" : codexReady === false ? "off" : "wait"}`}></span><strong>Codex 服务</strong>{codexReady === true ? "已连接" : codexReady === false ? "未连接" : "检测中"}</p>
      </div>
      <div className="side-footer">
        <button type="button" className={`side-item ${page === "settings" ? "active" : ""}`} title={page === "settings" ? "返回上一页面" : "设置"} onClick={toggleSettings}><span aria-hidden="true">⚙</span>{page === "settings" ? "返回" : "设置"}</button>
        <small className="side-version">v{version}</small>
      </div>
    </aside>
    <main className="content">{page === "chatgpt" ? <ChatGptWorkspace bridge={bridge} state={workspaceStates.chatgpt} onState={(value) => setWorkspaceStates((old) => ({ ...old, chatgpt: value }))} kind={workspaceKinds.chatgpt} onKind={(value) => setWorkspaceKinds({ chatgpt: value })} onCounts={setChatCounts} /> : page === "codex" ? <CodexWorkspace onStatus={reportCodexStatus} state={workspaceStates.codex} onState={(value) => setWorkspaceStates((old) => ({ ...old, codex: value }))} onCounts={setCodexCounts} /> : <Settings version={version} onCodexStatus={reportCodexStatus} />}</main>
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
      {state.items && state.items.length > 0 && <ul className="dialog-items">{state.items.slice(0, 6).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}{state.items.length > 6 && <li className="more">… 其余 {state.items.length - 6} 条</li>}</ul>}
      {state.requireCount !== undefined && <input className="dialog-input" autoFocus placeholder={`输入 ${state.requireCount} 以确认`} onChange={(event) => setMatch(event.currentTarget.value === String(state.requireCount))} onKeyDown={(event) => { if (event.key === "Enter" && event.currentTarget.value === String(state.requireCount)) close(true); }} />}
      <div className="dialog-actions"><button type="button" onClick={() => close(false)}>取消</button><button type="button" className="danger" disabled={state.requireCount !== undefined && !match} onClick={() => close(true)}>确认删除</button></div>
    </div>
  </div> : null;
  return { confirm, dialog };
}

function deleteConfirmOptions(ids: string[], records: ManagedConversation[], unit: string): ConfirmOptions {
  return { title: `永久删除 ${ids.length} 条${unit}`, body: "此操作无法撤销，删除后无法恢复。", items: records.filter((record) => ids.includes(record.id)).slice(0, 6).map((record) => record.title), requireCount: ids.length > 20 ? ids.length : undefined };
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
  async function fetchState(target: ConversationState, full: boolean, visible: boolean): Promise<void> { const view = `${accountKey}:${target}`; if (!accountKey || !bridge.connected || syncingViewsRef.current.has(view)) return; syncingViewsRef.current.add(view); if (visible) { setLoading(true); setCompatible(false); setError(""); } try { const account = accounts.find((item) => item.key === accountKey); const cache = await window.conversationManager.chatgpt.list(accountKey, account?.label || "ChatGPT 账号", target as CachedConversation["state"], full); if (visible && currentViewRef.current !== view) return; if (visible) { setRecords((cache?.records || []).map(toChatManaged)); setSyncedAt(cache?.syncedAt || null); setCompatible(true); const summary = full ? "完整校准完成" : cache?.syncMode === "full" ? "后台完整校准完成" : "后台增量同步完成"; setNotice(`${summary}：当前状态共 ${(cache?.records || []).length} 条会话`); } void refreshCounts(); } catch (cause) { if (visible && currentViewRef.current === view) setError(message(cause)); } finally { syncingViewsRef.current.delete(view); if (visible && currentViewRef.current === view) setLoading(false); } }
  useEffect(() => { if (!accountKey || !bridge.connected) return; const rotate = () => { if (document.visibilityState !== "visible") return; const others = (["active", "archived", "scheduled"] as ConversationState[]).filter((value) => value !== state); void (async () => { for (const target of others) await fetchState(target, false, false); })(); }; const timer = setInterval(rotate, BACKGROUND_ROTATE_INTERVAL_MS); return () => clearInterval(timer); }, [accountKey, state, bridge.connected]);
  if (!bridge.paired) return <ConnectionCard />;
  return <>
    <ManagerLayout source="chatgpt" title={kind === "work" ? "ChatGPT 项目工作" : "ChatGPT 聊天"} subtitle={bridge.connected ? `浏览器桥接已连接${syncedAt ? ` · ${relativeTime(syncedAt)}同步` : ""}` : "桥接已断开，当前为只读缓存"} emptyHint={kind === "work" ? "当前账号还没有项目工作会话；这类会话在项目文件夹或 Codex 中创建。" : bridge.connected ? "点击右上角“完整刷新”，同步当前账号的全部会话。" : "桥接已断开。重新打开浏览器中的 ChatGPT 页面，扩展会自动重连并同步。"} onOpenExternal={() => void window.conversationManager.chatgpt.openChatGpt()} kind={kind} onKind={onKind} accounts={accounts} accountKey={accountKey} onAccount={setAccountKey} state={state} onState={onState} records={records.filter((record) => kind === "chat" ? !record.projectId : Boolean(record.projectId))} writable={bridge.connected && compatible && !loading} refreshable={bridge.connected} loading={loading} error={error} notice={notice} onRefresh={() => sync(true)} onOpen={(record) => window.conversationManager.chatgpt.openConversation(record.id)} onCancel={() => window.conversationManager.chatgpt.cancel()} onBatch={async (action, ids) => {
      let token: string | undefined; if (action === "delete") { if (!(await confirm(deleteConfirmOptions(ids, records, "会话")))) return null; token = (await window.conversationManager.chatgpt.previewDelete(ids)).confirmationToken; }
      const result = await window.conversationManager.chatgpt.runBatch(accountKey, action, ids, token); const cache = await window.conversationManager.chatgpt.cached(accountKey, state as CachedConversation["state"]); setRecords((cache?.records || []).map(toChatManaged)); void refreshCounts(); return result;
    }} />
    {dialog}
  </>;
}

function ConnectionCard() {
  return <section className="connection-card"><div className="connection-art">↔</div><p className="eyebrow">安全浏览器桥接</p><h1>复用浏览器中的 ChatGPT 登录</h1><p>无需在管理器中再次登录。在 Chrome/Edge 中加载配套扩展后即会自动完成配对，无需其他操作；也可以点击浏览器工具栏中的扩展，再点“一键连接桌面管理器”。Cookie 和访问令牌始终留在浏览器。</p>
    <div className="card-actions"><button onClick={() => void window.conversationManager.chatgpt.openChatGpt()}>打开 ChatGPT</button></div>
  </section>;
}

function CodexWorkspace({ onStatus, state, onState, onCounts }: { onStatus?(available: boolean): void; state: ConversationState; onState(state: ConversationState): void; onCounts(counts: Partial<Record<ConversationState, number>> | ((old: Partial<Record<ConversationState, number>>) => Partial<Record<ConversationState, number>>)): void }) {
  const archived = state === "archived";
  const [available, setAvailable] = useState<boolean | null>(null); const [status, setStatus] = useState("正在连接本机 Codex…"); const [records, setRecords] = useState<ManagedConversation[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const recordsByState = useRef<Partial<Record<ConversationState, ManagedConversation[]>>>({});
  const { confirm, dialog } = useConfirm();
  async function load(full = false) { setLoading(true); setError(""); try { const all: CodexThread[] = []; let cursor: string | null = null; do { const page = await window.conversationManager.codex.list({ cursor, archived, full }); all.push(...page.data); cursor = page.nextCursor; } while (cursor); const merged = [...new Map(all.map((thread) => [thread.id, toCodexManaged(thread, archived)])).values()]; recordsByState.current = { ...recordsByState.current, [state]: merged }; setRecords(merged); onCounts({ [state]: merged.length }); setNotice(`${full ? "完整校准完成" : "同步完成"}：共 ${merged.length} 条任务`); } catch (cause) { setError(message(cause)); } finally { setLoading(false); } }
  useEffect(() => { void window.conversationManager.codex.status().then((value) => { setAvailable(value.available); setStatus(value.message); onStatus?.(value.available); if (value.available) void load(); }); }, []);
  useEffect(() => { if (!available) return; const cachedRecords = recordsByState.current[state]; if (cachedRecords) { setRecords(cachedRecords); setNotice(""); } void load(); }, [state]);
  if (available === false) return <section className="connection-card"><div className="connection-art">⌘</div><p className="eyebrow">统一桌面客户端 · 本机 App Server</p><h1>暂时无法连接 Codex</h1><p>{status}</p><button className="primary" onClick={() => location.reload()}>重新检测</button><button onClick={() => void window.conversationManager.openExternal("https://developers.openai.com/codex/app-server")}>查看安装文档</button></section>;
  return <>
    <ManagerLayout source="codex" title="Codex 任务" subtitle={status} emptyHint="点击“完整刷新”从本机 App Server 读取任务；若仍为空，请确认已在 Codex 客户端创建过会话。" state={state} onState={onState} records={records} writable={available === true && !loading} refreshable={available === true} loading={loading} error={error} notice={notice} onRefresh={() => load(true)} onOpen={async (record) => { const result = await window.conversationManager.codex.open(record.id); if (!result.opened) setNotice("已复制恢复命令，请在终端运行"); }} onBatch={async (action, ids) => {
      const codexAction = action === "restore" ? "unarchive" : action; let token: string | undefined;
      if (action === "delete") { if (!(await confirm(deleteConfirmOptions(ids, records, "任务")))) return null; const preview = await window.conversationManager.codex.previewDelete(ids); if (preview.missing.length || preview.running.length || !preview.confirmationToken) throw new Error("部分任务不存在或仍在运行，无法删除"); if (preview.tasks.length > ids.length && !(await confirm({ title: `同时删除 ${preview.tasks.length - ids.length} 个派生任务`, body: "选中任务带有派生子任务，将随主任务一并删除，此操作无法撤销。" }))) return null; token = preview.confirmationToken; }
      const result = await window.conversationManager.codex.runBatch(codexAction, ids, token); const removed = new Set(result.succeeded); const next = records.filter((record) => !removed.has(record.id)); recordsByState.current = { ...recordsByState.current, [state]: next }; setRecords(next); onCounts({ [state]: next.length }); if (codexAction === "archive" || codexAction === "unarchive") { const to = codexAction === "archive" ? "archived" : "active"; onCounts((old) => ({ ...old, [to]: (old[to] ?? 0) + result.succeeded.length })); } return result;
    }} />
    {dialog}
  </>;
}

function ManagerLayout(props: { source: "chatgpt" | "codex"; title: string; subtitle: string; emptyHint: string; kind?: "chat" | "work"; onKind?(value: "chat" | "work"): void; onOpenExternal?(): void; accounts?: Account[]; accountKey?: string; onAccount?(key: string): void; state: ConversationState; onState(state: ConversationState): void; records: ManagedConversation[]; writable: boolean; refreshable: boolean; loading: boolean; error: string; notice: string; onRefresh(): void | Promise<void>; onOpen(record: ManagedConversation): void | Promise<void>; onCancel?(): Promise<{ cancelled: boolean }>; onBatch(action: "archive" | "restore" | "delete", ids: string[]): Promise<{ succeeded: string[]; failed: Array<{ id: string; message: string }>; unprocessed?: string[] } | null> }) {
  const [query, setQuery] = useState(""); const deferredQuery = useDeferredValue(query); const [age, setAge] = useState<AgeFilter>("all"); const [sort, setSort] = useState<"newest" | "oldest">("newest"); const [selected, setSelected] = useState<Set<string>>(new Set()); const [busy, setBusy] = useState(false); const [localNotice, setLocalNotice] = useState(""); const [limit, setLimit] = useState(100); const [focusId, setFocusId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null); const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setSelected(new Set()); setLimit(100); setFocusId(null); }, [props.state, props.accountKey, age, props.kind]);
  const visible = useMemo(() => filterConversations(props.records, { state: props.state, query: deferredQuery, age }).sort((a, b) => sort === "newest" ? (b.updatedAt ?? 0) - (a.updatedAt ?? 0) : (a.updatedAt ?? 0) - (b.updatedAt ?? 0)), [props.records, props.state, deferredQuery, age, sort]); const shown = visible.slice(0, limit); const selectable = bulkSelectableIds(visible); const allSelected = selectable.length > 0 && selectable.every((id) => selected.has(id));
  const groups = props.source === "codex" ? groupCodexConversations(shown) : null;
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(`cm-collapsed-groups:${props.source}`) || "[]") as string[]); } catch { return new Set(); } });
  const toggleGroup = (key: string, open: boolean) => setCollapsedGroups((old) => { const next = new Set(old); if (open) next.delete(key); else next.add(key); try { localStorage.setItem(`cm-collapsed-groups:${props.source}`, JSON.stringify([...next])); } catch {} return next; });
  const toggleOne = (id: string) => setSelected((old) => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; });
  async function batch(action: "archive" | "restore" | "delete") { const ids = [...selected]; if (!ids.length) return; setBusy(true); setLocalNotice(""); try { const result = await props.onBatch(action, ids); if (!result) return; setSelected(new Set([...result.failed.map((item) => item.id), ...(result.unprocessed || [])])); setLocalNotice(`完成：成功 ${result.succeeded.length}，失败 ${result.failed.length}，未处理 ${result.unprocessed?.length || 0}`); } catch (cause) { setLocalNotice(`操作失败：${message(cause)}`); } finally { setBusy(false); } }
  const runRefresh = () => { setLocalNotice(""); return Promise.resolve(props.onRefresh()); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof HTMLElement && (target.closest("input,textarea,select,[contenteditable]") !== null || target.isContentEditable);
      if (event.key === "Escape") { if (editing) (target as HTMLElement).blur(); else { setSelected(new Set()); setFocusId(null); } return; }
      if (editing) return;
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); if (selectable.length) setSelected(new Set(selectable)); return; }
      if (event.key === "Delete" && !busy && props.writable && selected.size > 0 && (props.state === "active" || props.state === "archived")) { event.preventDefault(); void batch(props.state === "active" ? "archive" : "delete"); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const renderRow = (record: ManagedConversation) => {
    const selectableRow = props.state !== "scheduled" && !record.running && record.capabilities.some((value) => value === "archive" || value === "restore" || value === "delete");
    const sub = props.source === "codex" ? `${record.preview ? `${record.preview} · ` : ""}${isProjectTask(record) ? "项目任务" : "非项目任务"}` : record.projectId ? "项目会话" : record.pinned ? "置顶会话" : "ChatGPT";
    return <div className={`row ${selected.has(record.id) ? "selected" : ""} ${focusId === record.id ? "focused" : ""}`} key={record.id} onClick={() => { if (selectableRow && !busy) toggleOne(record.id); }} onDoubleClick={() => void props.onOpen(record)}>
      <label className="check" onClick={(event) => event.stopPropagation()}><input type="checkbox" disabled={!selectableRow || busy} checked={selected.has(record.id)} onChange={() => toggleOne(record.id)}/><span></span></label>
      <button type="button" className="row-main" onFocus={() => setFocusId(record.id)} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const rows = listRef.current ? Array.from(listRef.current.querySelectorAll<HTMLButtonElement>(".row-main")) : []; const index = rows.indexOf(event.currentTarget); const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)]; if (next) { next.focus({ preventScroll: true }); next.closest(".row")?.scrollIntoView({ block: "nearest" }); } }
        else if (event.key === " " && selectableRow && !busy) { event.preventDefault(); toggleOne(record.id); }
        else if (event.key === "Enter") { event.preventDefault(); void props.onOpen(record); }
      }} title="单击选中 · 双击打开">
        <strong>{record.running ? <span className="running-dot" aria-label="运行中" /> : null}{record.title}</strong>
        <small>{sub}</small>
      </button>
      <time title={record.updatedAt ? new Date(record.updatedAt).toLocaleString() : undefined}>{record.updatedAt ? relativeTime(record.updatedAt) : "未知"}</time>
    </div>;
  };
  return <section className="workspace">
    <div className="workspace-main">
      <div className="workspace-title"><div><p className="eyebrow">{props.source === "chatgpt" ? "浏览器会话" : "本机任务"}</p><h1>{props.title}</h1><p>{props.subtitle}</p></div><div className="title-actions">{props.onOpenExternal && <button onClick={() => props.onOpenExternal?.()}>打开 ChatGPT</button>}{props.accounts && props.accounts.length > 1 && <select value={props.accountKey} onChange={(event) => props.onAccount?.(event.target.value)}>{props.accounts.map((account) => <option key={account.key} value={account.key}>{account.label}</option>)}</select>}<button className="refresh" disabled={props.loading || !props.refreshable} onClick={() => void runRefresh()}>{props.loading ? "同步中…" : "完整刷新"}</button></div></div>
      <div className="toolbar"><input ref={searchRef} className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题（按 / 聚焦）" aria-label="搜索标题"/>{props.onKind && <Segmented value={props.kind ?? "chat"} options={[["chat", "聊天"], ["work", "工作"]] as Array<["chat" | "work", string]>} onChange={props.onKind} aria-label="会话类型"/>}<Segmented<AgeFilter> className="age-filter" value={age} options={ageOptions} onChange={setAge} aria-label="时间范围"/><select className="refresh" value={sort} onChange={(event) => setSort(event.target.value as "newest" | "oldest")} aria-label="排序"><option value="newest">最新优先</option><option value="oldest">最早优先</option></select></div>
      {(props.error || props.notice || localNotice) && <div className={`notice ${props.error ? "error" : ""}`}>{props.error || localNotice || props.notice}</div>}
      <div className="list" ref={listRef} onScroll={(event) => { const node = event.currentTarget; if (node.scrollTop + node.clientHeight >= node.scrollHeight - 120) setLimit((old) => Math.min(old + 100, visible.length)); }}>
        <div className="list-head"><span></span><span>{visible.length} 条结果</span><span>最后更新</span></div>
        {groups ? groups.map((group) => <details className="project-group" open={!collapsedGroups.has(group.key)} onToggle={(event) => { const open = (event.target as HTMLDetailsElement).open; if (open === collapsedGroups.has(group.key)) toggleGroup(group.key, open); }} key={group.key}><summary><span>📁 {group.name}</span><small>{group.records.length} 条{group.path ? ` · ${group.path}` : ""}</small></summary>{group.records.map(renderRow)}</details>) : shown.map(renderRow)}
        {!props.loading && !shown.length && (props.records.length === 0
          ? <div className="empty"><strong>{props.source === "chatgpt" ? "还没有同步过会话" : "还没有读取到任务"}</strong><small>{props.emptyHint}</small>{props.refreshable && <button onClick={() => void runRefresh()}>完整刷新</button>}</div>
          : <div className="empty"><strong>当前筛选下没有记录</strong><small>换个搜索关键词，或放宽时间范围再试。</small><button onClick={() => { setQuery(""); setAge("all"); }}>清除筛选</button></div>)}
      </div>
      <div className="actionbar">
        <div><strong>已选 {selected.size} 条</strong><span>{props.state === "scheduled" ? "已安排会话请在 ChatGPT 官方页面管理" : props.writable ? "操作只影响当前筛选与选择" : "只读状态"}</span></div>
        <div className="selection-actions"><button type="button" className={allSelected ? "active" : ""} disabled={!selectable.length || busy} onClick={() => setSelected(new Set(selectable))}>全选当前结果</button><button type="button" disabled={!selected.size || busy} onClick={() => setSelected(new Set())}>清空选择</button></div>
        <div className="primary-actions">{props.state === "active" && <button type="button" className="primary" disabled={!props.writable || !selected.size || busy} onClick={() => void batch("archive")}>归档</button>}{props.state === "archived" && <button type="button" className="primary" disabled={!props.writable || !selected.size || busy} onClick={() => void batch("restore")}>恢复</button>}</div>
        <div className="danger-actions">{busy && props.onCancel && <button type="button" className="danger" onClick={() => void props.onCancel?.()}>停止后续操作</button>}{props.state !== "scheduled" && <button type="button" className="danger" disabled={!props.writable || !selected.size || busy} onClick={() => void batch("delete")}>永久删除</button>}</div>
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
  return <article className="log-card"><h2>运行日志</h2><p>应用运行事件的实时输出，仅保存在本机，用于问题排查。</p>
    <pre className="log-view" ref={viewRef}>{lines.length ? lines.join("\n") : "暂无日志"}</pre>
    <div className="card-actions">
      <button onClick={refresh}>刷新日志</button>
      <button onClick={() => void window.conversationManager.logs.clear().then(() => { setLines([]); setSavedPath(""); })}>清空日志</button>
      <button onClick={() => void window.conversationManager.logs.save().then((result) => { if (result.saved && result.path) setSavedPath(`已保存到 ${result.path}`); })}>保存日志</button>
      <label className="toggle"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />自动滚动</label>
    </div>
    {savedPath && <p className="pair-feedback">{savedPath}</p>}
  </article>;
}

function Settings({ version, onCodexStatus }: { version: string; onCodexStatus?(available: boolean): void }) {
  const [update, setUpdate] = useState<UpdateState | null>(null); const [bridge, setBridge] = useState<PairingState | null>(null); const [cache, setCache] = useState<{ accounts: number; records: number; bytes: number; lastSyncedAt: number | null; lastFullSyncedAt: number | null } | null>(null); const [codexStatus, setCodexStatus] = useState<{ available: boolean; message: string; command: string } | null>(null); const [theme, setTheme] = useState<ThemePreference>("system"); const [pairMessage, setPairMessage] = useState("");
  const readCodexStatus = () => void window.conversationManager.codex.status().then((value) => { setCodexStatus(value); onCodexStatus?.(value.available); });
  useEffect(() => { void window.conversationManager.updates.getState().then(setUpdate); void window.conversationManager.chatgpt.state().then(setBridge); void window.conversationManager.chatgpt.cacheStats().then(setCache); void window.conversationManager.theme.get().then(setTheme); readCodexStatus(); return window.conversationManager.updates.onState(setUpdate); }, []);
  const changeTheme = (value: ThemePreference) => { setTheme(value); void window.conversationManager.theme.set(value); };
  return <section className="settings"><p className="eyebrow">Conversation Manager v{version}</p><h1>设置与隐私</h1><div className="settings-grid"><article><h2>外观</h2><p>界面默认跟随系统深色模式自动切换，也可以手动固定为浅色或深色。</p><div className="card-actions"><Segmented value={theme} options={[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]] as Array<[ThemePreference, string]>} onChange={changeTheme} aria-label="外观主题"/></div></article><article><h2>浏览器桥接</h2><p>{bridge?.connected ? `已连接${bridge.extensionVersion && bridge.extensionVersion !== version ? ` · 扩展 v${bridge.extensionVersion} 需重载` : ""}` : bridge?.paired ? "已配对，等待浏览器" : "尚未配对"}</p>{pairMessage && <p className="pair-feedback">{pairMessage}</p>}{bridge?.code && <div className="pair-code"><span>配对码 · 5 分钟内有效</span><strong>{bridge.code}</strong><small>在浏览器扩展中输入，或等待自动连接</small></div>}<div className="card-actions"><button onClick={() => { setPairMessage("正在发起新的配对…"); void window.conversationManager.chatgpt.beginPairing().then((value) => { setBridge(value); setPairMessage(value.code ? "已开始配对：等待浏览器扩展连接（通常几秒内自动完成）" : "已开始配对"); }); }}>开始配对</button><button onClick={() => { setPairMessage("正在清除…"); void window.conversationManager.chatgpt.clearPairing().then((value) => { setBridge(value); setPairMessage("已清除配对。扩展默认会在后台自动重新连接；也可点击“开始配对”立即发起新的配对。"); }); }}>清除配对</button><button onClick={() => void window.conversationManager.chatgpt.showExtension()}>打开扩展目录</button></div></article><article><h2>ChatGPT 缓存</h2><p>{cache ? `${cache.records} 条记录 · ${formatBytes(cache.bytes)}${cache.lastSyncedAt ? ` · ${relativeTime(cache.lastSyncedAt)}同步` : ""}${cache.lastFullSyncedAt ? ` · ${relativeTime(cache.lastFullSyncedAt)}完整校准` : ""}` : "正在读取…"}</p><div className="card-actions"><button onClick={() => void window.conversationManager.chatgpt.clearCache().then(setCache)}>清除缓存</button></div></article><article><h2>Codex 后端</h2><p>{codexStatus?.message || "正在自动检测统一桌面客户端…"}<br/><small>{codexStatus?.command}</small></p><div className="card-actions">{codexStatus?.available === false && <button onClick={() => void window.conversationManager.codex.selectCommand().then(readCodexStatus)}>手动选择（兜底）</button>}</div></article><article><h2>自动更新</h2><p>{update?.message}</p><label className="toggle"><input type="checkbox" checked={update?.autoUpdate ?? true} onChange={(event) => void window.conversationManager.updates.setAutoUpdate(event.target.checked).then(setUpdate)}/>默认自动检查更新</label><div className="card-actions">{update?.autoUpdate === false && <button onClick={() => void window.conversationManager.updates.check()}>立即检查</button>}{update?.autoUpdate === false && update?.phase === "downloaded" && update.canAutoInstall && <button onClick={() => void window.conversationManager.updates.install()}>重启安装</button>}{update?.phase === "available" && !update.canAutoInstall && <button onClick={() => void window.conversationManager.updates.openRelease()}>打开下载页</button>}</div></article><article><h2>隐私边界</h2><p>管理器只保存会话标题、ID、时间和状态。Cookie、访问令牌、正文及 Codex 认证文件不会被读取或复制。</p></article><article><h2>连接方式</h2><p>ChatGPT 会话复用 Chrome/Edge 登录；统一 ChatGPT/Codex 桌面客户端中的 Codex 任务通过自动发现的本机 App Server 读取。两者都不在管理器中重复登录。</p></article><LogCard /></div></section>;
}

function toChatManaged(record: CachedConversation): ManagedConversation { return { source: "chatgpt", ...record, capabilities: record.state === "scheduled" ? [] : record.state === "archived" ? ["open", "restore", "delete"] : ["open", "archive", "delete"], running: false }; }
function toCodexManaged(thread: CodexThread, archived: boolean): ManagedConversation { return { source: "codex", id: thread.id, title: thread.name?.trim() || thread.preview?.trim() || "未命名任务", preview: thread.preview?.trim().replace(/\s+/g, " ").slice(0, 160) || null, createdAt: thread.createdAt * 1000, updatedAt: thread.updatedAt * 1000, state: archived ? "archived" : "active", projectId: thread.projectId || undefined, cwd: thread.cwd, pinned: false, running: thread.status?.type === "active", current: false, capabilities: thread.status?.type === "active" ? ["open"] : archived ? ["open", "restore", "delete"] : ["open", "archive", "delete"] }; }
function relativeTime(value: number): string { const seconds = Math.max(0, Math.round((Date.now() - value) / 1000)); return seconds < 60 ? "刚刚" : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : seconds < 86400 ? `${Math.floor(seconds / 3600)} 小时前` : seconds < 7 * 86400 ? `${Math.floor(seconds / 86400)} 天前` : new Date(value).toLocaleDateString(); }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error:\s*/, ""); }
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
