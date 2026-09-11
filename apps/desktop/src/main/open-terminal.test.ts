import { describe, expect, it } from "vitest";
import { terminalResumeSpawn } from "./open-terminal.js";

function decodedScript(result: { file: string; args: string[] }): string {
  expect(result.file).toBe("powershell.exe");
  expect(result.args[0]).toBe("-NoProfile");
  expect(result.args[1]).toBe("-EncodedCommand");
  return Buffer.from(result.args[2]!, "base64").toString("utf16le");
}

describe("terminalResumeSpawn", () => {
  it("launches a visible console via Start-Process on Windows", () => {
    const result = terminalResumeSpawn("C:\\Tools\\codex.exe", "6a6df091-7d58-83ea-a7bb-d5e0d7b3af18", "win32");
    expect(decodedScript(result)).toBe("Start-Process -FilePath 'C:\\Tools\\codex.exe' -ArgumentList @('resume','6a6df091-7d58-83ea-a7bb-d5e0d7b3af18')");
    expect(result.options.windowsHide).toBe(true);
    expect(result.options.detached).toBeUndefined();
  });

  it("escapes apostrophes in the command path for PowerShell", () => {
    expect(decodedScript(terminalResumeSpawn("C:\\My Tools\\bob's codex.exe", "0123456789abcdef", "win32")))
      .toBe("Start-Process -FilePath 'C:\\My Tools\\bob''s codex.exe' -ArgumentList @('resume','0123456789abcdef')");
  });

  it("opens Terminal.app via AppleScript on macOS", () => {
    const result = terminalResumeSpawn("/opt/homebrew/bin/codex", "0123456789abcdef", "darwin");
    expect(result.file).toBe("osascript");
    expect(result.args[0]).toBe("-e");
    expect(result.args[1]).toBe(`tell application "Terminal" to do script "'/opt/homebrew/bin/codex' resume '0123456789abcdef'"`);
  });

  it("spawns codex directly on Linux", () => {
    const result = terminalResumeSpawn("/usr/local/bin/codex", "0123456789abcdef", "linux");
    expect(result).toEqual({ file: "/usr/local/bin/codex", args: ["resume", "0123456789abcdef"], options: { detached: true, stdio: "ignore" } });
  });
});
