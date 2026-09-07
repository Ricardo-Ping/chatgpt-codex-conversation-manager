import type { CodexThread, ThreadListResponse } from "@cgn/codex-app-server-adapter";

export interface UpdateState {
  phase: "unsupported" | "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  currentVersion: string;
  version: string | null;
  percent: number | null;
  message: string;
  autoUpdate: boolean;
  canAutoInstall: boolean;
}

declare global {
  interface Window {
    cgn: {
      setMode(mode: "chatgpt" | "codex" | "settings"): Promise<void>;
      appVersion(): Promise<string>;
      openExternal(url: string): Promise<void>;
      updates: {
        getState(): Promise<UpdateState>;
        setAutoUpdate(enabled: boolean): Promise<UpdateState>;
        check(): Promise<UpdateState>;
        install(): Promise<void>;
        openRelease(): Promise<void>;
        onState(callback: (state: UpdateState) => void): () => void;
      };
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
