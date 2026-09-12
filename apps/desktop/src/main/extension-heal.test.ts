import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLoadedBridgeExtensionPaths } from "./extension-heal.js";

async function seedProfile(userDataRoot: string, profile: string, extensionPath: string): Promise<void> {
  const prefs = {
    extensions: {
      settings: {
        "some-store-extension": { manifest: { name: "Other Extension" }, path: "abcdefgh/1.0_0" },
        "our-bridge": { manifest: { name: "Conversation Manager Bridge", version: "0.7.1" }, path: extensionPath }
      }
    }
  };
  await mkdir(join(userDataRoot, profile), { recursive: true });
  await writeFile(join(userDataRoot, profile, "Secure Preferences"), JSON.stringify(prefs));
}

describe("findLoadedBridgeExtensionPaths", () => {
  it("finds the loaded unpacked bridge extension across profiles", async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "cm-heal-"));
    const oldFolder = await mkdtemp(join(tmpdir(), "cm-old-ext-"));
    await writeFile(join(oldFolder, "manifest.json"), "{}");
    await seedProfile(userDataRoot, "Default", oldFolder);
    const paths = await findLoadedBridgeExtensionPaths([userDataRoot]);
    expect(paths).toEqual([oldFolder]);
  });

  it("ignores relative store paths and unrelated extensions", async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "cm-heal-"));
    const prefs = { extensions: { settings: { "x": { manifest: { name: "Conversation Manager Bridge" }, path: "relative/id" } } } };
    await mkdir(join(userDataRoot, "Profile 1"), { recursive: true });
    await writeFile(join(userDataRoot, "Profile 1", "Preferences"), JSON.stringify(prefs));
    expect(await findLoadedBridgeExtensionPaths([userDataRoot])).toEqual([]);
  });
});
