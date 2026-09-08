import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_LOG_BYTES = 1_000_000;
let logFile: string | null = null;
let queue: Promise<void> = Promise.resolve();

export function initLogger(userDataDirectory: string): void {
  const directory = join(userDataDirectory, "logs");
  logFile = join(directory, "main.log");
  void mkdir(directory, { recursive: true });
}

async function append(level: "info" | "warn" | "error", message: string): Promise<void> {
  if (!logFile) return;
  const file = logFile;
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try {
    const info = await stat(file);
    if (info.size > MAX_LOG_BYTES) await rename(file, file.replace(/\.log$/, ".old.log"));
  } catch {}
  await appendFile(file, line, "utf8");
}

export function writeLog(level: "info" | "warn" | "error", message: string): void {
  queue = queue.then(() => append(level, message)).catch(() => {});
}
export const logInfo = (message: string): void => writeLog("info", message);
export const logWarn = (message: string): void => writeLog("warn", message);
export const logError = (message: string): void => writeLog("error", message);
