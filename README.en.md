# Conversation Manager

> 中文版：[README.md](README.md)

![CI](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/actions/workflows/ci.yml/badge.svg)

Conversation Manager is a **local desktop app for finding, filtering, organizing, and reading** your ChatGPT conversations and Codex tasks from one place — **without signing in again inside the app**.

Double-click any conversation to read its full content in-app, with Markdown tables, syntax-highlighted code in 18 languages, and images. You can also hand it back to the official web app any time, or open it directly in the ChatGPT/Codex desktop client to keep working.

## Features

### Find & Filter

- A single sidebar for platform switching (ChatGPT / Codex), conversation states with count badges (Active / Archived / Scheduled), and bridge / App Server connection indicators.
- Filter by title, state, and age (1 day / 1 week / 1 month / older than 6 months) with sliding segmented controls.
- Keyboard-first: `/` focuses search, `↑↓` move, `Space` selects, `Enter` opens, `Ctrl/Cmd+A` selects all, `Delete` quick-archives, `Esc` dismisses menus and panels step by step.

### Reading

- Double-click a row to slide in a reading panel: Markdown tables, syntax-highlighted code, and images; copy the whole conversation or a single code block. The list stays interactive — double-click another row to switch content.
- The reader supports previous / next navigation (`←` / `→`) and can open the original in the ChatGPT web app or desktop client.

### Organizing & Projects

- Multi-select batch archive, restore, and permanent delete, with an in-app preview confirmation dialog; deletions above 20 items require typing the count.
- Pinned chats, the current chat, and running Codex tasks are protected by default.
- Project management: ChatGPT “Work” and Codex tasks are grouped by project folder; right-click any conversation to move it into or out of a project, synced back to ChatGPT / Codex. Codex directory-grouped tasks can be moved to “Non-project tasks” and restored.
- ChatGPT distinguishes chat from project work: project conversations are hidden from the chat list by default and managed from the Work view.

### Cache & Sync

- Only a minimal local index (including project membership) is stored; cached records show instantly at startup. The visible view checks incrementally every 2 minutes and performs a full calibration at least every 6 hours; records deleted on the server are removed locally during full calibration.
- “Full refresh” in the toolbar starts an immediate calibration at any time.

### Export & Migration

- Export conversations to Markdown: ChatGPT exports download images into the export directory, organized per conversation and rewritten to local relative paths, so exports remain fully viewable offline; Codex task exports include the body and working-directory information.
- One-click zip export / import for Codex sessions (for migrating machines); credentials and config files are deliberately excluded.
- Settings provides data backup / restore (cache index and preferences) for moving to another device.

### Appearance & Updates

- Follows the system dark theme, or pin light/dark in Settings; the UI ships with English and Chinese and can be switched any time.
- Installed builds check for updates automatically and install silently 5 seconds after download, with no clicks required; the portable build checks and prompts for manual download. macOS uses a download-verified in-place swap for native upgrades, which also works for unsigned apps.

## No Duplicate Sign-in

### ChatGPT

ChatGPT reuses the signed-in state in your browser through the companion Chrome/Edge extension:

1. Download and install Conversation Manager from [GitHub Releases](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases).
2. Enable Developer Mode on the Chrome/Edge extensions page, choose “Load unpacked”, and select the folder shown by “Open extension folder” in the app settings.
3. The extension pairs automatically once loaded — it reaches out to the desktop app in the background, no clicks required. The toolbar popup’s “Connect desktop manager” button still works.
4. Keep a signed-in `chatgpt.com` tab open to read and manage conversations. After an extension upgrade, the bridge recovers an already-open tab automatically on first read — no manual reload needed.
5. After a desktop app update, the extension negotiates versions and reloads itself into the new build automatically; if anything goes wrong, reload it manually from `chrome://extensions` or use the extension-folder entry in Settings.

Without a signed-in ChatGPT session, cloud conversations cannot be read. When the bridge is disconnected, cached records remain readable but archive and delete are disabled.

### Codex

OpenAI’s Windows desktop client runs as `ChatGPT.exe` and offers both ChatGPT and Codex in one app, but its public `codex app-server` exposes Codex tasks only — it does not provide ChatGPT cloud chat lists or management. Conversation Manager automatically discovers and connects to this built-in backend: no second sign-in, and it never reads `auth.json`, session JSONL files, or state databases.

Manual selection of `codex.exe`, `codex.cmd`, or `codex.bat` appears in Settings only as a fallback when auto-detection fails. Codex tasks are grouped into collapsible project folders by project ID first; scratch directories that the desktop client creates for unassigned sessions are recognized and pinned under “Non-project tasks” above all project folders. ChatGPT project work stays out of the chat list and is available through the “Work” toggle.

Opening a Codex session from the app prefers the `codex://` deep link registered by the desktop client, to open it in the native client UI; if the client is not installed or the protocol is not registered, it falls back to `codex resume` in a terminal, and if that is unavailable too, copies the resume command to the clipboard.

## Privacy & Security

- The bridge binds only to `127.0.0.1`, reachable from this machine only.
- ChatGPT cookies, access tokens, and raw account IDs **never leave the browser extension**.
- The local index stores only IDs, titles, timestamps, states, and safety flags — **message bodies are not stored**.
- SHA-256 digests only isolate caches for different accounts; they do not replace server validation. Remote deletions are detected through periodic full calibration.
- Permanent delete requires a preview and a second confirmation; the cache is updated only after the server confirms success.
- ChatGPT conversation management relies on the web app’s internal endpoints. When those change, the app stops write operations rather than degrading to simulated clicks.

## How It Works (Brief)

- **ChatGPT**: the browser extension runs conversation requests inside your signed-in `chatgpt.com` page; the desktop app sends commands over a loopback HTTP bridge (`127.0.0.1:32147`, with a pairing secret and expiring commands). Cookies and tokens always stay in the browser.
- **Codex**: the desktop app auto-discovers and connects to the local `codex app-server` (stdio JSON-RPC) and manages tasks through the official API — no credential or session files are parsed.
- **Local index**: `conversation-index.json` holds metadata only (IDs, titles, timestamps, states, project membership) — a display cache, not an auth store or message archive.

Detailed architecture: [docs/architecture.md](docs/architecture.md).

## Development

Requires Node.js 22.12+ and pnpm 11:

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

Build the Windows installer and portable executables:

```powershell
pnpm package:win
```

Build the macOS package:

```powershell
pnpm package:mac
```

Resumable implementation progress: [docs/conversation-manager-implementation-plan.md](docs/conversation-manager-implementation-plan.md).

## macOS Installation (Apple Silicon)

> The macOS build is now a full release with in-app auto-update. It is still not signed/notarized with an Apple Developer certificate; Gatekeeper may block the first launch. This is expected. Both DMG and ZIP packages are provided — pick either.

### Option 1: DMG (recommended)

1. Download `Conversation-Manager-x.y.z-dmg-arm64.dmg` and open it.
2. Drag the app into your Applications folder.
3. First launch: right-click the app and choose “Open”, or allow it in System Settings → Privacy & Security.

### Option 2: ZIP

Download `Conversation-Manager-x.y.z-mac-arm64.zip`, extract it, then right-click the app and choose “Open”, or allow it in System Settings → Privacy & Security.

### Option 3: Command line (no Gatekeeper prompt)

Files downloaded with `curl` carry no quarantine flag and open directly:

```bash
curl -LO "https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases/download/v0.7.3/Conversation-Manager-0.7.3-mac-arm64.zip"
```

- Load the companion browser extension and it auto-pairs within 30 seconds; `thread/read` export requires an open chatgpt.com tab.

## Current Limits

- `v0.7.3` supports Windows x64 and macOS (Apple Silicon), both with in-app auto-update; the Windows portable build and macOS use a download-verified in-place swap because they are not signed.
- The companion extension is distributed as a Release ZIP; it is not yet on the browser stores.
- Firefox, and direct access to the ChatGPT desktop client's private chat database, are not supported yet.

## License

MIT
