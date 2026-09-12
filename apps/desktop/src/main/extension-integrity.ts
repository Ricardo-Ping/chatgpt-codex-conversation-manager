import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNewerVersion } from "./mac-updater.js";

export const EXTENSION_CODE_FILES = ["background.js", "bridge-core.js", "content.js"] as const;

/** 计算磁盘上扩展代码的指纹：sha256(sha256(f1) ‖ sha256(f2) ‖ sha256(f3)) 的 base64url。
 * 与扩展端 background.js#extensionCodeHash 同源——扩展对同样三个文件做同样的双重哈希。
 * 由于扩展只在 Service Worker 启动时读取磁盘，"SW 上报的指纹 ≠ 当前磁盘指纹"
 * 即意味着运行中的代码落后于磁盘文件（自愈已写入新代码但 SW 未重启）。 */
export async function extensionCodeHash(directory: string, files: readonly string[] = EXTENSION_CODE_FILES): Promise<string | null> {
  try {
    const digests: Buffer[] = [];
    for (const file of files) digests.push(createHash("sha256").update(await readFile(join(directory, file))).digest());
    return createHash("sha256").update(Buffer.concat(digests)).digest("base64url");
  } catch { return null; }
}

export type ExtensionStaleness =
  | "fresh"
  | "stale-hash"
  | "stale-version"
  | "unknown-legacy"
  | "unknown";

/** 判定浏览器里运行的扩展是否为"桌面端无法自动升级的旧代码"。
 * - stale-hash：SW 上报了启动指纹且与当前磁盘不一致——文件已被更新但 SW 未重启，自动重载未生效
 * - stale-version：上报版本落后于期望版本——常规自动重载本应处理；仍落后说明重载通道失效
 * - unknown-legacy：SW 从未上报指纹（旧到没有该功能）。不能证明陈旧，但这类 SW 恰恰缺少
 *   全部自我防护（请求限时/硬重载识别），同步失败时应优先提示重载
 * - unknown：无法判定（扩展未连接过、磁盘文件不可读、SW 声明哈希计算失败等） */
export function classifyExtensionStaleness(input: {
  expectedVersion: string | null;
  reportedVersion: string | null;
  reportedCodeHash: string | null;
  expectedCodeHash: string | null;
}): ExtensionStaleness {
  const reportedHash = input.reportedCodeHash === HASH_UNAVAILABLE ? null : input.reportedCodeHash;
  if (input.expectedCodeHash && reportedHash) return input.expectedCodeHash === reportedHash ? "fresh" : "stale-hash";
  if (input.expectedVersion && input.reportedVersion && isNewerVersion(input.expectedVersion, input.reportedVersion)) return "stale-version";
  // 指纹头是新版本扩展必然携带的功能标记：从未上报过即说明 SW 旧到没有该功能
  if (!input.reportedCodeHash) return "unknown-legacy";
  return "unknown";
}

/** 扩展端三个代码文件里读不到任何一个时上报的占位值：具备上报能力但无法计算。 */
export const HASH_UNAVAILABLE = "hash-unavailable";

/** 是否应当向用户明确提示"重新加载扩展"。unknown-legacy 只在桥接命令超时这种
 * 实证故障场景下提示（见 main.ts 的 bridgeRequest 包装），不单独作为判定依据。 */
export function shouldDemandReload(staleness: ExtensionStaleness): boolean {
  return staleness === "stale-hash" || staleness === "stale-version" || staleness === "unknown-legacy";
}
