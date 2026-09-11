import { describe, expect, it } from "vitest";
import { bulkSelectableIds, cutoffFor, dedupeById, filterConversations, isValidVersionFormat, type ManagedConversation } from "./index.js";

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
  capabilities: ["open", "archive"]
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

describe("dedupeById", () => {
  it("keeps the last value for a duplicate id, at the position of its first occurrence", () => {
    const result = dedupeById([
      { id: "b", tag: "first-b" },
      { id: "a", tag: "only-a" },
      { id: "b", tag: "second-b" }
    ] as Array<{ id: string; tag: string }>);
    expect(result).toEqual([
      { id: "b", tag: "second-b" },
      { id: "a", tag: "only-a" }
    ]);
  });
});

describe("isValidVersionFormat", () => {
  it("accepts loose dotted numeric versions", () => {
    expect(isValidVersionFormat("0.7.1")).toBe(true);
    expect(isValidVersionFormat("1")).toBe(true);
    expect(isValidVersionFormat("1.2.3.4")).toBe(true);
  });
  it("rejects non-strings and non-numeric leading content", () => {
    expect(isValidVersionFormat(7)).toBe(false);
    expect(isValidVersionFormat("v1.2.3")).toBe(false);
    expect(isValidVersionFormat("alpha")).toBe(false);
    expect(isValidVersionFormat("")).toBe(false);
  });
  it("deliberately does not anchor the tail (legacy lenient behavior)", () => {
    expect(isValidVersionFormat("1.2.3.4.5")).toBe(true);
    expect(isValidVersionFormat("1abc")).toBe(true);
  });
});
