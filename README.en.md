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

ChatGPT uses the companion Chrome/Edge extension and your existing browser session. Start the desktop app, load the unpacked extension provided with the Release, click its toolbar icon, then click “Connect desktop manager”. This one explicit click pairs the extension; subsequent connections are automatic. Keep a signed-in `chatgpt.com` tab open. With no ChatGPT session, cached records remain readable but write operations are disabled.

OpenAI's unified Windows desktop client runs as `ChatGPT.exe` and includes Codex. Conversation Manager automatically discovers its bundled [`codex app-server`](https://developers.openai.com/codex/app-server), without reading or copying credential or session files. Manual executable selection appears only as a fallback. ChatGPT cloud conversations still use the browser bridge; the app server supplies Codex tasks only.

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

`v0.2.1` supports Windows x64 with Chrome or Edge. The extension is distributed as a Release ZIP; macOS, Firefox, and direct access to the official ChatGPT desktop client's private chat database are not supported yet.

## License

MIT
