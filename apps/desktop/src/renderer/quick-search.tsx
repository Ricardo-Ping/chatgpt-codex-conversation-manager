import { useDeferredValue, useEffect, useRef, useState } from "react";
import { relativeTime } from "./conversation-viewer.js";
import { t } from "./strings.js";

interface QuickItem { platform: "chatgpt" | "codex"; id: string; accountKey?: string; title: string; updatedAt: number | null }

// 全局快捷键呼出的快速搜索窗：无边框置顶小窗，跨平台检索本地 ChatGPT 缓存与 Codex 任务，
// Enter 打开后自动隐藏（失焦即隐藏由主进程负责）。
export function QuickSearch() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [rows, setRows] = useState<QuickItem[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const focus = () => inputRef.current?.select();
    window.addEventListener("focus", focus);
    inputRef.current?.focus();
    return () => window.removeEventListener("focus", focus);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const term = deferred.trim();
      const [chatgpt, codexPage] = await Promise.allSettled([
        window.conversationManager.chatgpt.quickSearch({ query: term, limit: 6 }),
        window.conversationManager.codex.list({ archived: false, searchTerm: term || undefined, full: false })
      ]);
      if (cancelled) return;
      const items: QuickItem[] = [];
      if (chatgpt.status === "fulfilled") {
        for (const row of chatgpt.value.rows) items.push({ platform: "chatgpt", id: row.id, accountKey: row.accountKey, title: row.title || t("未命名会话"), updatedAt: row.updatedAt });
      }
      if (codexPage.status === "fulfilled") {
        for (const thread of codexPage.value.data.slice(0, 4)) items.push({ platform: "codex", id: thread.id, title: thread.name || t("未命名任务"), updatedAt: thread.updatedAt * 1000 });
      }
      setRows(items.slice(0, 9));
      setActive(0);
    })();
    return () => { cancelled = true; };
  }, [deferred]);

  const open = (item: QuickItem) => {
    const request = item.platform === "chatgpt"
      ? window.conversationManager.chatgpt.openConversation(item.id)
      : window.conversationManager.codex.open(item.id);
    void request.catch(() => {}).then(() => window.close());
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((old) => Math.min(old + 1, rows.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((old) => Math.max(old - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); const item = rows[active]; if (item) open(item); }
    else if (event.key === "Escape") { event.preventDefault(); window.close(); }
  };

  return <div className="quick">
    <input ref={inputRef} className="quick-input" value={query} placeholder={t("搜索会话…")} aria-label={t("搜索会话…")} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={onKeyDown} />
    <ul className="quick-list">
      {rows.map((item, index) => <li key={`${item.platform}-${item.id}`}>
        <button type="button" className={index === active ? "active" : ""} onMouseEnter={() => setActive(index)} onClick={() => open(item)}>
          <span className={`quick-tag ${item.platform}`}>{item.platform === "chatgpt" ? "ChatGPT" : "Codex"}</span>
          <strong>{item.title}</strong>
          <time>{item.updatedAt ? relativeTime(item.updatedAt) : ""}</time>
        </button>
      </li>)}
      {!rows.length && <li className="quick-empty">{t("无匹配结果")}</li>}
    </ul>
    <p className="quick-foot">{t("Enter 打开 · Esc 关闭 · 全局快捷键 Alt+Shift+Space")}</p>
  </div>;
}
