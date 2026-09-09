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
  return container.innerHTML;
}

const ROLE_KEYS: Array<[RegExp, string]> = [[/user/i, "用户"], [/reason|think/i, "思考"], [/agent|assistant/i, "助手"], [/tool/i, "工具"]];
function roleLabel(role: string): string { for (const [pattern, key] of ROLE_KEYS) if (pattern.test(role)) return t(key); return t("工具"); }

export function ConversationViewerPanel(props: { title: string; messages: ViewerMessage[]; loading: boolean; error: string; onClose(): void; onOpenExternal(): void }) {
  return <aside className="viewer-panel" role="dialog" aria-label={t("会话内容")}>
    <div className="viewer-head">
      <strong title={props.title}>{props.title}</strong>
      <button type="button" onClick={props.onOpenExternal}>{t("在浏览器打开")}</button>
      <button type="button" className="viewer-close" aria-label={t("关闭")} onClick={props.onClose}>×</button>
    </div>
    <div className="viewer-body">
      {props.loading && <p className="viewer-status">{t("正在加载会话内容…")}</p>}
      {!props.loading && props.error && <p className="viewer-status">{props.error}</p>}
      {!props.loading && !props.error && props.messages.map((message, index) => (
        <div className={`viewer-message role-${message.role.replace(/[^a-z]/gi, "")}`} key={`${index}`}>
          <p className="viewer-role">{roleLabel(message.role)}</p>
          <div className="viewer-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
        </div>
      ))}
      {!props.loading && !props.error && !props.messages.length && <p className="viewer-status">{t("没有可显示的会话内容")}</p>}
    </div>
  </aside>;
}
