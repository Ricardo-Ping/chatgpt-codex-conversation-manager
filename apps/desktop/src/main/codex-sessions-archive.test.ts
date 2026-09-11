import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionsArchive, extractSessionsArchive, safeArchiveEntry } from "./codex-sessions-archive.js";

async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "cm-sessions-"));
  const day = join(home, "sessions", "2026", "09", "11");
  await mkdir(day, { recursive: true });
  await writeFile(join(day, "rollout-2026-09-11T10-00-00-01a08bf3-5bc7-7b91-8219-b32c9d37b1d4.jsonl"), '{"session":"a"}\n');
  await writeFile(join(day, "notes.txt"), "not a session file");
  const archived = join(home, "archived_sessions", "2026", "09");
  await mkdir(archived, { recursive: true });
  await writeFile(join(archived, "rollout-old-01a089d6-04b6-79e1-8d88-70de61b66cf3.jsonl"), '{"session":"old"}\n');
  return home;
}

describe("safeArchiveEntry", () => {
  it("accepts whitelisted jsonl paths", () => {
    expect(safeArchiveEntry("sessions/2026/09/11/rollout-a.jsonl")).toBe("sessions/2026/09/11/rollout-a.jsonl");
    expect(safeArchiveEntry("archived_sessions/rollout-b.jsonl")).toBe("archived_sessions/rollout-b.jsonl");
  });

  it("rejects path traversal, absolute paths and non-session entries", () => {
    expect(safeArchiveEntry("../auth.json")).toBeNull();
    expect(safeArchiveEntry("sessions/../../auth.json")).toBeNull();
    expect(safeArchiveEntry("/etc/passwd")).toBeNull();
    expect(safeArchiveEntry("auth.json")).toBeNull();
    expect(safeArchiveEntry("sessions/config.toml")).toBeNull();
  });
});

describe("buildSessionsArchive / extractSessionsArchive", () => {
  it("round-trips sessions and archived_sessions, skipping non-jsonl files", async () => {
    const home = await seedHome();
    const { zip, count, bytes } = await buildSessionsArchive(home);
    expect(count).toBe(2);
    expect(bytes).toBeGreaterThan(0);
    expect(zip.byteLength).toBeGreaterThan(0);

    const target = await mkdtemp(join(tmpdir(), "cm-target-"));
    const result = await extractSessionsArchive(zip, target);
    expect(result).toEqual({ imported: 2, skipped: 0 });
    expect(await readFile(join(target, "sessions", "2026", "09", "11", "rollout-2026-09-11T10-00-00-01a08bf3-5bc7-7b91-8219-b32c9d37b1d4.jsonl"), "utf8")).toBe('{"session":"a"}\n');
    const dayDir = await readdir(join(target, "sessions", "2026", "09", "11"));
    expect(dayDir).toHaveLength(1);
  });

  it("skips sessions that already exist so re-import is idempotent", async () => {
    const home = await seedHome();
    const { zip } = await buildSessionsArchive(home);
    const target = await mkdtemp(join(tmpdir(), "cm-target-"));
    await extractSessionsArchive(zip, target);
    const second = await extractSessionsArchive(zip, target);
    expect(second).toEqual({ imported: 0, skipped: 2 });
  });

  it("reports zero sessions when the codex home has none", async () => {
    const empty = await mkdtemp(join(tmpdir(), "cm-empty-"));
    const { zip, count } = await buildSessionsArchive(empty);
    expect(count).toBe(0);
    expect(zip.byteLength).toBe(0);
  });
});
