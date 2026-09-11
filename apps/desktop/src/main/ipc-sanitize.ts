import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import type { CachedConversation } from "@conversation-manager/chatgpt-bridge-server";
import { M } from "./language.js";
import { logWarn } from "./logger.js";

// IPC 入口的输入清洗与一次性确认令牌。窗口引用由 main 通过 initIpcWindow 注入，
// 避免与 main.ts 形成循环依赖。
let getWindow: () => BrowserWindow | null = () => null;
export function initIpcWindow(getMainWindow: () => BrowserWindow | null): void {
  getWindow = getMainWindow;
}

export function requireRenderer(event: IpcMainInvokeEvent): void { if (!getWindow() || event.sender !== getWindow()!.webContents) throw new Error("Untrusted IPC sender"); }
export function requireId(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new Error("Invalid conversation ID"); return value; }
export function requireAccount(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid account key"); return value; }
export function requireIds(value: unknown): string[] { if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new Error("Invalid selection"); return [...new Set(value.map(requireId))].sort(); }
export function requireState(value: unknown): CachedConversation["state"] { if (value !== "active" && value !== "archived" && value !== "scheduled") throw new Error("Invalid state"); return value; }

const confirmations = new Map<string, { source: "chatgpt" | "codex"; ids: string[]; fingerprint?: string; expiresAt: number }>();
export function validateConfirmation(source: "chatgpt" | "codex", ids: string[], value: unknown) { const token = typeof value === "string" ? value : ""; const confirmation = confirmations.get(token); confirmations.delete(token); if (!confirmation || confirmation.source !== source || confirmation.expiresAt < Date.now() || JSON.stringify(confirmation.ids) !== JSON.stringify(ids)) throw new Error(M().deleteConfirmationExpired); return confirmation; }
export function rememberConfirmation(source: "chatgpt" | "codex", ids: string[], fingerprint?: string): string { const now = Date.now(); for (const [token, entry] of confirmations) if (entry.expiresAt < now) confirmations.delete(token); const token = randomUUID(); confirmations.set(token, { source, ids, ...(fingerprint ? { fingerprint } : {}), expiresAt: now + 120_000 }); return token; }

const warnedMalformedIds = new Set<string>();
export function sanitizeAccounts(value: unknown) { const input = value && typeof value === "object" ? value as { accounts?: unknown } : {}; if (!Array.isArray(input.accounts) || input.accounts.length > 100) throw new Error(M().invalidAccountList); const out: Array<{ key: string; label: string; isDefault: boolean }> = []; for (const item of input.accounts) { const row = item && typeof item === "object" ? item as Record<string, unknown> : {}; try { out.push({ key: requireAccount(row.key), label: typeof row.label === "string" ? row.label.slice(0, 100) : "ChatGPT", isDefault: row.isDefault === true }); } catch {} } if (!out.length && input.accounts.length) throw new Error(M().unrecognizedAccountList); return { accounts: out }; }
export function sanitizeProjects(value: unknown): Record<string, string> {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(input).slice(0, 300)) {
    if (!id.startsWith("g-p-") || id.length > 128) continue;
    if (typeof name === "string" && name.trim()) out[id] = name.trim().slice(0, 100);
  }
  return out;
}
export function sanitizeRecords(value: unknown, state: CachedConversation["state"]): CachedConversation[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error(M().invalidConversationList);
  const out: CachedConversation[] = []; let skipped = 0; let sample = "";
  for (const item of value) {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const number = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : null;
    try {
      out.push({ id: requireId(row.id), title: typeof row.title === "string" ? row.title.slice(0, 500) : M().unnamedConversation, createdAt: number(row.createdAt), updatedAt: number(row.updatedAt), state, ...(typeof row.projectId === "string" && row.projectId.length <= 128 ? { projectId: row.projectId } : {}), pinned: row.pinned === true, current: row.current === true, automation: state === "scheduled" });
    } catch {
      skipped += 1;
      if (!sample && typeof row.id === "string") sample = `${row.id.slice(0, 12)}…(len ${row.id.length})`;
    }
  }
  if (!out.length && value.length) throw new Error(M().unrecognizedConversations(value.length));
  if (skipped && !warnedMalformedIds.has(sample)) { warnedMalformedIds.add(sample); logWarn(`[chatgpt-bridge] skipped ${skipped} malformed conversation rows, sample id: ${sample || "unknown"}`); }
  return out;
}
