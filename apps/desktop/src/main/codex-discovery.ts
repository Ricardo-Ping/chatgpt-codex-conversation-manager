import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

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
  return [...new Set(found.sort((a, b) => b.mtime - a.mtime).map((item) => item.path))];
}
