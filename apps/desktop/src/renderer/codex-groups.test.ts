import { describe, expect, it } from "vitest";
import type { ManagedConversation } from "@conversation-manager/conversation-domain";
import { groupCodexConversations } from "./codex-groups.js";

const row = (id: string, cwd?: string): ManagedConversation => ({ source: "codex", id, title: id, createdAt: null, updatedAt: null, state: "active", cwd, pinned: false, running: false, current: false, capabilities: ["open"] });

describe("groupCodexConversations", () => {
  it("groups tasks by working directory and keeps unassigned tasks separate", () => {
    const groups = groupCodexConversations([row("a", "X:\\work\\alpha"), row("b", "x:\\WORK\\alpha\\"), row("c")]);
    expect(groups.map((group) => [group.name, group.records.map((item) => item.id)])).toEqual([["alpha", ["a", "b"]], ["非项目任务", ["c"]]]);
  });
});
