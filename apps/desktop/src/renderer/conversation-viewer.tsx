import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { t } from "./strings.js";

export interface ViewerMessage { role: string; at: number | null; text: string }

// 生成 wolai 风格的代码块：头部（语言标签 + 复制按钮）与代码主体一体渲染，
// 语言未知时用 highlight.js 自动检测；复制按钮通过事件委托响应点击
export function renderMarkdown(text: string): string {
  const parsed = marked.parse(text ?? "", { async: false });
  const html = DOMPurify.sanitize(typeof parsed === "string" ? parsed : "", { ADD_ATTR: ["target"] });
  const container = document.createElement("div");
  container.innerHTML = html;
  container.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;
    const declared = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    const raw = code.textContent ?? "";
    let language = declared;
    let highlighted: string;
    if (declared && hljs.getLanguage(declared)) {
      highlighted = hljs.highlight(raw, { language: declared, ignoreIllegals: true }).value;
    } else {
      const auto = hljs.highlightAuto(raw);
      highlighted = auto.value;
      language = auto.language ?? "";
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

const ROLE_KEYS: Array<[RegExp, string]> = [[/user/i, "用户"], [/reason|think/i, "思考"], [/agent|assistant/i, "助手"], [/tool/i, "工具"]];
function roleLabel(role: string): string { for (const [pattern, key] of ROLE_KEYS) if (pattern.test(role)) return t(key); return t("工具"); }

export const ConversationViewerPanel = memo(function ConversationViewerPanel(props: { title: string; subtitle?: string; messages: ViewerMessage[]; loading: boolean; error: string; externalLabel: string; onClose(): void; onOpenExternal(): void }) {
  const rendered = useMemo(() => props.messages.map((message) => ({ role: message.role, html: renderMarkdown(message.text) })), [props.messages]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  useEffect(() => { const root = bodyRef.current; if (root) root.scrollTop = 0; }, [props.title, props.subtitle, props.messages]);
  const copyAll = () => { const markdown = props.messages.map((message) => `## ${roleLabel(message.role)}\n\n${message.text}`).join("\n\n"); void navigator.clipboard.writeText(markdown).then(() => { setCopiedAll(true); setTimeout(() => setCopiedAll(false), 1500); }).catch(() => {}); };
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
      <strong title={props.subtitle ? `${props.title} · ${props.subtitle}` : props.title}>{props.title}</strong>
      {!props.loading && !props.error && props.messages.length > 0 && <small className="viewer-count">{t("{n} 条消息", { n: props.messages.length })}</small>}
      {!props.loading && !props.error && props.messages.length > 0 && <button type="button" onClick={copyAll}>{copiedAll ? t("已复制全文") : t("复制全文")}</button>}
      <button type="button" onClick={props.onOpenExternal}>{props.externalLabel}</button>
      <button type="button" className="viewer-close" aria-label={t("关闭")} onClick={props.onClose}>×</button>
    </div>
    <div className="viewer-body" ref={bodyRef} onClick={onBodyClick}>
      {props.loading && <p className="viewer-status">{t("正在加载会话内容…")}</p>}
      {!props.loading && props.error && <p className="viewer-status">{props.error}</p>}
      {!props.loading && !props.error && rendered.map((message, index) => (
        <div className={`viewer-message role-${message.role.replace(/[^a-z]/gi, "")}`} key={`${index}`}>
          <p className="viewer-role">{roleLabel(message.role)}</p>
          <div className="viewer-text" dangerouslySetInnerHTML={{ __html: message.html }} />
        </div>
      ))}
      {!props.loading && !props.error && !rendered.length && <p className="viewer-status">{t("没有可显示的会话内容")}</p>}
    </div>
  </aside>;
});
