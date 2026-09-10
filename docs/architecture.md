# Architecture

Conversation Manager is an Electron desktop app with three cooperating processes: a sandboxed React renderer, the Electron main process, and a companion MV3 browser extension. A `codex app-server --stdio` child process supplies Codex tasks.

## ChatGPT bridge

ChatGPT has no public management API, so the companion extension performs authenticated requests inside an already signed-in `chatgpt.com` tab. A loopback-only HTTP bridge (`127.0.0.1:32147`) carries versioned commands (`status`, `accounts`, `list`, `read`, `batch`, `cancel`, `projects`) between the main process and the extension. Tokens, cookies, and raw account IDs never cross the bridge.

- Pairing is automatic: the extension calls `/v1/pair/auto` (extension-origin checked) whenever it has no secret; there is no manual pairing-code flow.
- The extension long-polls `/v1/commands` and relays jobs to the tab. Slow read commands (`list`, `read`) run on a serialized relay lane to avoid concurrent-request races; short commands (`batch`, `cancel`, `status`, `projects`) run on a fast lane so mutations are never blocked by a long sync.
- Every response carries `X-Expected-Extension-Version` (the version bundled with the desktop app). When the extension sees a newer expected version and no commands are in flight, it calls `chrome.runtime.reload()` and re-reads the updated files from disk — extension upgrades follow desktop upgrades without manual reloads. A per-target-version guard prevents reload loops.
- Conversation reads return normalized `{role, at, text}` messages. Image asset pointers (`file-service://`) are resolved through the files download endpoint and embedded as markdown images.

## Codex adapter

The Electron main process owns one `codex app-server --stdio` child and speaks its JSON-RPC protocol: `thread/list`, `thread/read`, `thread/archive`, `thread/unarchive`, `thread/delete`, and `thread/name/set`. It initializes with the `experimentalApi` capability to also use `project/list` and `thread/metadata/update` (assign/clear a thread's project). It never parses Codex auth or session files.

## Project model

ChatGPT projects (`g-p-*` ids) are discovered from the gizmo sidebar during sync and stored per account in the local index; conversations carry `project_id`. Codex threads may carry an explicit `projectId`; threads without one are grouped by working directory (scratch directories under `Documents/Codex/<date>/` are treated as non-project). The renderer groups both workspaces into collapsible folders and supports moving conversations into/out of projects — ChatGPT through `PATCH /backend-api/conversation/{id}` (`project_id`), Codex through `thread/metadata/update`. Codex directory-grouped tasks can also be visually moved to "Non-project tasks" via a local, persisted exclusion list (the App Server cannot change a thread's working directory).

## Conversation viewer

Double-clicking a row loads the full conversation on demand — the bridge `read` command for ChatGPT, `thread/read` for Codex — and renders it in a docking side panel. Message text is parsed with `marked`, sanitized with DOMPurify, and code blocks are highlighted with highlight.js. The app window blocks in-page navigation (`will-navigate`, `setWindowOpenHandler`) and hands http(s) links to the system browser, so rendered links can never navigate the app away.

## Local cache

The JSON index is a display cache, not an authentication store or message archive: per account it keeps per-state conversation snapshots (ids, titles, timestamps, states, project ids) and the account's project name map. Batch results are applied optimistically (`apply`, `applyProjectMove`) so the UI reflects mutations before the next sync, and periodic full calibration replaces stale snapshots with server truth.

## Auto-update

- Windows: electron-updater with the GitHub Releases provider (NSIS silent install; portable builds link to the download page).
- macOS: a self-replacing updater for unsigned builds. It checks the GitHub Releases API, downloads the arm64 zip, verifies it against `SHA256SUMS.txt`, extracts the bundle next to the installed app, atomically swaps the old bundle with a rollback backup, then relaunches. In-app downloads carry no quarantine attribute, so Gatekeeper is not involved; a leftover backup is cleaned up on the next launch.

## Security boundaries

The renderer can only access allowlisted preload methods, and every IPC handler validates its sender and inputs. Destructive actions are revalidated in the main process and require short-lived confirmation tokens. Rendered conversation content is sanitized with DOMPurify, and the window blocks both in-page navigation and popup creation, forwarding http(s) links to the system browser. The JSON index is a display cache, not an authentication store or message archive.
