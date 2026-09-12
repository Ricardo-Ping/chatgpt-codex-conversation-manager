#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CodexAppServer, threadFingerprint, type CodexThread } from "@conversation-manager/codex-app-server-adapter";
import { dedupeById } from "@conversation-manager/conversation-domain";
import { ConfirmationStore } from "./confirmation.js";

type Action = "archive" | "restore" | "delete";
const codex = new CodexAppServer();
const confirmations = new ConfirmationStore<Action>();
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

// ── ChatGPT 侧：通过桌面端本地 API 访问（端点描述文件由桌面端写入 ~/.conversation-manager/）
interface McpEndpoint { protocolVersion: number; port: number; secret: string | null; pid: number; version: string; updatedAt: string }
const endpointFile = process.env.CM_MCP_ENDPOINT_FILE || join(homedir(), ".conversation-manager", "mcp-endpoint.json");

async function loadEndpoint(): Promise<McpEndpoint> {
  const raw = JSON.parse(await readFile(endpointFile, "utf8")) as McpEndpoint;
  if (raw.protocolVersion !== 1 || typeof raw.port !== "number") throw new Error(`Invalid endpoint descriptor: ${endpointFile}`);
  return raw;
}

async function local<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const endpoint = await loadEndpoint().catch((error) => {
    throw new Error(`Conversation Manager desktop endpoint not found (${endpointFile}). Start the desktop app once so it writes the file. Original error: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!endpoint.secret) throw new Error("Conversation Manager is running but not paired yet. Load the browser extension and let it pair once, then retry.");
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/local`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload })
    });
  } catch (error) {
    throw new Error(`Conversation Manager desktop app is not reachable on port ${endpoint.port}. Is it running? (${error instanceof Error ? error.message : String(error)})`);
  }
  const body = await response.json() as { ok?: boolean; result?: T; error?: string };
  if (response.status === 401) throw new Error("Local API rejected the secret. Restart the desktop app so it rewrites the endpoint file.");
  if (!response.ok || body.ok === false) throw new Error(body.error || `local command failed with status ${response.status}`);
  return body.result as T;
}


async function listAll(archived: boolean, searchTerm?: string): Promise<CodexThread[]> {
  const records: CodexThread[] = [];
  let cursor: string | null = null;
  do {
    const page = await codex.list({ archived, cursor, searchTerm: searchTerm || null });
    records.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return dedupeById(records);
}

function titles(records: CodexThread[], ids: string[]): Array<{ id: string; title: string; running: boolean }> {
  const byId = new Map(records.map((record) => [record.id, record]));
  return ids.map((id) => {
    const record = byId.get(id);
    return { id, title: record?.name || record?.preview || "Unknown task", running: record?.status?.type === "active" };
  });
}

const server = new McpServer({ name: "conversation-manager", version: "0.7.5" });

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
    ? confirmations.issue(action, normalized, deletion?.fingerprint ?? threadFingerprint(records.filter((record) => normalized.includes(record.id))))
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
    if (deletion?.missing.length || deletion?.running.length || current.some((record) => record.status?.type === "active") || threadFingerprint(current) !== expected.fingerprint) {
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

const accountKeySchema = z.string().regex(/^[a-f0-9]{64}$/).optional();

server.registerTool("chatgpt_status", {
  description: "Check the Conversation Manager desktop app: pairing state, browser-extension connectivity, and synced ChatGPT accounts.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
}, async () => {
  const status = await local<{ paired: boolean; extensionConnected: boolean; version: string; accounts: Array<{ key: string; label: string }> }>("chatgpt.status");
  return { content: [{ type: "text", text: JSON.stringify({ desktopRunning: true, paired: status.paired, extensionConnected: status.extensionConnected, version: status.version, accounts: status.accounts }, null, 2) }] };
});

server.registerTool("search_chatgpt_conversations", {
  description: "Search locally indexed ChatGPT conversations by title (case-insensitive substring). Reads the desktop cache, works without the browser running.",
  inputSchema: { query: z.string().max(200).optional(), state: z.enum(["active", "archived", "scheduled", "all"]).default("all"), limit: z.number().int().min(1).max(100).default(20), accountKey: accountKeySchema },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
}, async ({ query, state, limit, accountKey }) => {
  const result = await local<{ total: number; rows: Array<{ id: string; accountKey: string; title: string; state: string; createdAt: number | null; updatedAt: number | null; projectId: string | null }> }>("chatgpt.search", { query: query ?? "", state: state === "all" ? null : state, limit, accountKey });
  return { content: [{ type: "text", text: JSON.stringify({ total: result.total, returning: result.rows.length, conversations: result.rows.map((row) => ({ id: row.id, accountKey: row.accountKey, title: row.title, state: row.state, updatedAt: row.updatedAt, projectId: row.projectId })) }, null, 2) }] };
});

server.registerTool("read_chatgpt_conversation", {
  description: "Read the full message content of one ChatGPT conversation. Requires the desktop app and the browser extension to be online.",
  inputSchema: { id: idSchema, accountKey: accountKeySchema },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
}, async ({ id, accountKey }) => {
  const data = await local<{ title: string; messages: Array<{ role: string; at: number | null; text: string }> }>("chatgpt.read", { id, accountKey });
  return { content: [{ type: "text", text: JSON.stringify({ title: data.title, messageCount: data.messages.length, messages: data.messages }, null, 2) }] };
});

for (const [name, action, destructive] of [
  ["archive_chatgpt_conversations", "archive", false],
  ["restore_chatgpt_conversations", "restore", false]
] as const) {
  server.registerTool(name, {
    description: `${action} ChatGPT conversations through the desktop app. Affects every account matched by the ids; requires the browser extension to be online.`,
    inputSchema: { ids: z.array(idSchema).min(1).max(500), accountKey: accountKeySchema },
    annotations: { readOnlyHint: false, destructiveHint: destructive, openWorldHint: false }
  }, async ({ ids, accountKey }) => {
    const result = await local<{ succeeded: string[]; failed: Array<{ id: string; message: string }>; unprocessed: string[] }>("chatgpt.batch", { action, ids, accountKey });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}

server.registerTool("export_chatgpt_conversations", {
  description: "Export ChatGPT conversations to a local directory as Markdown files (images are downloaded next to them). Requires the browser extension to be online.",
  inputSchema: { ids: z.array(idSchema).min(1).max(200), directory: z.string().min(1).max(500), accountKey: accountKeySchema },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, async ({ ids, directory, accountKey }) => {
  const result = await local<{ saved: number; failed: Array<{ id: string; message: string }>; directory: string }>("chatgpt.export", { ids, directory, accountKey });
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

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
