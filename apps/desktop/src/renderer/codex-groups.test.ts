import { describe, expect, it } from "vitest";
import type { ManagedConversation } from "@conversation-manager/conversation-domain";
import { groupChatGptConversations, groupCodexConversations, isProjectTask } from "./codex-groups.js";

const row = (id: string, cwd?: string, projectId?: string): ManagedConversation => ({ source: "codex", id, title: id, createdAt: null, updatedAt: null, state: "active", cwd, projectId, pinned: false, running: false, current: false, capabilities: ["open"] });
const chatRow = (id: string, projectId?: string): ManagedConversation => ({ source: "chatgpt", id, title: id, createdAt: null, updatedAt: null, state: "active", projectId, pinned: false, running: false, current: false, capabilities: ["open", "archive", "delete"] });

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

  it("pins the non-project group above all project groups", () => {
    const scratch = "C:\\Users\\me\\Documents\\Codex\\2026-09-03\\qin";
    const groups = groupCodexConversations([row("a", "X:\\work\\alpha"), row("s", scratch), row("b", "X:\\work\\beta")]);
    expect(groups.map((group) => group.name)).toEqual(["非项目任务", "alpha", "beta"]);
  });

  it("prefers projectId over cwd when grouping", () => {
    const groups = groupCodexConversations([row("p1", "X:\\work\\alpha", "proj-1"), row("p2", "X:\\other\\beta", "proj-1")]);
    expect(groups).toHaveLength(1);
    expect(groups.map((group) => group.records.map((item) => item.id))).toEqual([["p1", "p2"]]);
  });

  it("moves excluded folder-grouped tasks into the non-project group", () => {
    const groups = groupCodexConversations([row("a", "X:\\work\\alpha"), row("b", "X:\\work\\beta")], new Set(["a"]));
    expect(groups.map((group) => [group.name, group.records.map((item) => item.id)])).toEqual([["非项目任务", ["a"]], ["beta", ["b"]]]);
    expect(isProjectTask(row("a", "X:\\work\\alpha"), new Set(["a"]))).toBe(false);
    expect(isProjectTask(row("p", "X:\\work\\alpha", "proj-1"), new Set(["p"]))).toBe(true);
  });
});

describe("groupChatGptConversations", () => {
  it("groups work records by project id and prefers known names", () => {
    const records = [chatRow("a", "g-p-1"), chatRow("b", "g-p-1"), chatRow("c", "g-p-2")];
    const groups = groupChatGptConversations(records, { "g-p-1": "调研" });
    expect(groups?.map((group) => [group.name, group.records.map((item) => item.id)])).toEqual([["调研", ["a", "b"]], ["g-p-2", ["c"]]]);
  });

  it("still groups when project names are missing, and returns null without project ids", () => {
    const records = [chatRow("a", "g-p-1"), chatRow("b", "g-p-2")];
    expect(groupChatGptConversations(records, undefined)?.map((group) => group.name)).toEqual(["g-p-1", "g-p-2"]);
    expect(groupChatGptConversations([chatRow("plain")], { "g-p-1": "X" })).toBeNull();
  });
});
