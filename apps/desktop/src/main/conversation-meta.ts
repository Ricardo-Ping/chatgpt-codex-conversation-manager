import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** ChatGPT 会话的本地元数据（标签 / 收藏）。只存在于本机，不影响云端任何数据。
 * favorites 为会话 ID 列表；tags 为「标签名 → 会话 ID 列表」。 */

export interface ConversationMeta { schemaVersion: 1; favorites: string[]; tags: Record<string, string[]> }

const MAX_FAVORITES = 5_000;
const MAX_TAGS = 100;
const MAX_IDS_PER_TAG = 2_000;

export function sanitizeConversationMeta(raw: unknown): ConversationMeta {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const idOk = (id: unknown): boolean => typeof id === "string" && id.length >= 1 && id.length <= 128;
  const favorites = Array.isArray(row.favorites)
    ? [...new Set(row.favorites.filter(idOk).map(String))].slice(0, MAX_FAVORITES)
    : [];
  const tags: Record<string, string[]> = {};
  if (row.tags && typeof row.tags === "object" && !Array.isArray(row.tags)) {
    for (const [name, ids] of Object.entries(row.tags as Record<string, unknown>).slice(0, MAX_TAGS)) {
      const clean = name.trim().slice(0, 60);
      if (!clean || !Array.isArray(ids)) continue;
      const list = [...new Set(ids.filter(idOk).map(String))].slice(0, MAX_IDS_PER_TAG);
      if (list.length) tags[clean] = list;
    }
  }
  return { schemaVersion: 1, favorites, tags };
}

export function emptyConversationMeta(): ConversationMeta { return { schemaVersion: 1, favorites: [], tags: {} }; }

export async function loadConversationMeta(file: string): Promise<ConversationMeta> {
  try { return sanitizeConversationMeta(JSON.parse(await readFile(file, "utf8"))); } catch { return emptyConversationMeta(); }
}

export async function saveConversationMeta(file: string, meta: ConversationMeta): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(meta)}\n`, "utf8");
  await rename(temp, file);
}
