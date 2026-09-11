import { describe, expect, it } from "vitest";
import { applyImageRewrites, chatGptImageDir, chatgptTranscriptMarkdown, codexMetadataMarkdown, codexTranscriptMarkdown, codexTurnsFromPayload, extractChatGptImageUrls, safeFileName } from "./export.js";

const thread = (overrides: Partial<{ name: string | null; preview: string | null; cwd: string | null }> = {}): { id: string; name: string | null; preview: string | null; cwd: string | null } => ({ id: "thread-12345678", preview: "任务摘要", name: null, cwd: null, ...overrides });

describe("safeFileName", () => {
  it("strips illegal characters and appends an id suffix", () => {
    expect(safeFileName('整理: SQL*查询"重写?', "thread-1234567890")).toBe("整理 SQL 查询 重写-thread-1.md");
  });
  it("falls back when the title is empty", () => {
    expect(safeFileName("   ", "abcdefghij")).toBe("未命名会话-abcdefgh.md");
  });
});

describe("extractChatGptImageUrls", () => {
  it("extracts unique http(s) image urls and skips other schemes", () => {
    const markdown = "![](https://a/x.png)\n![b](https://a/x.png)\n![c](http://b/y.jpeg) ![x](ftp://z/e.png)";
    expect(extractChatGptImageUrls(markdown)).toEqual(["https://a/x.png", "http://b/y.jpeg"]);
  });
  it("returns empty for markdown without images", () => {
    expect(extractChatGptImageUrls("no images here")).toEqual([]);
  });
});

describe("chatGptImageDir", () => {
  it("derives a unique space-free directory per conversation", () => {
    const a = chatGptImageDir("我的 会话: 标题?", "6a6df091-7d58-83ea-a7bb-d5e0d7b3af18");
    const b = chatGptImageDir("我的 会话: 标题?", "ffffffff-1111-2222-3333-444444444444");
    expect(a).toBe("我的-会话-标题-6a6df091");
    expect(b).toBe("我的-会话-标题-ffffffff");
    expect(a).not.toMatch(/\s/);
  });
});

describe("applyImageRewrites", () => {
  it("rewrites every occurrence of downloaded urls and leaves others untouched", () => {
    const markdown = "![](https://a/x.png) text ![again](https://a/x.png) keep ![r](https://b/y.webp)";
    expect(applyImageRewrites(markdown, [["https://a/x.png", "images/s1/img-1.png"]]))
      .toBe("![](images/s1/img-1.png) text ![again](images/s1/img-1.png) keep ![r](https://b/y.webp)");
  });
});

describe("chatgptTranscriptMarkdown", () => {
  it("renders role headings and message bodies", () => {
    const exportedAt = Date.parse("2026-09-09T10:00:00Z");
    const markdown = chatgptTranscriptMarkdown({ id: "conv-1", title: "调研会话", messages: [
      { role: "user", at: Date.parse("2026-09-09T09:00:00Z"), text: "第一问" },
      { role: "assistant", at: null, text: "第一答" }
    ] }, exportedAt, "工作账号");
    expect(markdown).toContain("# 调研会话");
    expect(markdown).toContain("- 来源: ChatGPT（工作账号）");
    expect(markdown).toContain("## 用户 ·");
    expect(markdown).toContain("第一问");
    expect(markdown).toContain("## 助手 ·");
    expect(markdown).toContain("第一答");
    expect(markdown).toContain("消息数: 2");
  });
  it("renders english labels when requested", () => {
    const markdown = chatgptTranscriptMarkdown({ id: "conv-1", title: "Research", messages: [
      { role: "user", at: null, text: "q" },
      { role: "assistant", at: null, text: "a" }
    ] }, 0, "Work", "en");
    expect(markdown).toContain("# Research");
    expect(markdown).toContain("- Source: ChatGPT（Work）");
    expect(markdown).toContain("## User ·");
    expect(markdown).toContain("## Assistant ·");
  });
  it("notes empty transcripts", () => {
    const markdown = chatgptTranscriptMarkdown({ id: "conv-2", title: "空会话", messages: [] }, 0, "账号");
    expect(markdown).toContain("没有可导出的消息内容");
  });
});

describe("codexTranscriptMarkdown", () => {
  it("extracts user and assistant text from turns and skips empty items", () => {
    const turns = codexTurnsFromPayload({ thread: { turns: [
      { items: [{ type: "userMessage", text: "请分析" }, { type: "reasoning", text: "思路..." }] },
      { items: [{ type: "agentMessage", text: "分析结果" }, { type: "system", text: "" }] }
    ] } });
    const markdown = codexTranscriptMarkdown(thread({ name: "分析任务", cwd: "C:\\work" }), turns, 0);
    expect(markdown).toContain("# 分析任务");
    expect(markdown).toContain("## 用户");
    expect(markdown).toContain("请分析");
    expect(markdown).toContain("### 思考");
    expect(markdown).toContain("## 助手");
    expect(markdown).toContain("分析结果");
    expect(markdown).toContain("工作目录: C:\\work");
  });

  it("explains when the server returned no turns", () => {
    const markdown = codexTranscriptMarkdown(thread({ name: "任务" }), [], 0);
    expect(markdown).toContain("任务摘要");
  });
});

describe("codexMetadataMarkdown", () => {
  it("records the failure reason", () => {
    const markdown = codexMetadataMarkdown(thread({ name: "任务", preview: "摘要文本" }), "thread/read 不受支持", 0);
    expect(markdown).toContain("未返回该任务的正文内容: thread/read 不受支持");
    expect(markdown).toContain("## 摘要");
    expect(markdown).toContain("摘要文本");
  });
});
