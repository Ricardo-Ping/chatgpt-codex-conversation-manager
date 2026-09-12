import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncExtensionFiles } from "./extension-sync.js";

const FILES = ["manifest.json", "background.js", "popup.html"];

async function seedSource(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "cm-ext-src-"));
  await writeFile(join(source, "manifest.json"), '{"version":"0.7.2"}');
  await writeFile(join(source, "background.js"), "// background");
  await writeFile(join(source, "popup.html"), "<p>popup</p>");
  return source;
}

describe("syncExtensionFiles", () => {
  it("copies bundled extension files into the stable directory", async () => {
    const source = await seedSource();
    const target = await mkdtemp(join(tmpdir(), "cm-ext-dst-"));
    const synced = await syncExtensionFiles(source, target, FILES);
    expect(synced.targetDir).toBe(target);
    expect(synced.skipped).toEqual([]);
    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe('{"version":"0.7.2"}');
    expect(await readFile(join(target, "background.js"), "utf8")).toBe("// background");
  });

  it("skips writing unchanged files so Chrome file watchers stay quiet", async () => {
    const source = await seedSource();
    const target = await mkdtemp(join(tmpdir(), "cm-ext-dst-"));
    await syncExtensionFiles(source, target, FILES);
    const manifest = join(target, "manifest.json");
    const before = (await stat(manifest)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await syncExtensionFiles(source, target, FILES);
    expect(second.skipped).toEqual([]);
    expect((await stat(manifest)).mtimeMs).toBe(before);
  });

  it("updates the target when the source version changes", async () => {
    const source = await seedSource();
    const target = await mkdtemp(join(tmpdir(), "cm-ext-dst-"));
    await syncExtensionFiles(source, target, FILES);
    await writeFile(join(source, "manifest.json"), '{"version":"0.7.4"}');
    await syncExtensionFiles(source, target, FILES);
    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe('{"version":"0.7.4"}');
  });
});
