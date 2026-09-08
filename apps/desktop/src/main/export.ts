export interface ExportMessage { role: string; at: number | null; text: string }
export interface ChatGptTranscript { id: string; title: string; messages: ExportMessage[] }

const ROLE_LABELS: Record<string, string> = { user: "用户", assistant: "助手", tool: "工具", system: "系统" };

export function roleLabel(role: string): string {
  if (ROLE_LABELS[role]) return ROLE_LABELS[role];
  if (role.includes("user")) return "用户";
  if (role.includes("assistant") || role.includes("agent")) return "助手";
  if (role.includes("reason") || role.includes("think")) return "思考";
  return "其他";
}

export function safeFileName(title: string, id: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).replace(/[. ]+$/, "");
  const suffix = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
  return `${base || "未命名会话"}-${suffix || "export"}.md`;
}

export function formatTimestamp(at: number | null): string {
  if (at === null || !Number.isFinite(at)) return "时间未知";
  return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

export function chatgptTranscriptMarkdown(transcript: ChatGptTranscript, exportedAt: number, accountLabel: string): string {
  const header = [
    `# ${transcript.title || "未命名会话"}`,
    "",
    `- 来源：ChatGPT${accountLabel ? `（${accountLabel}）` : ""}`,
    `- 会话 ID：\`${transcript.id}\``,
    `- 导出时间：${new Date(exportedAt).toLocaleString("zh-CN", { hour12: false })}`,
    `- 消息数：${transcript.messages.length}`,
    ""
  ];
  if (!transcript.messages.length) header.push("> 该会话没有可导出的消息内容。", "");
  const body = transcript.messages.map((message) => `## ${roleLabel(message.role)} · ${formatTimestamp(message.at)}\n\n${message.text}\n`);
  return [...header, "---", "", ...body].join("\n");
}

function turnText(item: Record<string, unknown>): string | null {
  for (const key of ["text", "content", "message"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export interface CodexThreadMeta { id: string; name?: string | null; preview?: string | null; cwd?: string | null }

export function codexTurnsFromPayload(payload: unknown): Array<Record<string, unknown>> {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const thread = root.thread && typeof root.thread === "object" ? root.thread as Record<string, unknown> : root;
  const turns = thread.turns;
  return Array.isArray(turns) ? turns.filter((turn): turn is Record<string, unknown> => Boolean(turn && typeof turn === "object")) : [];
}

export function codexTranscriptMarkdown(thread: CodexThreadMeta, turns: Array<Record<string, unknown>>, exportedAt: number): string {
  const header = [
    `# ${thread.name?.trim() || thread.preview?.trim() || "未命名任务"}`,
    "",
    `- 来源：Codex${thread.cwd ? `（工作目录：${thread.cwd}）` : ""}`,
    `- 任务 ID：\`${thread.id}\``,
    `- 导出时间：${new Date(exportedAt).toLocaleString("zh-CN", { hour12: false })}`,
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
      if (type.includes("reason")) { body.push(`### 思考\n\n${text}\n`); continue; }
      const label = type.includes("user") ? "用户" : type.includes("agent") || type.includes("assistant") ? "助手" : roleLabel(type);
      body.push(`## ${label}\n\n${text}\n`);
    }
  }
  if (!body.length) body.push(`> 当前 Codex App Server 未返回该任务的正文内容${thread.preview ? `；任务摘要：${thread.preview}` : ""}。`, "");
  return [...header, "---", "", ...body].join("\n");
}

export function codexMetadataMarkdown(thread: CodexThreadMeta, reason: string, exportedAt: number): string {
  return [
    `# ${thread.name?.trim() || thread.preview?.trim() || "未命名任务"}`,
    "",
    `- 来源：Codex`,
    `- 任务 ID：\`${thread.id}\``,
    `- 导出时间：${new Date(exportedAt).toLocaleString("zh-CN", { hour12: false })}`,
    "",
    `> 无法获取正文内容：${reason}`,
    thread.preview ? `\n## 摘要\n\n${thread.preview}\n` : ""
  ].join("\n");
}
