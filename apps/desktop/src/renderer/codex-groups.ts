import type { ManagedConversation } from "@conversation-manager/conversation-domain";

export interface CodexConversationGroup { key: string; name: string; path: string | null; records: ManagedConversation[] }

// Codex 桌面端为未挂到项目的会话自动创建临时目录（Documents\Codex\日期\标题），这类 cwd 不算项目
const SCRATCH_CWD = /[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}[\\/]/i;

export function isProjectTask(record: ManagedConversation, excludedIds?: ReadonlySet<string>): boolean {
  if (record.projectId) return true;
  if (excludedIds?.has(record.id)) return false;
  const cwd = record.cwd?.trim().replace(/[\\/]+$/, "") || null;
  if (!cwd) return false;
  return !SCRATCH_CWD.test(cwd);
}

// 会话是否被归入某个工作目录文件夹（非正式项目、非暂存目录）
export function isFolderGrouped(record: ManagedConversation): boolean {
  if (record.projectId) return false;
  const path = record.cwd?.trim().replace(/[\\/]+$/, "") || null;
  return path !== null && !SCRATCH_CWD.test(path);
}

export function groupCodexConversations(records: ManagedConversation[], excludedIds?: ReadonlySet<string>): CodexConversationGroup[] {
  const groups = new Map<string, CodexConversationGroup>();
  for (const record of records) {
    const path = record.cwd?.trim().replace(/[\\/]+$/, "") || null;
    const project = Boolean(record.projectId);
    const realDir = !excludedIds?.has(record.id) && path !== null && !SCRATCH_CWD.test(path);
    const key = project ? `project:${record.projectId}` : realDir && path !== null ? path.toLocaleLowerCase("en-US") : "__unassigned__";
    const name = project || realDir ? path?.split(/[\\/]/).pop() || "项目任务" : "非项目任务";
    const group = groups.get(key) ?? { key, name, path: project || realDir ? path : null, records: [] };
    group.records.push(record); groups.set(key, group);
  }
  const ordered = [...groups.values()];
  const unassigned = ordered.findIndex((group) => group.key === "__unassigned__");
  if (unassigned > 0) ordered.unshift(...ordered.splice(unassigned, 1));
  return ordered;
}

export function groupChatGptConversations(records: ManagedConversation[], names: Record<string, string> | undefined): CodexConversationGroup[] | null {
  if (!names || !Object.keys(names).length) return null;
  const groups = new Map<string, CodexConversationGroup>();
  for (const record of records) {
    if (!record.projectId) continue;
    const key = `project:${record.projectId}`;
    const group = groups.get(key) ?? { key, name: names[record.projectId] || record.projectId, path: null, records: [] };
    group.records.push(record); groups.set(key, group);
  }
  return groups.size ? [...groups.values()] : null;
}
