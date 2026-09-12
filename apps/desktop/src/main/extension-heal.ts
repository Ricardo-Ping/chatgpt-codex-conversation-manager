import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { syncExtensionFiles } from "./extension-sync.js";

export const BRIDGE_EXTENSION_NAME = "Conversation Manager Bridge";

interface ExtensionSettingsEntry { manifest?: { name?: unknown; version?: unknown }; path?: unknown }

// 自愈：找到各 Chromium 浏览器（Chrome/Edge）实际加载的本扩展目录（unpacked 装载
// 时 path 为绝对路径），把最新扩展文件直接同步进去。这样既有安装无需人工切换目录，
// 扩展轮询到更新的期望版本后 chrome.runtime.reload() 就能读到新代码。
export async function findLoadedBridgeExtensionPaths(userDataSourceDirs: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const userDataDir of userDataSourceDirs) {
    let profiles: string[];
    try {
      profiles = (await readdir(userDataDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(userDataDir, entry.name));
    } catch { continue; }
    for (const profile of profiles) {
      for (const fileName of ["Secure Preferences", "Preferences"]) {
        let data: { extensions?: { settings?: Record<string, ExtensionSettingsEntry> } } | undefined;
        try { data = JSON.parse(await readFile(join(profile, fileName), "utf8")); } catch { continue; }
        const settings = data?.extensions?.settings;
        if (!settings || typeof settings !== "object") continue;
        for (const entry of Object.values(settings)) {
          const name = entry?.manifest?.name;
          const path = typeof entry?.path === "string" ? entry.path : "";
          // unpacked 扩展的 path 是绝对路径；商店扩展是相对 ID 目录，直接跳过
          if (name !== BRIDGE_EXTENSION_NAME || !path || !isAbsolute(path)) continue;
          if (!existsSync(join(path, "manifest.json"))) continue;
          if (!found.includes(path)) found.push(path);
        }
      }
    }
  }
  return found;
}

export async function healLoadedExtensionFolders(bundledDir: string, userDataSourceDirs: string[]): Promise<string[]> {
  const loaded = await findLoadedBridgeExtensionPaths(userDataSourceDirs);
  const healed: string[] = [];
  for (const path of loaded) {
    try { await syncExtensionFiles(bundledDir, path); healed.push(path); } catch {}
  }
  return healed;
}
