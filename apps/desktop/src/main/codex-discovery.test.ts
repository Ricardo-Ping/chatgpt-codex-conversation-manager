import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodexCommands } from "./codex-discovery.js";

describe("discoverCodexCommands", () => {
  it("prefers the newest bundled Codex executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "cm-codex-"));
    const oldPath = join(root, "OpenAI", "Codex", "bin", "old", "codex.exe");
    const newPath = join(root, "OpenAI", "Codex", "bin", "new", "codex.exe");
    await mkdir(join(oldPath, ".."), { recursive: true }); await mkdir(join(newPath, ".."), { recursive: true });
    await writeFile(oldPath, "old"); await writeFile(newPath, "new");
    await utimes(oldPath, new Date(1_000), new Date(1_000)); await utimes(newPath, new Date(2_000), new Date(2_000));
    expect(await discoverCodexCommands(root, "win32")).toEqual([newPath, oldPath]);
  });
});
