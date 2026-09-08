# Conversation Manager companion plugin

This local plugin exposes Codex task discovery and management through the MCP server installed with Conversation Manager.

The preview `.mcp.json` expects `conversation-manager-mcp` on `PATH` (`cgn-desktop-mcp` remains as a compatibility alias). During repository development, run the MCP package with pnpm instead. The Windows installer integration is not yet complete.

Destructive tools require a fresh token from `preview_batch_action`. Tokens are one-time, expire after two minutes, and are bound to the action and exact sorted task IDs.
