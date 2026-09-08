import type { CachedConversation, PairingState } from "@conversation-manager/chatgpt-bridge-server";
import type { ThreadListResponse } from "@conversation-manager/codex-app-server-adapter";

export type ThemePreference = "system" | "light" | "dark";
export interface UpdateState { phase: "unsupported" | "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"; currentVersion: string; version: string | null; percent: number | null; message: string; autoUpdate: boolean; canAutoInstall: boolean }
export interface CacheSnapshot { syncedAt: number; fullSyncedAt: number | null; records: CachedConversation[]; syncMode?: "full" | "incremental" }
export interface BatchResult { succeeded: string[]; failed: Array<{ id: string; message: string }>; unprocessed?: string[] }

declare global {
  interface Window { conversationManager: {
    appVersion(): Promise<string>;
    openExternal(url: string): Promise<void>;
    dialog: { pickDirectory(): Promise<{ directory: string | null }> };
    chatgpt: {
      state(): Promise<PairingState>; beginPairing(): Promise<PairingState>; clearPairing(): Promise<PairingState>; openChatGpt(): Promise<void>; openConversation(id: string): Promise<void>; showExtension(): Promise<string>;
      accounts(): Promise<{ accounts: Array<{ key: string; label: string; isDefault: boolean }> }>;
      cachedAccounts(): Promise<{ accounts: Array<{ key: string; label: string; isDefault: boolean }> }>;
      cached(accountKey: string, state: CachedConversation["state"]): Promise<CacheSnapshot | null>;
      list(accountKey: string, label: string, state: CachedConversation["state"], full: boolean): Promise<CacheSnapshot | null>;
      previewDelete(ids: string[]): Promise<{ confirmationToken: string }>;
      runBatch(accountKey: string, action: "archive" | "restore" | "delete", ids: string[], confirmationToken?: string): Promise<BatchResult>;
      cancel(): Promise<{ cancelled: boolean }>;
      cacheStats(): Promise<{ accounts: number; records: number; bytes: number; lastSyncedAt: number | null; lastFullSyncedAt: number | null }>;
      clearCache(): Promise<{ accounts: number; records: number; bytes: number; lastSyncedAt: number | null; lastFullSyncedAt: number | null }>;
      exportSessions(payload: { accountKey: string; directory: string; items: Array<{ id: string; title: string }> }): Promise<{ saved: number; failed: Array<{ id: string; message: string }>; directory: string }>;
    };
    codex: {
      status(): Promise<{ available: boolean; message: string; command: string }>;
      selectCommand(): Promise<{ selected: boolean; command: string }>;
      list(params: { cursor?: string | null; archived?: boolean; searchTerm?: string; full?: boolean }): Promise<ThreadListResponse>;
      open(threadId: string): Promise<{ opened: boolean; copied?: boolean }>;
      previewDelete(ids: string[]): Promise<{ tasks: Array<{ id: string; title: string; derived: boolean }>; missing: string[]; running: string[]; confirmationToken: string | null }>;
      runBatch(action: "archive" | "unarchive" | "delete", ids: string[], confirmationToken?: string): Promise<BatchResult>;
      exportSessions(payload: { directory: string; items: Array<{ id: string; title: string; preview: string; cwd: string | null }> }): Promise<{ saved: number; failed: Array<{ id: string; message: string }>; directory: string }>;
    };
    logs: { read(): Promise<string>; clear(): Promise<boolean>; save(): Promise<{ saved: boolean; path?: string }>; onLine(callback: (line: string) => void): () => void };
    theme: { get(): Promise<ThemePreference>; set(value: ThemePreference): Promise<ThemePreference> };
    updates: { getState(): Promise<UpdateState>; setAutoUpdate(enabled: boolean): Promise<UpdateState>; check(): Promise<UpdateState>; install(): Promise<void>; openRelease(): Promise<void>; onState(callback: (state: UpdateState) => void): () => void };
  }; }
}
