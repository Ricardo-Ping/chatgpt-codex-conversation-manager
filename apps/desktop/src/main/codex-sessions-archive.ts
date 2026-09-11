import { zipSync, unzipSync } from "fflate";
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, posix } from "node:path";

// Codex 会话本体是 ~/.codex/sessions 下的 rollout-*.jsonl 存档（归档会话在
// archived_sessions）。把这两个目录按原相对路径打进 zip，另一台电脑导入回
// 同一位置后，codex resume / 会话列表即可识别这些会话。凭据（auth.json）与
// 配置（config.toml）刻意不参与导出。
const SESSION_DIRS = ["sessions", "archived_sessions"];
const ENTRY_PATTERN = /^[\w.-]+(?:\/[\w.-]+)*$/;

export interface SessionsArchiveResult {
  count: number;
  bytes: number;
  file?: string;
}

async function collectFiles(root: string, relative: string, out: string[]): Promise<void> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = posix.join(relative, entry.name);
    if (entry.isDirectory()) await collectFiles(root, child, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(child);
  }
}

/** 相对路径白名单校验：仅接受 sessions/ 或 archived_sessions/ 下的普通 jsonl 相对路径，拒绝绝对路径与 .. 穿越。 */
export function safeArchiveEntry(name: string): string | null {
  const normalized = posix.normalize(name.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!SESSION_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))) return null;
  if (!normalized.endsWith(".jsonl") || !ENTRY_PATTERN.test(normalized) || normalized.includes("..")) return null;
  return normalized;
}

export async function buildSessionsArchive(codexHome: string): Promise<{ zip: Uint8Array; count: number; bytes: number }> {
  const files: string[] = [];
  for (const dir of SESSION_DIRS) {
    const root = join(codexHome, dir);
    if (existsSync(root)) await collectFiles(codexHome, dir, files);
  }
  if (!files.length) return { zip: new Uint8Array(), count: 0, bytes: 0 };
  const payload: Record<string, Uint8Array> = {};
  let bytes = 0;
  for (const relative of files.sort()) {
    const content = await readFile(join(codexHome, relative));
    bytes += content.byteLength;
    payload[relative] = new Uint8Array(content);
  }
  return { zip: zipSync(payload, { level: 6 }), count: files.length, bytes };
}

export async function extractSessionsArchive(zip: Uint8Array, codexHome: string): Promise<{ imported: number; skipped: number }> {
  const entries = unzipSync(zip);
  // 已存在的同名 rollout 视为同一会话，跳过以保证重复导入幂等
  const existing = new Set<string>();
  for (const dir of SESSION_DIRS) {
    const root = join(codexHome, dir);
    if (!existsSync(root)) continue;
    const seen: string[] = [];
    await collectFiles(codexHome, dir, seen);
    for (const relative of seen) existing.add(relative);
  }
  let imported = 0;
  let skipped = 0;
  for (const [name, content] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const relative = safeArchiveEntry(name);
    if (!relative) continue;
    if (existing.has(relative)) { skipped += 1; continue; }
    const target = join(codexHome, relative);
    if (!target.startsWith(join(codexHome) + "\\") && !target.startsWith(join(codexHome) + "/")) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    imported += 1;
  }
  return { imported, skipped };
}

export async function sessionsArchiveSize(codexHome: string): Promise<number> {
  let total = 0;
  for (const dir of SESSION_DIRS) {
    const root = join(codexHome, dir);
    if (!existsSync(root)) continue;
    const files: string[] = [];
    await collectFiles(codexHome, dir, files);
    for (const relative of files) total += (await stat(join(codexHome, relative))).size;
  }
  return total;
}
