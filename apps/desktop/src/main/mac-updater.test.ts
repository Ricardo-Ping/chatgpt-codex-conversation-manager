import { describe, expect, it } from "vitest";
import { extractChecksum, findChecksumAsset, findMacZipAsset, isNewerVersion, macAppBundlePath } from "./mac-updater.js";

describe("mac-updater", () => {
  it("compares release versions numerically", () => {
    expect(isNewerVersion("0.6.2", "0.6.1")).toBe(true);
    expect(isNewerVersion("v0.7.0", "0.6.1")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.6.1", "0.6.1")).toBe(false);
    expect(isNewerVersion("0.6.0", "0.6.1")).toBe(false);
    expect(isNewerVersion("0.7.0-beta.1", "0.6.1")).toBe(true);
  });

  it("derives the app bundle path from the executable path", () => {
    expect(macAppBundlePath("/Applications/Conversation Manager.app/Contents/MacOS/Conversation Manager")).toBe("/Applications/Conversation Manager.app");
    expect(macAppBundlePath("/Applications/Conversation Manager.app/Contents/MacOS/Conversation Manager Helper")).toBe("/Applications/Conversation Manager.app");
    expect(macAppBundlePath("/usr/local/bin/codex")).toBeNull();
  });

  it("picks the matching mac arm64 zip asset and checksum file", () => {
    const assets = [
      { name: "Conversation-Manager-0.7.0-mac-arm64.zip", browser_download_url: "https://example.com/mac.zip", size: 1024 },
      { name: "Conversation-Manager-0.7.0-setup-x64.exe", browser_download_url: "https://example.com/win.exe", size: 2048 },
      { name: "SHA256SUMS.txt", browser_download_url: "https://example.com/SHA256SUMS.txt", size: 128 }
    ];
    expect(findMacZipAsset(assets, "0.7.0")?.url).toBe("https://example.com/mac.zip");
    expect(findMacZipAsset(assets, "0.8.0")).toBeNull();
    expect(findChecksumAsset(assets)?.url).toBe("https://example.com/SHA256SUMS.txt");
    expect(findChecksumAsset([])).toBeNull();
  });

  it("extracts the checksum for the archive from SHA256SUMS.txt", () => {
    const sums = "aaa615bbb27966201b26d1da7e73a9a4f3e7d1a6f3c5b2a1d0e9f8a7b6c5d4e3  Conversation-Manager-0.7.0-mac-arm64.zip\nbbbb...  other.zip\n";
    expect(extractChecksum(sums, "Conversation-Manager-0.7.0-mac-arm64.zip")).toBe("aaa615bbb27966201b26d1da7e73a9a4f3e7d1a6f3c5b2a1d0e9f8a7b6c5d4e3");
    expect(extractChecksum(sums, "missing.zip")).toBeNull();
  });
});
