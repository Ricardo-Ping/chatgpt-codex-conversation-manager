import type { ManagedConversation } from "@conversation-manager/conversation-domain";

export interface CodexConversationGroup { key: string; name: string; path: string | null; records: ManagedConversation[] }

export function groupCodexConversations(records: ManagedConversation[]): CodexConversationGroup[] {
  const groups = new Map<string, CodexConversationGroup>();
  for (const record of records) {
    const path = record.cwd?.trim().replace(/[\\/]+$/, "") || null;
    const key = path?.toLocaleLowerCase("en-US") || "__unassigned__";
    const group = groups.get(key) ?? { key, name: path?.split(/[\\/]/).pop() || "非项目任务", path, records: [] };
    group.records.push(record); groups.set(key, group);
  }
  return [...groups.values()];
}
