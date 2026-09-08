# Architecture

Conversation Manager has one local React renderer and two narrow providers.

- ChatGPT: a companion MV3 extension performs authenticated requests inside an already signed-in browser tab. A loopback-only HTTP bridge carries versioned commands and normalized summaries. Tokens, cookies and raw account IDs never cross the bridge.
- Codex: the Electron main process owns one `codex app-server --stdio` child process and uses documented thread list/archive/unarchive/delete methods. It never parses Codex auth or session files.

The renderer can only access allowlisted preload methods. Destructive actions are revalidated in the main process and require short-lived confirmation tokens. The JSON index is a display cache, not an authentication store or message archive.
