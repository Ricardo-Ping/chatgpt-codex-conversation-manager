import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_AUTO_UPDATE, parseAutoUpdatePreference, supportsAutomaticInstallation } from "./update-policy.js";

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

  it("loads the CommonJS updater through its default export", async () => {
    const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
    expect(source).toContain('import electronUpdater from "electron-updater";');
    expect(source).not.toMatch(/import\s*{[^}]*autoUpdater[^}]*}\s*from\s*["']electron-updater["']/);
  });
});
