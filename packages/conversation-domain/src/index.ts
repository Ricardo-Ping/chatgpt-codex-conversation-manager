export type ConversationSource = "chatgpt" | "codex";
export type ConversationState = "active" | "archived" | "scheduled";
export type ConversationCapability = "open" | "archive" | "restore" | "delete";

export interface ManagedConversation {
  source: ConversationSource;
  id: string;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
  state: ConversationState;
  projectId?: string;
  cwd?: string;
  preview?: string | null;
  pinned: boolean;
  running: boolean;
  current: boolean;
  capabilities: ConversationCapability[];
}

export type AgeFilter = "all" | "day" | "week" | "month" | "halfYear";

export interface ConversationFilter {
  state: ConversationState;
  query?: string;
  age?: AgeFilter;
  now?: number;
}

export function cutoffFor(age: AgeFilter, now = Date.now()): number | null {
  if (age === "all") return null;
  if (age === "day") return now - 24 * 60 * 60 * 1000;
  if (age === "week") return now - 7 * 24 * 60 * 60 * 1000;
  const date = new Date(now);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - (age === "month" ? 1 : 6));
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  return date.getTime();
}

export function filterConversations(records: ManagedConversation[], filter: ConversationFilter): ManagedConversation[] {
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const cutoff = cutoffFor(filter.age ?? "all", filter.now);

  return records.filter((record) => {
    if (record.state !== filter.state) return false;
    if (query) {
      const haystack = `${record.title}\n${record.preview ?? ""}`.toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return cutoff === null || (record.updatedAt !== null && record.updatedAt < cutoff);
  });
}

export function bulkSelectableIds(records: ManagedConversation[]): string[] {
  return records
    .filter((record) => !record.pinned && !record.current && !record.running && record.capabilities.some((value) => value === "archive" || value === "restore" || value === "delete"))
    .map((record) => record.id);
}

/** 按 id 去重（Map 语义）：重复 id 保留最后出现的值，位置保持在首次出现处；
 * 调用方如需按 updatedAt 排序请自行追加，本函数不做排序。 */
export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

/** 宽松的版本号格式校验：至少一个数字段、最多四段（1 / 1.2 / 1.2.3 / 1.2.3.4）。
 * 注意两点：① 不接受 "v" 前缀或 "-beta" 后缀——那类归一化属于 mac-updater 的
 * isNewerVersion 比较逻辑，与本函数无关；② 正则刻意不做末尾锚定（沿用旧内联检查
 * 的宽容行为，仅用于快速拒绝明显非法的版本串）。 */
export function isValidVersionFormat(value: unknown): value is string {
  return typeof value === "string" && /^\d+(\.\d+){0,3}/.test(value);
}
