# Conversation Manager companion plugin

This optional local plugin exposes **ChatGPT conversation management and Codex task discovery** through its repository-built MCP server, so any MCP client (Claude Code, Cline, Cursor, …) can search, read, and manage your local conversations.

The `.mcp.json` expects `conversation-manager-mcp` on `PATH` (`cgn-desktop-mcp` remains as a compatibility alias). This optional developer plugin is built from the repository and is not installed by the desktop installer.

## Tools

### Codex (direct App Server connection)

- `desktop_status` — App Server availability probe.
- `list_codex_conversations` — list local Codex tasks with optional title search.
- `preview_batch_action` / `archive_codex_conversations` / `restore_codex_conversations` / `delete_codex_conversations` — batch management with one-time confirmation tokens.
- `open_conversation_manager` — open the desktop app.

### ChatGPT (through the desktop app's local API)

- `chatgpt_status` — desktop pairing state, extension connectivity, synced accounts.
- `search_chatgpt_conversations` — title search over the local index; works without the browser running.
- `read_chatgpt_conversation` — full message content of one conversation (requires the browser extension online).
- `archive_chatgpt_conversations` / `restore_chatgpt_conversations` — non-destructive batch management.
- `export_chatgpt_conversations` — write conversations to a directory as Markdown (images localized).

ChatGPT tools require the desktop app to be running. On startup it writes
`~/.conversation-manager/mcp-endpoint.json` (port + secret, mode 0600); the MCP
server reads that file to authenticate against the loopback-only local API.

Destructive Codex tools require a fresh token from `preview_batch_action`. Tokens are one-time, expire after two minutes, and are bound to the action and exact sorted task IDs. ChatGPT deletion is intentionally not exposed over MCP; destructive actions stay in the desktop UI.
