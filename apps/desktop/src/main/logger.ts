import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_LOG_BYTES = 1_000_000;
const READ_TAIL_LINES = 400;
let logFile: string | null = null;
let queue: Promise<void> = Promise.resolve();
const listeners = new Set<(line: string) => void>();

export function initLogger(userDataDirectory: string): void {
  const directory = join(userDataDirectory, "logs");
  logFile = join(directory, "main.log");
  void mkdir(directory, { recursive: true });
}

export function onLogLine(listener: (line: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function readLogs(tailLines = READ_TAIL_LINES): Promise<string> {
  if (!logFile) return "";
  try {
    const content = await readFile(logFile, "utf8");
    const rows = content.split("\n");
    return tailLines >= rows.length ? content : rows.slice(-tailLines).join("\n");
  } catch { return ""; }
}

export async function clearLogs(): Promise<void> {
  if (!logFile) return;
  try { await writeFile(logFile, "", "utf8"); } catch {}
}

async function append(level: "info" | "warn" | "error", message: string): Promise<void> {
  if (!logFile) return;
  const file = logFile;
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  try {
    const info = await stat(file);
    if (info.size > MAX_LOG_BYTES) await rename(file, file.replace(/\.log$/, ".old.log"));
  } catch {}
  await appendFile(file, `${line}\n`, "utf8");
  for (const listener of listeners) { try { listener(line); } catch {} }
}

export function writeLog(level: "info" | "warn" | "error", message: string): void {
  queue = queue.then(() => append(level, message)).catch(() => {});
}
export const logInfo = (message: string): void => writeLog("info", message);
export const logWarn = (message: string): void => writeLog("warn", message);
export const logError = (message: string): void => writeLog("error", message);
export async function saveLogsTo(targetPath: string): Promise<void> {
  const content = await readLogs(Number.MAX_SAFE_INTEGER);
  await writeFile(targetPath, content, "utf8");
}
