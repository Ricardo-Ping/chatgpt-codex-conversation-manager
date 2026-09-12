import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionCodeHash, classifyExtensionStaleness, shouldDemandReload, HASH_UNAVAILABLE } from "./extension-integrity.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function writeExtensionFiles(directory: string, background = "// background v1"): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "background.js"), background);
  await writeFile(join(directory, "bridge-core.js"), "// core v1");
  await writeFile(join(directory, "content.js"), "// content v1");
}

function referenceHash(contents: Array<string>): string {
  const digests = contents.map((content) => createHash("sha256").update(content).digest());
  return createHash("sha256").update(Buffer.concat(digests)).digest("base64url");
}

describe("extensionCodeHash", () => {
  it("matches the documented double-digest construction over the three code files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-hash-")); directories.push(dir);
    await writeExtensionFiles(dir);
    await expect(extensionCodeHash(dir)).resolves.toBe(referenceHash(["// background v1", "// core v1", "// content v1"]));
  });

  it("changes when any code file changes, independent of the manifest version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-hash-")); directories.push(dir);
    await writeExtensionFiles(dir);
    const before = await extensionCodeHash(dir);
    await writeExtensionFiles(dir, "// background v2 (same version number, patched content)");
    const after = await extensionCodeHash(dir);
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it("returns null when a code file is unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cm-hash-")); directories.push(dir);
    await writeExtensionFiles(dir);
    await rm(join(dir, "content.js"));
    await expect(extensionCodeHash(dir)).resolves.toBeNull();
    await expect(extensionCodeHash(join(dir, "missing"))).resolves.toBeNull();
  });
});

describe("classifyExtensionStaleness", () => {
  const diskHash = referenceHash(["a", "b", "c"]);
  const otherHash = referenceHash(["x", "y", "z"]);

  it("treats matching hashes as fresh regardless of versions", () => {
    expect(classifyExtensionStaleness({ expectedVersion: "0.7.4", reportedVersion: "0.7.4", reportedCodeHash: diskHash, expectedCodeHash: diskHash })).toBe("fresh");
    expect(classifyExtensionStaleness({ expectedVersion: "0.7.4", reportedVersion: "0.7.3", reportedCodeHash: diskHash, expectedCodeHash: diskHash })).toBe("fresh");
  });

  it("flags same-version content drift as stale-hash — the case version checks cannot see", () => {
    expect(classifyExtensionStaleness({ expectedVersion: "0.7.4", reportedVersion: "0.7.4", reportedCodeHash: otherHash, expectedCodeHash: diskHash })).toBe("stale-hash");
  });

  it("flags a version-lagging extension as stale-version", () => {
    expect(classifyExtensionStaleness({ expectedVersion: "0.7.4", reportedVersion: "0.7.3", reportedCodeHash: null, expectedCodeHash: diskHash })).toBe("stale-version");
  });

  it("treats a missing hash header as a legacy build that predates the feature", () => {
    expect(classifyExtensionStaleness({ expectedVersion: "0.7.4", reportedVersion: "0.7.4", reportedCodeHash: null, expectedCodeHash: diskHash })).toBe("unknown-legacy");
    expect(classifyExtensionStaleness({ expectedVersion: null, reportedVersion: null, reportedCodeHash: null, expectedCodeHash: null })).toBe("unknown-legacy");
  });

  it("stays unknown when the extension reports a failed hash computation", () => {
    expect(classifyExtensionStaleness({ expectedVersion: "0.7.4", reportedVersion: "0.7.4", reportedCodeHash: HASH_UNAVAILABLE, expectedCodeHash: diskHash })).toBe("unknown");
  });

  it("only demands a reload for provable or strongly suspected staleness", () => {
    expect(shouldDemandReload("stale-hash")).toBe(true);
    expect(shouldDemandReload("stale-version")).toBe(true);
    expect(shouldDemandReload("unknown-legacy")).toBe(true);
    expect(shouldDemandReload("fresh")).toBe(false);
    expect(shouldDemandReload("unknown")).toBe(false);
  });
});
