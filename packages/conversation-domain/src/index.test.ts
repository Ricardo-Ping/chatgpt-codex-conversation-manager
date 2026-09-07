import { describe, expect, it } from "vitest";
import { bulkSelectableIds, cutoffFor, filterConversations, type ManagedConversation } from "./index.js";

const base: ManagedConversation = {
  source: "codex",
  id: "1",
  title: "Old task",
  createdAt: 1,
  updatedAt: Date.UTC(2025, 0, 1),
  state: "active",
  pinned: false,
  running: false,
  current: false,
  capabilities: ["read", "archive"]
};

describe("conversation domain", () => {
  it("uses calendar months for month filters", () => {
    expect(cutoffFor("month", new Date(2026, 2, 31, 12).getTime())).toBe(new Date(2026, 1, 28, 12).getTime());
  });

  it("filters by state, title and age", () => {
    const result = filterConversations([base], {
      state: "active",
      query: "old",
      age: "halfYear",
      now: Date.UTC(2026, 0, 2)
    });
    expect(result).toEqual([base]);
  });

  it("protects pinned, current and running records from bulk selection", () => {
    expect(bulkSelectableIds([
      base,
      { ...base, id: "2", pinned: true },
      { ...base, id: "3", current: true },
      { ...base, id: "4", running: true }
    ])).toEqual(["1"]);
  });
});
