export type ExportLang = "zh" | "en";

export interface ExportMessage { role: string; at: number | null; text: string }
export interface ChatGptTranscript { id: string; title: string; messages: ExportMessage[] }
export interface CodexThreadMeta { id: string; name?: string | null; preview?: string | null; cwd?: string | null }

const LABELS: Record<ExportLang, {
  source: string; user: string; assistant: string; tool: string; system: string; reasoning: string;
  exportedAt: string; messages: string; untitled: string; workingDir: string;
  noMessages: string; summary: string; noContent: string; from: string;
}> = {
  zh: {
    source: "来源", user: "用户", assistant: "助手", tool: "工具", system: "系统", reasoning: "思考",
    exportedAt: "导出时间", messages: "消息数", untitled: "未命名会话", workingDir: "工作目录",
    noMessages: "该会话没有可导出的消息内容。", summary: "摘要", noContent: "当前 Codex App Server 未返回该任务的正文内容", from: "来源"
  },
  en: {
    source: "Source", user: "User", assistant: "Assistant", tool: "Tool", system: "System", reasoning: "Reasoning",
    exportedAt: "Exported at", messages: "Messages", untitled: "Untitled conversation", workingDir: "Working directory",
    noMessages: "This conversation has no exportable message content.", summary: "Summary", noContent: "The Codex App Server did not return message content for this task", from: "Source"
  }
};

function labels(lang: ExportLang) { return LABELS[lang] ?? LABELS.zh; }

export function roleLabel(role: string, lang: ExportLang = "zh"): string {
  const l = labels(lang);
  if (role === "user" || role.includes("user")) return l.user;
  if (role === "assistant" || role.includes("agent")) return l.assistant;
  if (role.includes("reason") || role.includes("think")) return l.reasoning;
  if (role === "tool") return l.tool;
  if (role === "system") return l.system;
  return l.tool;
}

export function safeFileName(title: string, id: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).replace(/[. ]+$/, "");
  const suffix = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  return `${base || "未命名会话"}-${suffix || "export"}.md`;
}

export function formatTimestamp(at: number | null, lang: ExportLang = "zh"): string {
  if (at === null || !Number.isFinite(at)) return lang === "en" ? "time unknown" : "时间未知";
  return new Date(at).toLocaleString(lang === "en" ? "en-US" : "zh-CN", { hour12: false });
}

export function chatgptTranscriptMarkdown(transcript: ChatGptTranscript, exportedAt: number, accountLabel: string, lang: ExportLang = "zh"): string {
  const l = labels(lang);
  const account = accountLabel ? `（${accountLabel}）` : "";
  const header = [
    `# ${transcript.title || l.untitled}`,
    "",
    `- ${l.source}: ChatGPT${account}`,
    `- Conversation ID: \`${transcript.id}\``,
    `- ${l.exportedAt}: ${new Date(exportedAt).toLocaleString(lang === "en" ? "en-US" : "zh-CN", { hour12: false })}`,
    `- ${l.messages}: ${transcript.messages.length}`,
    ""
  ];
  if (!transcript.messages.length) header.push(`> ${l.noMessages}`, "");
  const body = transcript.messages.map((message) => `## ${roleLabel(message.role, lang)} · ${formatTimestamp(message.at, lang)}\n\n${message.text}\n`);
  return [...header, "---", "", ...body].join("\n");
}

function turnText(item: Record<string, unknown>): string | null {
  for (const key of ["text", "content", "message"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function codexTurnsFromPayload(payload: unknown): Array<Record<string, unknown>> {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const thread = root.thread && typeof root.thread === "object" ? root.thread as Record<string, unknown> : root;
  const turns = thread.turns;
  return Array.isArray(turns) ? turns.filter((turn): turn is Record<string, unknown> => Boolean(turn && typeof turn === "object")) : [];
}

export function codexMessagesFromTurns(turns: Array<Record<string, unknown>>): ExportMessage[] {
  const messages: ExportMessage[] = [];
  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of items) {
      const item = rawItem && typeof rawItem === "object" ? rawItem : {};
      const type = typeof item.type === "string" ? item.type : "";
      const text = turnText(item);
      if (!text) continue;
      const role = type.includes("reason") ? "reasoning" : type.includes("user") ? "user" : type.includes("agent") || type.includes("assistant") ? "assistant" : "tool";
      messages.push({ role, at: null, text });
    }
  }
  return messages;
}

export function codexTranscriptMarkdown(thread: CodexThreadMeta, turns: Array<Record<string, unknown>>, exportedAt: number, lang: ExportLang = "zh"): string {
  const l = labels(lang);
  const header = [
    `# ${thread.name?.trim() || thread.preview?.trim() || l.untitled}`,
    "",
    `- ${l.source}: Codex${thread.cwd ? `（${l.workingDir}: ${thread.cwd}）` : ""}`,
    `- Task ID: \`${thread.id}\``,
    `- ${l.exportedAt}: ${new Date(exportedAt).toLocaleString(lang === "en" ? "en-US" : "zh-CN", { hour12: false })}`,
    ""
  ];
  const body: string[] = [];
  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of items) {
      const item = rawItem && typeof rawItem === "object" ? rawItem : {};
      const type = typeof item.type === "string" ? item.type : "";
      const text = turnText(item);
      if (!text) continue;
      if (type.includes("reason")) { body.push(`### ${l.reasoning}\n\n${text}\n`); continue; }
      const label = type.includes("user") ? l.user : type.includes("agent") || type.includes("assistant") ? l.assistant : roleLabel(type, lang);
      body.push(`## ${label}\n\n${text}\n`);
    }
  }
  if (!body.length) body.push(`> ${l.noContent}${thread.preview ? `；${l.summary}: ${thread.preview}` : ""}。`, "");
  return [...header, "---", "", ...body].join("\n");
}

export function codexMetadataMarkdown(thread: CodexThreadMeta, reason: string, exportedAt: number, lang: ExportLang = "zh"): string {
  const l = labels(lang);
  return [
    `# ${thread.name?.trim() || l.untitled}`,
    "",
    `- ${l.source}: Codex`,
    `- Task ID: \`${thread.id}\``,
    `- ${l.exportedAt}: ${new Date(exportedAt).toLocaleString(lang === "en" ? "en-US" : "zh-CN", { hour12: false })}`,
    "",
    `> ${l.noContent}: ${reason}`,
    thread.preview ? `\n## ${l.summary}\n\n${thread.preview}\n` : ""
  ].join("\n");
}
