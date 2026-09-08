# Conversation Manager companion plugin

This optional local plugin exposes Codex task discovery and management through its repository-built MCP server.

The `.mcp.json` expects `conversation-manager-mcp` on `PATH` (`cgn-desktop-mcp` remains as a compatibility alias). This optional developer plugin is built from the repository and is not installed by the desktop installer.

Destructive tools require a fresh token from `preview_batch_action`. Tokens are one-time, expire after two minutes, and are bound to the action and exact sorted task IDs.
