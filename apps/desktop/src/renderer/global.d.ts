import type { CodexThread, ThreadListResponse } from "@cgn/codex-app-server-adapter";

declare global {
  interface Window {
    cgn: {
      setMode(mode: "chatgpt" | "codex" | "settings"): Promise<void>;
      appVersion(): Promise<string>;
      openExternal(url: string): Promise<void>;
      codex: {
        list(params: { cursor?: string | null; archived?: boolean; searchTerm?: string; full?: boolean }): Promise<ThreadListResponse>;
        read(threadId: string): Promise<{ thread: CodexThread }>;
        fork(threadId: string, lastTurnId?: string): Promise<{ thread: CodexThread }>;
        previewDelete(ids: string[]): Promise<{
          tasks: Array<{ id: string; title: string; derived: boolean }>;
          missing: string[];
          running: string[];
          confirmationToken: string | null;
        }>;
        runBatch(action: "archive" | "unarchive" | "delete", ids: string[], confirmationToken?: string): Promise<{
          succeeded: string[];
          failed: Array<{ id: string; message: string }>;
        }>;
      };
    };
  }
}

export {};
