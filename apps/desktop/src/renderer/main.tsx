import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { filterConversations, type AgeFilter, type ManagedConversation } from "@cgn/conversation-domain";
import type { CodexThread } from "@cgn/codex-app-server-adapter";
import type { UpdateState } from "./global.js";
import "./styles.css";

type Mode = "chatgpt" | "codex" | "settings";

function threadTitle(thread: CodexThread): string {
  return thread.name?.trim() || thread.preview?.trim() || "未命名任务";
}

function toManaged(thread: CodexThread, archived: boolean): ManagedConversation {
  return {
    source: "codex",
    id: thread.id,
    title: threadTitle(thread),
    createdAt: thread.createdAt * 1000,
    updatedAt: thread.updatedAt * 1000,
    state: archived ? "archived" : "active",
    projectId: thread.projectId ?? undefined,
    cwd: thread.cwd,
    pinned: false,
    running: thread.status?.type === "active",
    current: false,
    capabilities: archived ? ["read", "restore", "delete"] : ["read", "archive", "delete", "fork"]
  };
}

function App() {
  const [mode, setMode] = useState<Mode>("chatgpt");
  const [version, setVersion] = useState("preview");

  useEffect(() => { void window.cgn.appVersion().then(setVersion); }, []);
  useEffect(() => { void window.cgn.setMode(mode); }, [mode]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>CGN</span><strong>Desktop</strong></div>
        <nav aria-label="产品切换">
          <button className={mode === "chatgpt" ? "active" : ""} onClick={() => setMode("chatgpt")}>ChatGPT</button>
          <button className={mode === "codex" ? "active" : ""} onClick={() => setMode("codex")}>Codex</button>
          <button className={mode === "settings" ? "active" : ""} onClick={() => setMode("settings")}>设置</button>
        </nav>
        <p className="version">v{version}</p>
      </aside>
      <main className="workspace">
        {mode === "codex" && <CodexWorkspace />}
        {mode === "settings" && <Settings />}
        {mode === "chatgpt" && <div className="loading-view">正在加载 ChatGPT…</div>}
      </main>
    </div>
  );
}

function CodexWorkspace() {
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [age, setAge] = useState<AgeFilter>("all");
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<CodexThread | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load(full = false) {
    setLoading(true);
    setError("");
    setSelected(new Set());
    try {
      const all: CodexThread[] = [];
      let cursor: string | null = null;
      do {
        const page = await window.cgn.codex.list({ cursor, archived, searchTerm: query.trim() || undefined, full });
        all.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      setThreads([...new Map(all.map((thread) => [thread.id, thread])).values()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 200);
    return () => window.clearTimeout(timer);
  }, [archived, query]);

  const visible = useMemo(() => {
    const ids = new Set(filterConversations(threads.map((thread) => toManaged(thread, archived)), {
      state: archived ? "archived" : "active",
      age
    }).map((record) => record.id));
    return threads.filter((thread) => ids.has(thread.id));
  }, [threads, archived, age]);

  const selectable = visible.filter((thread) => thread.status?.type !== "active").map((thread) => thread.id);
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function openThread(thread: CodexThread) {
    setError("");
    try {
      const response = await window.cgn.codex.read(thread.id);
      setDetail(response.thread);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function runBatch(action: "archive" | "unarchive" | "delete") {
    const ids = [...selected];
    if (!ids.length) return;
    setLoading(true);
    setError("");
    try {
      let confirmationToken: string | undefined;
      if (action === "delete") {
        const preview = await window.cgn.codex.previewDelete(ids);
        if (preview.missing.length) throw new Error(`找不到 ${preview.missing.length} 个任务，请刷新后重试`);
        if (preview.running.length) throw new Error(`有 ${preview.running.length} 个任务仍在运行，已停止删除`);
        if (!preview.confirmationToken) throw new Error("无法生成安全删除确认");
        const shown = preview.tasks.slice(0, 10).map((task) => `• ${task.title}${task.derived ? "（派生任务）" : ""}`).join("\n");
        const more = preview.tasks.length > 10 ? `\n…另有 ${preview.tasks.length - 10} 个` : "";
        if (preview.tasks.length > 20) {
          const answer = window.prompt(`将永久删除 ${preview.tasks.length} 个任务（含派生任务）：\n\n${shown}${more}\n\n请输入 ${preview.tasks.length} 确认：`);
          if (answer !== String(preview.tasks.length)) return;
        } else if (!window.confirm(`永久删除 ${preview.tasks.length} 个任务（含派生任务）：\n\n${shown}${more}\n\n此操作无法撤销。`)) return;
        confirmationToken = preview.confirmationToken;
      }
      const result = await window.cgn.codex.runBatch(action, ids, confirmationToken);
      if (action === "delete") await load();
      else setThreads((current) => current.filter((thread) => !result.succeeded.includes(thread.id)));
      setSelected(new Set(result.failed.map((item) => item.id)));
      setNotice(`成功 ${result.succeeded.length}，失败 ${result.failed.length}`);
      if (result.failed.length) setError(result.failed.map((item) => `${item.id}: ${item.message}`).join("\n"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="codex-page">
      <header className="page-header">
        <div><p className="eyebrow">本机 Codex App Server</p><h1>任务管理</h1></div>
        <button className="secondary" onClick={() => void load(true)} disabled={loading}>完整校准</button>
      </header>
      <div className="toolbar">
        <div className="segmented" aria-label="归档状态">
          <button className={!archived ? "active" : ""} onClick={() => setArchived(false)}>未归档</button>
          <button className={archived ? "active" : ""} onClick={() => setArchived(true)}>已归档</button>
        </div>
        <input aria-label="搜索任务" placeholder="搜索标题" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="更新时间" value={age} onChange={(event) => setAge(event.target.value as AgeFilter)}>
          <option value="all">全部时间</option><option value="day">1 天前</option><option value="week">1 周前</option>
          <option value="month">1 个月前</option><option value="halfYear">半年前</option>
        </select>
      </div>
      <div className="selection-bar">
        <button className={allSelected ? "active" : ""} onClick={() => setSelected(allSelected ? new Set() : new Set(selectable))}>全选当前结果</button>
        <button onClick={() => setSelected(new Set())}>清空选择</button>
        <span>已选 {selected.size} · 当前 {visible.length}</span>
        <div className="batch-actions">
          <button disabled={!selected.size || loading} onClick={() => void runBatch(archived ? "unarchive" : "archive")}>{archived ? "恢复" : "归档"}</button>
          <button className="danger" disabled={!selected.size || loading} onClick={() => void runBatch("delete")}>删除</button>
        </div>
      </div>
      {error && <pre className="alert error">{error}</pre>}
      {notice && <p className="alert success">{notice}</p>}
      <div className="content-grid">
        <div className="thread-list" aria-busy={loading}>
          {loading && !threads.length && <p className="empty">正在读取任务…</p>}
          {!loading && !visible.length && <p className="empty">没有符合条件的任务</p>}
          {visible.map((thread) => {
            const running = thread.status?.type === "active";
            return (
              <article className={`thread-row ${detail?.id === thread.id ? "current" : ""}`} key={thread.id}>
                <input type="checkbox" aria-label={`选择 ${threadTitle(thread)}`} checked={selected.has(thread.id)} disabled={running} onChange={() => toggle(thread.id)} />
                <button className="thread-main" onClick={() => void openThread(thread)}>
                  <strong>{threadTitle(thread)}</strong>
                  <small>{new Date(thread.updatedAt * 1000).toLocaleString()} · {thread.cwd || "未知目录"}</small>
                </button>
                {running && <span className="badge">运行中</span>}
              </article>
            );
          })}
        </div>
        <ThreadDetail thread={detail} onFork={async (threadId, lastTurnId) => {
          if (!window.confirm("从所选轮次创建 Codex 分支？")) return;
          try {
            const result = await window.cgn.codex.fork(threadId, lastTurnId);
            setNotice(`已创建分支：${threadTitle(result.thread)}`);
            await load();
          } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        }} />
      </div>
    </section>
  );
}

function ThreadDetail({ thread, onFork }: { thread: CodexThread | null; onFork(threadId: string, lastTurnId?: string): Promise<void> }) {
  if (!thread) return <aside className="thread-detail empty">选择任务查看完整内容</aside>;
  return (
    <aside className="thread-detail">
      <header><h2>{threadTitle(thread)}</h2><button className="secondary" disabled={thread.status?.type === "active"} onClick={() => void onFork(thread.id)}>从末尾分支</button></header>
      <p className="detail-meta">{thread.cwd}</p>
      {(thread.turns ?? []).map((turn) => (
        <section className="turn" key={turn.id}>
          <div className="turn-heading"><strong>轮次</strong><button onClick={() => void onFork(thread.id, turn.id)}>从这里分支</button></div>
          {turn.items.map((item, index) => (
            <details key={`${turn.id}-${index}`} open={index < 2}>
              <summary>{String(item.type ?? "项目")}</summary>
              <pre>{JSON.stringify(item, null, 2)}</pre>
            </details>
          ))}
        </section>
      ))}
    </aside>
  );
}

function Settings() {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [updateError, setUpdateError] = useState("");

  useEffect(() => {
    const unsubscribe = window.cgn.updates.onState(setUpdate);
    void window.cgn.updates.getState().then(setUpdate).catch((cause) => setUpdateError(cause instanceof Error ? cause.message : String(cause)));
    return unsubscribe;
  }, []);

  async function setAutoUpdate(enabled: boolean) {
    setUpdateError("");
    try {
      setUpdate(await window.cgn.updates.setAutoUpdate(enabled));
    } catch (cause) {
      setUpdateError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function checkForUpdate() {
    setUpdateError("");
    try {
      setUpdate(await window.cgn.updates.check());
    } catch (cause) {
      setUpdateError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const updateBusy = update?.phase === "checking" || update?.phase === "downloading";
  return (
    <section className="settings-page">
      <p className="eyebrow">CGN Desktop</p><h1>设置与兼容性</h1>
      <div className="settings-card">
        <h2>应用更新</h2>
        <label className="update-toggle">
          <input type="checkbox" checked={update?.autoUpdate ?? true} disabled={!update} onChange={(event) => void setAutoUpdate(event.target.checked)} />
          <span>自动检查更新（默认开启）</span>
        </label>
        <p className="update-status" aria-live="polite">{update?.message ?? "正在读取更新设置…"}</p>
        {update?.phase === "downloading" && <progress max="100" value={update.percent ?? 0}>{update.percent ?? 0}%</progress>}
        {updateError && <p className="update-error">{updateError}</p>}
        <div className="update-actions">
          <button className="secondary" disabled={!update || updateBusy || update.phase === "unsupported"} onClick={() => void checkForUpdate()}>手动检查更新</button>
          {update?.phase === "downloaded" && update.canAutoInstall && <button className="secondary" onClick={() => void window.cgn.updates.install()}>重启并安装</button>}
          {(update?.phase === "available" && !update.canAutoInstall || update?.phase === "error") && <button className="secondary" onClick={() => void window.cgn.updates.openRelease()}>打开 Release 下载</button>}
        </div>
        <p className="update-note">安装版会自动下载更新并在退出时安装；便携版会自动检查，但需要从 GitHub Release 手动下载新版。</p>
      </div>
      <div className="settings-card"><h2>ChatGPT</h2><p>登录信息保存在独立的 Electron 会话 <code>persist:cgn-chatgpt</code> 中。扩展运行数据使用该会话的 <code>chrome.storage.local</code>，不会复制浏览器 Cookie。</p></div>
      <div className="settings-card"><h2>Codex</h2><p>任务通过本机 <code>codex app-server</code> 读取，不直接访问 <code>sessions/*.jsonl</code>、状态数据库或 <code>auth.json</code>。</p></div>
      <div className="settings-card"><h2>文档</h2><button className="link" onClick={() => void window.cgn.openExternal("https://developers.openai.com/codex/app-server")}>打开 Codex App Server 文档</button></div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
