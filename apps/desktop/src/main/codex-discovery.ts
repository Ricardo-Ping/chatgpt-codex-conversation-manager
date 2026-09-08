import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MACOS_CODEX_CANDIDATES = (home: string): string[] => [
  "/Applications/ChatGPT.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex/bin/codex-aarch64-apple-darwin",
  "/Applications/ChatGPT.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex/bin/codex-x86_64-apple-darwin",
  "/Applications/ChatGPT.app/Contents/MacOS/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  join(home, ".codex", "bin", "codex")
];

export async function discoverCodexCommands(localAppData = process.env.LOCALAPPDATA, platform = process.platform): Promise<string[]> {
  const found: Array<{ path: string; mtime: number }> = [];
  if (platform === "win32" && localAppData) {
    for (const product of ["Codex", "ChatGPT"]) {
      const bin = join(localAppData, "OpenAI", product, "bin");
      try {
        for (const entry of await readdir(bin, { withFileTypes: true })) {
          const path = entry.isDirectory() ? join(bin, entry.name, "codex.exe") : entry.name.toLowerCase() === "codex.exe" ? join(bin, entry.name) : "";
          if (!path) continue;
          try { const info = await stat(path); if (info.isFile()) found.push({ path, mtime: info.mtimeMs }); } catch {}
        }
      } catch {}
    }
  }
  if (platform === "darwin") {
    for (const candidate of MACOS_CODEX_CANDIDATES(homedir())) {
      try { const info = await stat(candidate); if (info.isFile()) found.push({ path: candidate, mtime: info.mtimeMs }); } catch {}
    }
  }
  return [...new Set(found.sort((a, b) => b.mtime - a.mtime).map((item) => item.path))];
}
