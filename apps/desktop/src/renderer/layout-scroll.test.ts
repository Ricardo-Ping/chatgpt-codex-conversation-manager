/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("conversation list layout", () => {
  it("allows every flex ancestor to shrink so the list owns vertical scrolling", async () => {
    const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.content\s*\{[^}]*min-height:\s*0[^}]*\}/);
    expect(css).toMatch(/\.workspace-main\s*\{[^}]*min-height:\s*0[^}]*\}/);
    expect(css).toMatch(/\.list\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto[^}]*\}/);
  });
});
