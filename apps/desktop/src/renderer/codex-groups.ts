import type { ManagedConversation } from "@conversation-manager/conversation-domain";

export interface CodexConversationGroup { key: string; name: string; path: string | null; records: ManagedConversation[] }

// Codex 桌面端为未挂到项目的会话自动创建临时目录（Documents\Codex\日期\标题），这类 cwd 不算项目
const SCRATCH_CWD = /[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}[\\/]/i;

export function isProjectTask(record: ManagedConversation): boolean {
  if (record.projectId) return true;
  const cwd = record.cwd?.trim().replace(/[\\/]+$/, "") || null;
  if (!cwd) return false;
  return !SCRATCH_CWD.test(cwd);
}

export function groupCodexConversations(records: ManagedConversation[]): CodexConversationGroup[] {
  const groups = new Map<string, CodexConversationGroup>();
  for (const record of records) {
    const path = record.cwd?.trim().replace(/[\\/]+$/, "") || null;
    const project = Boolean(record.projectId);
    const realDir = path !== null && !SCRATCH_CWD.test(path);
    const key = project ? `project:${record.projectId}` : realDir && path !== null ? path.toLocaleLowerCase("en-US") : "__unassigned__";
    const name = project || realDir ? path?.split(/[\\/]/).pop() || "项目任务" : "非项目任务";
    const group = groups.get(key) ?? { key, name, path: project || realDir ? path : null, records: [] };
    group.records.push(record); groups.set(key, group);
  }
  return [...groups.values()];
}
