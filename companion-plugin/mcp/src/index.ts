#!/usr/bin/env node
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CodexAppServer, type CodexThread } from "@conversation-manager/codex-app-server-adapter";
import { ConfirmationStore } from "./confirmation.js";

type Action = "archive" | "restore" | "delete";
const codex = new CodexAppServer();
const confirmations = new ConfirmationStore<Action>();
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

async function listAll(archived: boolean, searchTerm?: string): Promise<CodexThread[]> {
  const records: CodexThread[] = [];
  let cursor: string | null = null;
  do {
    const page = await codex.list({ archived, cursor, searchTerm: searchTerm || null });
    records.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function titles(records: CodexThread[], ids: string[]): Array<{ id: string; title: string; running: boolean }> {
  const byId = new Map(records.map((record) => [record.id, record]));
  return ids.map((id) => {
    const record = byId.get(id);
    return { id, title: record?.name || record?.preview || "Unknown task", running: record?.status?.type === "active" };
  });
}

function fingerprint(records: CodexThread[]): string {
  return records.map((record) => `${record.id}:${record.updatedAt}:${record.status?.type ?? "unknown"}`).sort().join("|");
}

const server = new McpServer({ name: "conversation-manager", version: "0.2.9" });

server.registerTool("desktop_status", {
  description: "Check whether the local Codex App Server is available.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
}, async () => {
  const page = await codex.list({ limit: 1 });
  return { content: [{ type: "text", text: `Codex App Server is available (${page.data.length ? "tasks found" : "no tasks"}).` }] };
});

server.registerTool("list_codex_conversations", {
  description: "List local Codex tasks by archive state and optional title search.",
  inputSchema: { archived: z.boolean().default(false), searchTerm: z.string().max(200).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
}, async ({ archived, searchTerm }) => {
  const records = await listAll(archived, searchTerm);
  return { content: [{ type: "text", text: JSON.stringify(records.map((record) => ({ id: record.id, title: record.name || record.preview, updatedAt: record.updatedAt, cwd: record.cwd, status: record.status?.type })), null, 2) }] };
});

server.registerTool("preview_batch_action", {
  description: "Preview an archive, restore, or permanent-delete action and issue a short-lived confirmation token.",
  inputSchema: { action: z.enum(["archive", "restore", "delete"]), ids: z.array(idSchema).min(1).max(500) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
}, async ({ action, ids }) => {
  const normalized = [...new Set(ids)].sort();
  const deletion = action === "delete" ? await codex.previewDelete(normalized) : null;
  const records = deletion?.records ?? await listAll(action === "restore");
  const preview = deletion
    ? records.map((record) => ({ id: record.id, title: record.name || record.preview || "Unknown task", running: record.status?.type === "active", derived: !normalized.includes(record.id) }))
    : titles(records, normalized);
  const found = new Set(records.map((record) => record.id));
  const missing = deletion?.missing ?? normalized.filter((id) => !found.has(id));
  const running = deletion?.running ?? preview.filter((task) => task.running).map((task) => task.id);
  const token = !missing.length && !running.length
    ? confirmations.issue(action, normalized, deletion?.fingerprint ?? fingerprint(records.filter((record) => normalized.includes(record.id))))
    : null;
  return { content: [{ type: "text", text: JSON.stringify({ action, count: preview.length, tasks: preview, missing, running, confirmationToken: token, expiresInSeconds: token ? 120 : 0, requiredConfirmationCount: preview.length > 20 ? preview.length : null, warning: action === "delete" ? "Permanent deletion includes every listed spawned descendant." : undefined }, null, 2) }] };
});

for (const [name, action, destructive] of [
  ["archive_codex_conversations", "archive", false],
  ["restore_codex_conversations", "restore", false],
  ["delete_codex_conversations", "delete", true]
] as const) {
  server.registerTool(name, {
    description: `${action} the exact Codex tasks approved by preview_batch_action.`,
    inputSchema: { ids: z.array(idSchema).min(1).max(500), confirmationToken: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: destructive, openWorldHint: false }
  }, async ({ ids, confirmationToken }) => {
    const expected = confirmations.consume(confirmationToken, action, ids);
    const normalized = [...new Set(ids)].sort();
    const deletion = action === "delete" ? await codex.previewDelete(normalized) : null;
    const current = deletion?.records ?? (await listAll(action === "restore")).filter((record) => normalized.includes(record.id));
    if (deletion?.missing.length || deletion?.running.length || current.some((record) => record.status?.type === "active") || fingerprint(current) !== expected.fingerprint) {
      throw new Error("Task state changed after preview. Run preview_batch_action again.");
    }
    const succeeded: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (const id of normalized) {
      try {
        if (action === "archive") await codex.archive(id);
        else if (action === "restore") await codex.unarchive(id);
        else await codex.delete(id);
        succeeded.push(id);
      } catch (error) {
        failed.push({ id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({ succeeded, failed }, null, 2) }] };
  });
}

server.registerTool("open_conversation_manager", {
  description: "Open the installed Conversation Manager application.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
}, async () => {
  const url = "conversation-manager://open";
  const child = process.platform === "win32"
    ? spawn("explorer.exe", [url], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
  return { content: [{ type: "text", text: "Requested Conversation Manager to open." }] };
});

await server.connect(new StdioServerTransport());
process.on("SIGINT", () => { codex.close(); process.exit(0); });
