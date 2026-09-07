import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexAppServer } from "./index.js";

function fakeProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill(): boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

describe("CodexAppServer", () => {
  it("initializes and correlates newline-delimited responses", async () => {
    const child = fakeProcess();
    const writes: string[] = [];
    child.stdin.on("data", (chunk) => {
      const line = String(chunk);
      writes.push(line);
      const request = JSON.parse(line) as { id?: number; method: string };
      if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "test" } })}\n`);
      if (request.method === "thread/list") child.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`);
    });

    const server = new CodexAppServer("codex", () => child as never);
    const result = await server.list();
    expect(result.data).toEqual([]);
    expect(writes.map((line) => JSON.parse(line).method)).toEqual(["initialize", "initialized", "thread/list"]);
    server.close();
  });

  it("waits for initialization before concurrent thread requests", async () => {
    const child = fakeProcess();
    const methods: string[] = [];
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(String(chunk)) as { id?: number; method: string };
      methods.push(request.method);
      if (request.method === "initialize") setTimeout(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`), 5);
      if (request.method === "thread/list") child.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`);
    });
    const server = new CodexAppServer("codex", () => child as never);
    await Promise.all([server.list(), server.list()]);
    expect(methods).toEqual(["initialize", "initialized", "thread/list", "thread/list"]);
    server.close();
  });
});
