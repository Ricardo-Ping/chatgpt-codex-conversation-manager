# Architecture

CGN Desktop has two real provider adapters behind one small renderer-facing Interface:

- The ChatGPT adapter injects the tested browser-extension runtime into an isolated `WebContentsView`.
- The Codex adapter owns a single `codex app-server --stdio` process and hides JSON-RPC lifecycle, framing, request correlation, and shutdown.

The Electron main process is the security seam. Remote ChatGPT content cannot access Node.js, the filesystem, shell execution, or arbitrary IPC. The vendored MV3 extension retains its isolated world and stores its existing minimal index in the dedicated Electron profile through native `chrome.storage.local`.

The first preview deliberately keeps the upstream ChatGPT runtime intact. Refactoring its DOM, navigation, and storage adapters before the Electron login and injection path is proven would create two unverified implementations at once. The vendored source commit is recorded in `packages/chatgpt-web-adapter/vendor/UPSTREAM.md`.

Codex integration calls App Server methods rather than reading or changing Codex session files or credential data. Unsupported methods fail locally and do not disable unrelated capabilities.

Packaged builds read update metadata and installers only from this repository's GitHub Releases. Update checks run in the Electron main process; the renderer receives status through origin-checked IPC. Windows installer builds can download and install updates, while portable builds only open the Release page for manual replacement.
