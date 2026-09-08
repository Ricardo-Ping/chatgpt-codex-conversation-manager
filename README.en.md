# Conversation Manager

Conversation Manager is a local desktop app for finding, filtering, archiving, restoring, and deleting ChatGPT conversations and Codex tasks. It does not render message bodies or replace the official clients; opening an item hands it to ChatGPT or `codex resume`.

## Features

- Separate ChatGPT and Codex tabs.
- Title, state, and age filters.
- Multi-select, select-current-results, archive, restore, and permanent delete.
- Protection for pinned/current chats and running Codex tasks.
- Minimal local index with instant cached display, incremental sync, and manual full calibration.
- GitHub Release update checks enabled by default.

## No duplicate sign-in

ChatGPT uses the companion Chrome/Edge extension and your existing browser session. Start the desktop app, load the unpacked extension provided with the Release, generate a six-digit pairing code, and enter it in the extension popup. Keep a signed-in `chatgpt.com` tab open. With no ChatGPT session, cached records remain readable but write operations are disabled.

Codex connects to the local documented [`codex app-server`](https://developers.openai.com/codex/app-server). It does not read or copy Codex credential or session files. If `codex` is not on PATH, select the local `codex.exe`, `codex.cmd`, or `codex.bat` in Settings.

## Privacy

The bridge binds only to `127.0.0.1`. Cookies, access tokens, raw account IDs, message bodies, and full API responses stay out of the desktop app. The local index contains only IDs, titles, timestamps, states, and safety flags.

## Development

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

See [README.md](README.md) for the default Chinese documentation and [the implementation plan](docs/conversation-manager-implementation-plan.md) for resumable progress.

## Current limits

`v0.2.0` supports Windows x64 with Chrome or Edge. The extension is distributed as a Release ZIP; macOS, Firefox, and direct access to the official ChatGPT desktop client's private session are not supported yet.

## License

MIT
