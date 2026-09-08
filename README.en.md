# Conversation Manager

Conversation Manager is a local desktop app for finding, filtering, archiving, restoring, and deleting ChatGPT conversations and Codex tasks. It does not render message bodies or replace the official clients; opening an item hands it to ChatGPT or `codex resume`.

## Features

- A single sidebar for platform switching (ChatGPT / Codex), conversation states with count badges, and bridge / App Server connection indicators.
- ChatGPT distinguishes chat from project work: project conversations are hidden from the chat list by default and managed from the Codex workspace; a "Work" toggle reveals them when needed.
- Title, state, and age filters with sliding segmented controls.
- Click anywhere on a row to select, double-click to open. Keyboard support: ↑↓ move, Space select, Enter open, `/` focus search, Ctrl/Cmd+A select all, Delete quick archive, Esc clear.
- Multi-select batch archive, restore, and permanent delete with an in-app confirmation dialog; deletions above 20 items require typing the count.
- Protection for pinned/current chats and running Codex tasks.
- Minimal local index with instant cached display, incremental sync, and manual full calibration; sync completion reports the number of conversations.
- Follows the system dark theme, or pin light/dark in Settings.
- The installer build checks GitHub Releases automatically and installs updates silently 5 seconds after download; the portable build checks and links to the download page.

## No duplicate sign-in

### ChatGPT

ChatGPT uses the companion Chrome/Edge extension and your existing browser session:

1. Install Conversation Manager from [GitHub Releases](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases).
2. Enable Developer Mode in the Chrome/Edge extension page and load the unpacked extension from the folder shown by "Open extension folder" in the app settings.
3. The extension pairs automatically once loaded — it reaches out to the desktop app in the background, no clicks required. The toolbar popup's "Connect desktop manager" button still works.
4. Keep a signed-in `chatgpt.com` tab open to read and manage conversations. After an extension upgrade, the bridge recovers an already-open tab automatically.
5. After a desktop app update, reload the extension; the sidebar shows an amber "reload needed" hint on version mismatch.

With no ChatGPT session, cached records remain readable but write operations are disabled.

### Codex

OpenAI's unified Windows desktop client runs as `ChatGPT.exe` and includes Codex. Conversation Manager automatically discovers its bundled [`codex app-server`](https://developers.openai.com/codex/app-server), without reading or copying credential or session files. The public App Server API supplies Codex tasks only; it does not expose ChatGPT cloud conversation management. Manual executable selection appears only as a fallback. Codex tasks are grouped into collapsible project folders by project ID first; scratch directories that the desktop client creates for unassigned sessions are recognized and pinned under "Non-project tasks" above all project folders. Project work conversations in ChatGPT stay out of the chat list and are available through the "Work" toggle.

## Privacy

The bridge binds only to `127.0.0.1`. Cookies, access tokens, raw account IDs, message bodies, and full API responses stay out of the desktop app. The local index contains only IDs, titles, timestamps, states, and safety flags.

## Development

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

Build the Windows installer and portable executables with `pnpm package:win`.

See [README.md](README.md) for the default Chinese documentation and [the implementation plan](docs/conversation-manager-implementation-plan.md) for resumable progress.

## Current limits

`v0.2.8` supports Windows x64 with Chrome or Edge. The extension is distributed as a Release ZIP; macOS, Firefox, and direct access to the official ChatGPT desktop client's private chat database are not supported yet.

## License

MIT
