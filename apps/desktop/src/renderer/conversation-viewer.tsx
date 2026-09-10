import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { t } from "./strings.js";

export interface ViewerMessage { role: string; at: number | null; text: string }

// 生成 wolai 风格的代码块：头部（语言标签 + 复制按钮）与代码主体一体渲染，
// 语言未知时用 highlight.js 自动检测；复制按钮通过事件委托响应点击
export function renderMarkdown(text: string): string {
  const parsed = marked.parse(text ?? "", { async: false, gfm: true, breaks: true });
  const html = DOMPurify.sanitize(typeof parsed === "string" ? parsed : "", { ADD_ATTR: ["target"] });
  const container = document.createElement("div");
  container.innerHTML = html;
  container.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;
    const declared = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    const raw = code.textContent ?? "";
    let language: string;
    let highlighted: string;
    if (declared && hljs.getLanguage(declared)) {
      language = declared;
      highlighted = hljs.highlight(raw, { language: declared, ignoreIllegals: true }).value;
    } else if (!declared && raw.length <= 40_000) {
      const auto = hljs.highlightAuto(raw);
      language = auto.language || "text";
      highlighted = auto.value;
    } else {
      // 声明了未注册语言（如 mermaid）或超长代码：按纯文本转义显示，标签仍显示声明语言
      language = declared || "text";
      highlighted = hljs.highlight(raw, { language: "plaintext", ignoreIllegals: true }).value;
    }
    const bar = document.createElement("div");
    bar.className = "code-bar";
    const label = document.createElement("span");
    label.className = "code-lang";
    label.textContent = language || "text";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-copy";
    copy.textContent = t("复制");
    bar.append(label, copy);
    const newCode = document.createElement("code");
    newCode.className = "hljs";
    newCode.innerHTML = highlighted;
    pre.replaceChildren(bar, newCode);
  });
  container.querySelectorAll("a").forEach((link) => { link.setAttribute("target", "_blank"); link.setAttribute("rel", "noopener noreferrer"); });
  container.querySelectorAll("img").forEach((image) => image.setAttribute("loading", "lazy"));
  return container.innerHTML;
}

function roleLabel(role: string, sourceName: string): string {
  if (/user/i.test(role)) return t("用户");
  if (/agent|assistant/i.test(role)) return sourceName;
  if (/reason|think/i.test(role)) return t("思考");
  if (/tool/i.test(role)) return t("工具");
  return sourceName;
}

export function relativeTime(value: number): string { const seconds = Math.max(0, Math.round((Date.now() - value) / 1000)); return seconds < 60 ? t("刚刚") : seconds < 3600 ? t("{n} 分钟前", { n: Math.floor(seconds / 60) }) : seconds < 86400 ? t("{n} 小时前", { n: Math.floor(seconds / 3600) }) : seconds < 7 * 86400 ? t("{n} 天前", { n: Math.floor(seconds / 86400) }) : new Date(value).toLocaleDateString(); }

export const ConversationViewerPanel = memo(function ConversationViewerPanel(props: { title: string; subtitle?: string; messages: ViewerMessage[]; loading: boolean; error: string; externalLabel: string; sourceName: string; hasPrev?: boolean; hasNext?: boolean; onPrev?(): void; onNext?(): void; onClose(): void; onOpenExternal(): void; onRetry?(): void }) {
  const rendered = useMemo(() => props.messages
    .filter((message) => !/^(tool|system)$/i.test(message.role))
    .map((message) => ({ role: message.role, at: message.at, html: renderMarkdown(message.text) })), [props.messages]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  useEffect(() => { const root = bodyRef.current; if (root) root.scrollTop = 0; }, [props.title, props.subtitle, props.messages]);
  const copyAll = () => { const markdown = props.messages.map((message) => `## ${roleLabel(message.role, props.sourceName)}\n\n${message.text}`).join("\n\n"); void navigator.clipboard.writeText(markdown).then(() => { setCopiedAll(true); setTimeout(() => setCopiedAll(false), 1500); }).catch(() => {}); };
  const onBodyClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const button = target.closest(".code-copy");
    if (!button) return;
    const code = button.closest("pre")?.querySelector("code");
    if (!code) return;
    void navigator.clipboard.writeText(code.textContent || "").then(() => { button.textContent = t("已复制"); setTimeout(() => { button.textContent = t("复制"); }, 1500); }).catch(() => {});
  };
  return <aside className="viewer-panel" role="dialog" aria-label={t("会话内容")}>
    <div className="viewer-head">
      {!props.hasPrev && !props.hasNext ? null : <button type="button" className="viewer-nav" aria-label={t("上一个")} disabled={!props.hasPrev} onClick={props.onPrev}>‹</button>}
      {!props.hasPrev && !props.hasNext ? null : <button type="button" className="viewer-nav" aria-label={t("下一个")} disabled={!props.hasNext} onClick={props.onNext}>›</button>}
      <strong title={props.subtitle ? `${props.title} · ${props.subtitle}` : props.title}>{props.title}</strong>
      {!props.loading && !props.error && props.messages.length > 0 && <small className="viewer-count">{t("{n} 条消息", { n: props.messages.length })}</small>}
      {!props.loading && !props.error && props.messages.length > 0 && <button type="button" onClick={copyAll}>{copiedAll ? t("已复制全文") : t("复制全文")}</button>}
      <button type="button" onClick={props.onOpenExternal}>{props.externalLabel}</button>
      <button type="button" className="viewer-close" aria-label={t("关闭")} onClick={props.onClose}>×</button>
    </div>
    <div className="viewer-body" ref={bodyRef} onClick={onBodyClick}>
      {props.loading && <p className="viewer-status">{t("正在加载会话内容…")}</p>}
      {!props.loading && props.error && <p className="viewer-status">{props.error}{props.onRetry && <button type="button" className="viewer-retry" onClick={props.onRetry}>{t("重试")}</button>}</p>}
      {!props.loading && !props.error && rendered.map((message, index) => (
        <div className={`viewer-message role-${message.role.replace(/[^a-z]/gi, "")}`} key={`${index}`}>
          <p className="viewer-role">{roleLabel(message.role, props.sourceName)}{message.at ? ` · ${relativeTime(message.at)}` : ""}</p>
          <div className="viewer-text" dangerouslySetInnerHTML={{ __html: message.html }} />
        </div>
      ))}
      {!props.loading && !props.error && !rendered.length && <p className="viewer-status">{t("没有可显示的会话内容")}</p>}
    </div>
    <button type="button" className="viewer-jump" aria-label={t("跳转最新")} onClick={() => { const root = bodyRef.current; if (root) root.scrollTo({ top: root.scrollHeight, behavior: "smooth" }); }}>⤓</button>
  </aside>;
});
