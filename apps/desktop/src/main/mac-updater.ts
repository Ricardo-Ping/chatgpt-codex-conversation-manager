import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";

export const MAC_RELEASES_API = "https://api.github.com/repos/Ricardo-Ping/chatgpt-codex-conversation-manager/releases/latest";
const REQUEST_HEADERS: Record<string, string> = { "User-Agent": "conversation-manager-updater", Accept: "application/vnd.github+json" };
const MAX_REDIRECTS = 8;
const ARCHIVE_PREFIX = ".cm-update-";
const BACKUP_PREFIX = ".cm-backup-";

export interface MacReleaseAsset { name: string; url: string; size: number }
export interface MacUpdateCheck { version: string; archive: MacReleaseAsset; checksumUrl: string | null }

export function isNewerVersion(candidate: string, current: string): boolean {
  const numbers = (value: string) => value.trim().replace(/^v/i, "").split("-")[0]?.split(".").map((part) => { const parsed = Number.parseInt(part, 10); return Number.isFinite(parsed) ? parsed : 0; }) ?? [];
  const left = numbers(candidate); const right = numbers(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export function macAppBundlePath(exePath: string): string | null {
  const marker = exePath.indexOf(".app/");
  return marker === -1 ? null : exePath.slice(0, marker + ".app".length);
}

export function findMacZipAsset(assets: unknown, version: string): MacReleaseAsset | null {
  const rows = Array.isArray(assets) ? assets : [];
  for (const row of rows) {
    const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
    if (typeof item.name !== "string" || typeof item.browser_download_url !== "string") continue;
    if (item.name !== `Conversation-Manager-${version}-mac-arm64.zip`) continue;
    return { name: item.name, url: item.browser_download_url, size: typeof item.size === "number" && item.size > 0 ? item.size : 0 };
  }
  return null;
}

export function findChecksumAsset(assets: unknown): MacReleaseAsset | null {
  const rows = Array.isArray(assets) ? assets : [];
  for (const row of rows) {
    const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
    if (item.name === "SHA256SUMS.txt" && typeof item.browser_download_url === "string") return { name: "SHA256SUMS.txt", url: item.browser_download_url, size: 0 };
  }
  return null;
}

export function extractChecksum(sums: string, fileName: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/);
    if (match?.[1] && match[2] === fileName) return match[1];
  }
  return null;
}

function httpRequest(url: string): Promise<import("node:http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { headers: REQUEST_HEADERS }, (response) => resolve(response));
    request.on("error", reject);
    request.end();
  });
}

async function downloadBody(url: string, destination: string | null, onProgress?: (percent: number) => void): Promise<string> {
  let current = url;
  for (let redirects = 0; redirects < MAX_REDIRECTS; redirects += 1) {
    const response = await httpRequest(current);
    const location = response.headers.location;
    if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && typeof location === "string") { response.resume(); current = new URL(location, current).toString(); continue; }
    if (response.statusCode !== 200) { response.resume(); throw new Error(`Download failed with HTTP ${response.statusCode}`); }
    const total = Number(response.headers["content-length"] ?? 0);
    const hash = createHash("sha256");
    let received = 0; let reported = 0;
    await new Promise<void>((resolve, reject) => {
      response.on("data", (chunk: Buffer) => {
        hash.update(chunk); received += chunk.length;
        if (onProgress && total > 0) { const percent = Math.min(99, Math.floor((received / total) * 100)); if (percent > reported) { reported = percent; onProgress(percent); } }
      });
      response.on("error", reject);
      const output = destination ? createWriteStream(destination) : null;
      output?.on("error", reject);
      output?.on("finish", () => resolve());
      response.on("end", () => { if (output) output.end(); else resolve(); });
      if (output) response.pipe(output); else response.resume();
    });
    return hash.digest("hex");
  }
  throw new Error("Download failed: too many redirects");
}

export async function fetchMacRelease(currentVersion: string): Promise<MacUpdateCheck | null> {
  const chunks: Buffer[] = [];
  const response = await httpRequest(MAC_RELEASES_API);
  if (response.statusCode !== 200) { response.resume(); throw new Error(`Release check failed with HTTP ${response.statusCode}`); }
  for await (const chunk of response) chunks.push(chunk as Buffer);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { draft?: unknown; prerelease?: unknown; tag_name?: unknown; assets?: unknown };
  if (payload.draft === true || payload.prerelease === true) return null;
  const tag = typeof payload.tag_name === "string" ? payload.tag_name : "";
  if (!tag || !isNewerVersion(tag, currentVersion)) return null;
  const version = tag.replace(/^v/i, "");
  const archive = findMacZipAsset(payload.assets, version);
  if (!archive) return null;
  const checksum = findChecksumAsset(payload.assets);
  return { version, archive, checksumUrl: checksum?.url ?? null };
}

export async function downloadMacArchive(release: MacUpdateCheck, destinationDir: string, onProgress?: (percent: number) => void): Promise<string> {
  await mkdir(destinationDir, { recursive: true });
  const destination = join(destinationDir, release.archive.name);
  const hash = await downloadBody(release.archive.url, destination, onProgress);
  if (release.checksumUrl) {
    const sums = await downloadBody(release.checksumUrl, null);
    const expected = extractChecksum(sums, release.archive.name);
    if (expected && expected !== hash) { await rm(destination, { force: true }); throw new Error("Update archive checksum mismatch"); }
  }
  return destination;
}

function extractZipArchive(archivePath: string, stagingDir: string): Promise<void> {
  return new Promise((resolve, reject) => execFile("ditto", ["-x", "-k", archivePath, stagingDir], {}, (error) => error ? reject(error) : resolve()));
}

// 就地换包：新 .app 解压到应用所在目录（同卷保证 rename 原子）；
// 运行中的旧 bundle 改名为备份（进程靠已打开的文件句柄继续运行），
// 新 bundle 原子移入原路径，调用方随后 app.relaunch() + quit 重启为新版本。
// 失败时立即恢复备份；备份由下次启动时的 cleanupMacInstallLeftovers 清理。
export async function swapMacBundle(archivePath: string, bundlePath: string): Promise<void> {
  const parent = dirname(bundlePath);
  const stamp = Date.now();
  const stagingDir = join(parent, `${ARCHIVE_PREFIX}${stamp}`);
  const backupPath = join(parent, `${BACKUP_PREFIX}${stamp}`);
  await mkdir(stagingDir, { recursive: true });
  try {
    await extractZipArchive(archivePath, stagingDir);
  } catch (error) { await rm(stagingDir, { recursive: true, force: true }); throw error; }
  const appName = (await readdir(stagingDir)).find((entry) => entry.endsWith(".app"));
  if (!appName) { await rm(stagingDir, { recursive: true, force: true }); throw new Error("Update archive did not contain an .app bundle"); }
  await rm(backupPath, { recursive: true, force: true });
  await rename(bundlePath, backupPath);
  try {
    await rename(join(stagingDir, appName), bundlePath);
  } catch (error) {
    await rename(backupPath, bundlePath).catch(() => {});
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function cleanupMacInstallLeftovers(bundlePath: string): Promise<void> {
  const parent = dirname(bundlePath);
  let entries: string[];
  try { entries = await readdir(parent); } catch { return; }
  await Promise.all(entries.filter((entry) => entry.startsWith(ARCHIVE_PREFIX) || entry.startsWith(BACKUP_PREFIX)).map((entry) => rm(join(parent, entry), { recursive: true, force: true }).catch(() => {})));
}
