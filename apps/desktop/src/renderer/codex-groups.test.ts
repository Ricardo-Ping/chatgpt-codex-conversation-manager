import { describe, expect, it } from "vitest";
import type { ManagedConversation } from "@conversation-manager/conversation-domain";
import { groupCodexConversations, isProjectTask } from "./codex-groups.js";

const row = (id: string, cwd?: string, projectId?: string): ManagedConversation => ({ source: "codex", id, title: id, createdAt: null, updatedAt: null, state: "active", cwd, projectId, pinned: false, running: false, current: false, capabilities: ["open"] });

describe("groupCodexConversations", () => {
  it("groups tasks by working directory and keeps unassigned tasks separate", () => {
    const groups = groupCodexConversations([row("a", "X:\\work\\alpha"), row("b", "x:\\WORK\\alpha\\")]);
    expect(groups.map((group) => [group.name, group.records.map((item) => item.id)])).toEqual([["alpha", ["a", "b"]]]);
  });

  it("treats Codex desktop scratch directories as non-project tasks", () => {
    const scratch = "C:\\Users\\me\\Documents\\Codex\\2026-09-03\\qin";
    expect(isProjectTask(row("s", scratch))).toBe(false);
    const groups = groupCodexConversations([row("s1", scratch), row("s2", "C:\\Users\\me\\Documents\\Codex\\2026-09-02\\zhe-g"), row("real", "E:\\自建Skill库\\chatgpt对话插件")]);
    expect(groups.map((group) => [group.name, group.records.map((item) => item.id)])).toEqual([["非项目任务", ["s1", "s2"]], ["chatgpt对话插件", ["real"]]]);
  });

  it("prefers projectId over cwd when grouping", () => {
    const groups = groupCodexConversations([row("p1", "X:\\work\\alpha", "proj-1"), row("p2", "X:\\other\\beta", "proj-1")]);
    expect(groups).toHaveLength(1);
    expect(groups.map((group) => group.records.map((item) => item.id))).toEqual([["p1", "p2"]]);
  });
});
