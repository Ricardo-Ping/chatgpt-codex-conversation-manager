import type { SpawnOptions } from "node:child_process";

export interface TerminalSpawn {
  file: string;
  args: string[];
  options: SpawnOptions;
}

// `codex resume` is an interactive TUI and needs a visible terminal. A direct
// detached spawn cannot provide one: on Windows DETACHED_PROCESS starts the
// child without a console and powershell.exe then exits silently without
// running its command, and a macOS GUI app has no terminal to attach to at
// all. So hand the command to a launcher that opens a real terminal window:
// Start-Process on Windows, Terminal.app via AppleScript on macOS.
export function terminalResumeSpawn(command: string, id: string, platform: NodeJS.Platform = process.platform): TerminalSpawn {
  if (platform === "win32") {
    const script = `Start-Process -FilePath '${command.replaceAll("'", "''")}' -ArgumentList @('resume','${id}')`;
    return { file: "powershell.exe", args: ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], options: { stdio: "ignore", windowsHide: true } };
  }
  if (platform === "darwin") {
    const line = `'${command.replaceAll("'", `'\\''`)}' resume '${id}'`;
    const script = `tell application "Terminal" to do script "${line.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    return { file: "osascript", args: ["-e", script], options: { detached: true, stdio: "ignore" } };
  }
  return { file: command, args: ["resume", id], options: { detached: true, stdio: "ignore" } };
}
