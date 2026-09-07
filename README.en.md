# ChatGPT/Codex Conversation Navigator Desktop

[简体中文](README.md) | **English**

`CGN Desktop` is an independent Electron desktop client for navigating long ChatGPT conversations and managing local Codex tasks.

This repository is the desktop counterpart of [ChatGPT Conversation Navigator](https://github.com/Ricardo-Ping/chatgpt-conversation-navigator). The current preview vendors the browser extension runtime from upstream `v0.2.3` (`2b10a7d`) and injects it into an isolated ChatGPT web view. Codex task management uses the official [Codex App Server](https://developers.openai.com/codex/app-server).

## Features

- Embedded ChatGPT login in a persistent, isolated Electron session.
- ChatGPT scan, search, jump, collapse, node, branch, and conversation-management UI.
- Codex active/archived task list, task reading, search, fork, archive, restore, and safe deletion.
- ChatGPT extension settings and indexes stored inside the isolated Electron profile.
- GitHub Release update checks, enabled by default, plus a manual check in Settings.
- Context isolation, sandboxed renderers, origin-checked IPC, and external-link restrictions.

The ChatGPT history manager depends on ChatGPT's private web endpoints. It stops write operations when compatibility validation fails and never falls back to automated DOM deletion.

## Install

Download the recommended Windows installer from [GitHub Releases](https://github.com/Ricardo-Ping/chatgpt-codex-conversation-navigator-desktop/releases). Ordinary users do not need Node.js or pnpm. The Codex CLI is required only for Codex task features.

Unsigned preview builds may trigger Windows SmartScreen. The installed build checks GitHub Releases automatically, downloads compatible updates, and installs them when the app exits or when you choose “Restart and install”. Automatic checks can be disabled in Settings. The portable build checks for updates but requires a manual download from the Release page.

## Develop

Requirements: Node.js 22.12 or newer, pnpm 11, and Codex CLI for the Codex task view.

```bash
pnpm install
pnpm build
pnpm start
```

Validation and packaging:

```bash
pnpm typecheck
pnpm test
pnpm package:win
```

## Project layout

```text
apps/desktop/                     Electron main process and React UI
packages/conversation-domain/     Shared filtering and selection rules
packages/chatgpt-web-adapter/     ChatGPT runtime injection
packages/codex-app-server-adapter/ Codex JSON-RPC client
companion-plugin/                  Companion plugin metadata and MCP entrypoint
docs/                              Architecture and implementation plan
```

## Privacy

The app does not persist ChatGPT access tokens, duplicate ChatGPT cookies, read Codex `auth.json`, or upload conversation content. ChatGPT cookies stay in Electron's `persist:cgn-chatgpt` session. Codex authentication remains owned by the installed Codex CLI.

## Status

`v0.1.0-preview.3` is a technical preview. ChatGPT OAuth compatibility, macOS signing/notarization, companion-plugin installation, and destructive real-account smoke tests require separate verification before a stable release.
