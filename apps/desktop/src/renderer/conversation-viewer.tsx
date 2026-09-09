import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked } from "marked";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { t } from "./strings.js";

const LANGUAGES: Array<[string, Parameters<typeof hljs.registerLanguage>[1]]> = [
  ["javascript", javascript], ["typescript", typescript], ["python", python], ["bash", bash], ["shell", bash],
  ["json", json], ["sql", sql], ["xml", xml], ["css", css], ["markdown", markdown], ["yaml", yaml],
  ["java", java], ["c", c], ["cpp", cpp], ["csharp", csharp], ["go", go], ["rust", rust], ["diff", diff]
];
for (const [name, language] of LANGUAGES) hljs.registerLanguage(name, language);

export interface ViewerMessage { role: string; at: number | null; text: string }

export function renderMarkdown(text: string): string {
  const parsed = marked.parse(text ?? "", { async: false });
  const html = DOMPurify.sanitize(typeof parsed === "string" ? parsed : "", { ADD_ATTR: ["target"] });
  const container = document.createElement("div");
  container.innerHTML = html;
  container.querySelectorAll("pre code").forEach((code) => {
    const languageClass = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    const raw = code.textContent ?? "";
    const highlighted = languageClass && hljs.getLanguage(languageClass) ? hljs.highlight(raw, { language: languageClass }) : null;
    if (highlighted) { code.innerHTML = highlighted.value; code.classList.add("hljs"); }
  });
  container.querySelectorAll("a").forEach((link) => { link.setAttribute("target", "_blank"); link.setAttribute("rel", "noopener noreferrer"); });
  container.querySelectorAll("img").forEach((image) => image.setAttribute("loading", "lazy"));
  return container.innerHTML;
}

const ROLE_KEYS: Array<[RegExp, string]> = [[/user/i, "用户"], [/reason|think/i, "思考"], [/agent|assistant/i, "助手"], [/tool/i, "工具"]];
function roleLabel(role: string): string { for (const [pattern, key] of ROLE_KEYS) if (pattern.test(role)) return t(key); return t("工具"); }

export const ConversationViewerPanel = memo(function ConversationViewerPanel(props: { title: string; messages: ViewerMessage[]; loading: boolean; error: string; externalLabel: string; onClose(): void; onOpenExternal(): void }) {
  const rendered = useMemo(() => props.messages.map((message) => ({ role: message.role, html: renderMarkdown(message.text) })), [props.messages]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  useEffect(() => { const root = bodyRef.current; if (root) root.scrollTop = 0; }, [props.title, props.messages]);
  useEffect(() => {
    const root = bodyRef.current; if (!root || props.loading) return;
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".code-bar")) return;
      const code = pre.querySelector("code"); if (!code) return;
      const language = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) || "code";
      const bar = document.createElement("div"); bar.className = "code-bar";
      const label = document.createElement("span"); label.className = "code-lang"; label.textContent = language;
      const copy = document.createElement("button"); copy.type = "button"; copy.className = "code-copy"; copy.textContent = t("复制");
      copy.addEventListener("click", () => { void navigator.clipboard.writeText(code.textContent || "").then(() => { copy.textContent = t("已复制"); setTimeout(() => { copy.textContent = t("复制"); }, 1500); }); });
      bar.appendChild(label); bar.appendChild(copy);
      pre.insertBefore(bar, pre.firstChild);
    });
  }, [rendered, props.loading]);
  const copyAll = () => { const markdown = props.messages.map((message) => `## ${roleLabel(message.role)}\n\n${message.text}`).join("\n\n"); void navigator.clipboard.writeText(markdown).then(() => { setCopiedAll(true); setTimeout(() => setCopiedAll(false), 1500); }); };
  return <aside className="viewer-panel" role="dialog" aria-label={t("会话内容")}>
    <div className="viewer-head">
      <strong title={props.title}>{props.title}</strong>
      {!props.loading && !props.error && <small className="viewer-count">{t("{n} 条消息", { n: props.messages.length })}</small>}
      {!props.loading && !props.error && props.messages.length > 0 && <button type="button" onClick={copyAll}>{copiedAll ? t("已复制全文") : t("复制全文")}</button>}
      <button type="button" onClick={props.onOpenExternal}>{props.externalLabel}</button>
      <button type="button" className="viewer-close" aria-label={t("关闭")} onClick={props.onClose}>×</button>
    </div>
    <div className="viewer-body" ref={bodyRef}>
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
