# Conversation Manager

> 中文版：[README.md](README.md)

![CI](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/actions/workflows/ci.yml/badge.svg)

Conversation Manager is a local desktop app for finding, filtering, organizing, and reading ChatGPT conversations and Codex tasks. Double-click any item to read its full content inside the app — with Markdown tables, syntax-highlighted code, and images — or hand it to ChatGPT / `codex resume` any time.

## Features

- A single sidebar for platform switching (ChatGPT / Codex), conversation states with count badges, and bridge / App Server connection indicators.
- In-app conversation reader: double-click a row to slide in a reading panel with Markdown tables, syntax-highlighted code in 18 languages, and images; copy the whole conversation or a single code block. The list stays interactive — double-click another row to switch content.
- Project management: ChatGPT “Work” and Codex tasks are grouped by project folder; right-click any conversation to move it into or out of a project, synced back to ChatGPT / Codex. Codex directory-grouped tasks can be moved to “Non-project tasks” and restored.
- ChatGPT distinguishes chat from project work: project conversations are hidden from the chat list by default and managed from the work view.
- Title, state, and age filters with sliding segmented controls.
- Click anywhere on a row to select, double-click to open the reader. Keyboard support: ↑↓ move, Space select, Enter open, `/` focus search, Ctrl/Cmd+A select all, Delete quick archive, Esc dismisses menus and panels.
- Multi-select batch archive, restore, and permanent delete with an in-app confirmation dialog; deletions above 20 items require typing the count.
- Protection for pinned/current chats and running Codex tasks.
- Minimal local index (including project membership) with instant cached display; the visible view checks incrementally every 2 minutes and performs a full calibration at least every 6 hours. Remote deletions are removed locally during full calibration, which can also be started immediately with “Full refresh.”
- Follows the system dark theme, or pin light/dark in Settings.
- Both builds check GitHub Releases automatically. Windows installs silently 5 seconds after download; macOS swaps the app bundle in place (unsigned-friendly); the portable build links to the download page.

## No duplicate sign-in

### ChatGPT

ChatGPT uses the companion Chrome/Edge extension and your existing browser session:

1. Install Conversation Manager from [GitHub Releases](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases).
2. Enable Developer Mode in the Chrome/Edge extension page and load the unpacked extension from the folder shown by "Open extension folder" in the app settings.
3. The extension pairs automatically once loaded — it reaches out to the desktop app in the background, no clicks required. The toolbar popup's "Connect desktop manager" button still works.
4. Keep a signed-in `chatgpt.com` tab open to read and manage conversations. After an extension upgrade, the bridge recovers an already-open tab automatically.
5. After a desktop app update, the extension negotiates versions with the desktop and reloads itself into the new build; manual reload from `chrome://extensions` is only needed as a fallback.

With no ChatGPT session, cached records remain readable but write operations are disabled.

### Codex

OpenAI's unified Windows desktop client runs as `ChatGPT.exe` and includes Codex. Conversation Manager automatically discovers its bundled [`codex app-server`](https://developers.openai.com/codex/app-server), without reading or copying credential or session files. The public App Server API supplies Codex tasks only; it does not expose ChatGPT cloud conversation management. Manual executable selection appears only as a fallback. Codex tasks are grouped into collapsible project folders by project ID first; scratch directories that the desktop client creates for unassigned sessions are recognized and pinned under "Non-project tasks" above all project folders. Project work conversations in ChatGPT stay out of the chat list and are available through the "Work" toggle.

## Privacy

The bridge binds only to `127.0.0.1`. Cookies, access tokens, raw account IDs, message bodies, and full API responses stay out of the desktop app. The local index contains only IDs, titles, timestamps, states, and safety flags.

SHA-256 digests only isolate caches for different accounts; they do not replace server validation. Periodic full calibration is what detects remote deletions.

## Development

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

Build the Windows installer and portable executables with `pnpm package:win`.

The app ships with English and Chinese UI. Switch it any time in Settings → Appearance; the choice is persisted and survives auto-updates.

See [README.md](README.md) for the default Chinese documentation and [the implementation plan](docs/conversation-manager-implementation-plan.md) for resumable progress.

## Current limits

`v0.7.1` supports Windows x64 and macOS (Apple Silicon), both with in-app auto-update. The extension is distributed as a Release ZIP; Firefox, and direct access to the official ChatGPT desktop client's private chat database are not supported yet.

## macOS installation (Apple Silicon)

> The macOS build is now a full release with in-app auto-update. It is still not signed/notarized with an Apple Developer certificate; Gatekeeper may block the first launch. This is expected. Both DMG and ZIP packages are provided — pick either.

### Option 1: DMG (recommended)

1. Download `Conversation-Manager-x.y.z-dmg-arm64.dmg` and open it.
2. Drag the app into your Applications folder.
3. First launch: right-click the app and choose "Open", or allow it in System Settings → Privacy & Security.

### Option 2: ZIP

Download `Conversation-Manager-x.y.z-mac-arm64.zip`, extract it, then right-click the app and choose "Open", or allow it in System Settings → Privacy & Security.

### Option 3: Command line (no Gatekeeper prompt)

Files downloaded with `curl` carry no quarantine flag and open directly:

```bash
curl -LO "https://github.com/Ricardo-Ping/chatgpt-codex-conversation-manager/releases/download/v0.7.1/Conversation-Manager-0.7.1-mac-arm64.zip"
```

- Load the companion browser extension and it auto-pairs within 30 seconds; `thread/read` export requires an open chatgpt.com tab.

## License

MIT
