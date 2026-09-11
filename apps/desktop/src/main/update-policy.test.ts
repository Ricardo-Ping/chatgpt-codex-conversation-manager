import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_AUTO_UPDATE, isUpdateInstallSafe, parseAutoUpdatePreference, supportsAutomaticInstallation } from "./update-policy.js";

describe("desktop update policy", () => {
  it("defaults to automatic checks and preserves an explicit opt-out", () => {
    expect(parseAutoUpdatePreference(undefined)).toBe(DEFAULT_AUTO_UPDATE);
    expect(parseAutoUpdatePreference(false)).toBe(false);
  });

  it("installs automatically only from a packaged Windows installer build", () => {
    expect(supportsAutomaticInstallation(true, "win32")).toBe(true);
    expect(supportsAutomaticInstallation(true, "win32", "CGN-portable.exe")).toBe(false);
    expect(supportsAutomaticInstallation(false, "win32")).toBe(false);
    expect(supportsAutomaticInstallation(true, "darwin")).toBe(false);
  });

  it("never installs an update while a batch mutation is running", () => {
    expect(isUpdateInstallSafe("downloaded", 0)).toBe(true);
    expect(isUpdateInstallSafe("downloaded", 1)).toBe(false);
    expect(isUpdateInstallSafe("downloading", 0)).toBe(false);
  });

  it("loads the CommonJS updater through its default export", async () => {
    const source = await readFile(new URL("./updater.ts", import.meta.url), "utf8");
    expect(source).toContain('import electronUpdater from "electron-updater";');
    expect(source).not.toMatch(/import\s*{[^}]*autoUpdater[^}]*}\s*from\s*["']electron-updater["']/);
  });

  it("installs downloaded updates silently so the NSIS wizard never appears", async () => {
    const source = await readFile(new URL("./updater.ts", import.meta.url), "utf8");
    expect(source).toContain("autoUpdater.quitAndInstall(true, true)");
    expect(source).not.toContain("autoUpdater.quitAndInstall(false");
  });
});
