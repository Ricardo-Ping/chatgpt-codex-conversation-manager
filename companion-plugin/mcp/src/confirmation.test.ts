import { describe, expect, it } from "vitest";
import { ConfirmationStore } from "./confirmation.js";

describe("ConfirmationStore", () => {
  it("binds a one-time token to action, IDs, fingerprint and expiry", () => {
    let now = 1_000;
    const store = new ConfirmationStore<"delete" | "archive">(() => now);
    const token = store.issue("delete", ["b", "a", "a"], "v1");
    expect(store.consume(token, "delete", ["a", "b"])).toEqual({ fingerprint: "v1" });
    expect(() => store.consume(token, "delete", ["a", "b"])).toThrow();
    const expired = store.issue("archive", ["a"], "v2");
    now += 120_001;
    expect(() => store.consume(expired, "archive", ["a"])).toThrow();
  });
});
